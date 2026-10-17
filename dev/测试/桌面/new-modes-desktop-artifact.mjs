#!/usr/bin/env node

/**
 * Actual Desktop rc.2 acceptance probe for the two native shell modes.
 *
 * This file is deliberately independent from the older tools-only Desktop
 * probe.  It starts the installed Desktop runtime in Node mode (no window and
 * no model request), installs a caller-supplied TGZ into an owned temporary
 * profile, and exercises the official profile loader, preset registry, agent
 * factory, prompt service, terminal service, and plugin fiber lifecycle.
 *
 * Run with Windows Node:
 *   node dev/测试/桌面/new-modes-desktop-artifact.mjs --tgz <absolute-tgz>
 *
 * Temporary profiles, logs and JSON evidence stay below 测试/运行产物.  The
 * parent never sends stdin to a child and routes child stdout/stderr to owned
 * files, so a short-lived caller pipe cannot turn into an EPIPE in the real
 * Desktop host.
 */

import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { delimiter, dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";

const ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const TEST_ROOT = join(ROOT, "测试");
const RUN_ROOT = join(TEST_ROOT, "运行产物");
const EXPECTED_DESKTOP_VERSION = "0.2.1-rc.2";
const EXPECTED_PLUGIN_VERSION = "0.2.1";
const EXPECTED_MODE_IDS = ["bash-wsl", "bash-git-bash"];
const EXPECTED_MODE_NAMES = {
  "bash-wsl": "WSL 模式",
  "bash-git-bash": "Git Bash 模式",
};
const OLD_CANONICAL_TGZ_SHA256 =
  "9cb01907dd7a9558255b6b8d5fe5ef03349927711fef0aadf9456656fe2b6f63";
const EXPECTED_ASAR_SHA256 =
  "47874618bf5b3011fcaac10cd4c85f69da333e70d4f99b921207c78d0999512a";
const EXPECTED_EXE_SHA256 =
  "9c789407850773ce7d914a3ec0476852bf1ceea69789d8ccf4e39be953f4bf52";
const MAX_LOG_CHARS = 16 * 1024;
const CHILD_TIMEOUT_MS = 180_000;
const INSTALL_TIMEOUT_MS = 180_000;
const TEST_PERSISTENT_TIMEOUT_MS = 10_000;
const PROMPT_SECTION = "dsh-plugin-bash-wsl:usage";
const PLUGIN_ROW_NAME = "dsh-plugin-bash-wsl";
const PERSISTENT_ROW_NAME = "dsh-plugin-bash-wsl/persistent";
const STOCK_BASH_ROW = "@deepseek-ai/dsh-tool-bash";

let checkDiagnosticPath;
let checkDiagnosticReplacements = [];
let nextPublicStdoutStreamId = 0;

function diagnosticValue(value, seen = new Set(), depth = 0) {
  if (depth > 5 || value === undefined || value === null) return value ?? null;
  if (typeof value === "string") return sanitize(value, checkDiagnosticReplacements);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "<cycle>";
  seen.add(value);
  if (Array.isArray(value)) return value.slice(0, 200).map((entry) => diagnosticValue(entry, seen, depth + 1));
  return Object.fromEntries(Object.entries(value).slice(0, 200).map(([key, entry]) => [
    key,
    diagnosticValue(entry, seen, depth + 1),
  ]));
}

function configureCheckDiagnostics(path, replacements = []) {
  checkDiagnosticPath = path;
  checkDiagnosticReplacements = replacements;
  if (typeof path === "string") {
    try { writeFileSync(path, "", { flag: "a" }); } catch {}
  }
}

function appendCheckDiagnostic(event) {
  if (typeof checkDiagnosticPath !== "string") return;
  try {
    appendFileSync(checkDiagnosticPath, `${JSON.stringify({
      at: new Date().toISOString(),
      ...event,
    })}\n`, "utf8");
  } catch {}
}

function nowTag() {
  return new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
}

function sanitize(value, replacements = []) {
  let text = String(value ?? "");
  for (const [from, to] of replacements) {
    if (from) text = text.split(from).join(to);
  }
  text = text.replace(/([?&]token=)[^\s&#]+/gi, "$1<redacted>");
  text = text.replace(/(authorization\s*:\s*bearer\s+)[^\s]+/gi, "$1<redacted>");
  return text.replace(/[\r\n]+/g, " ").slice(-MAX_LOG_CHARS);
}

function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sha256(path) {
  const fd = openSync(path, "r");
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytes;
    do {
      bytes = readSync(fd, buffer, 0, buffer.length, null);
      if (bytes > 0) hash.update(buffer.subarray(0, bytes));
    } while (bytes > 0);
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}

function isInside(parent, child) {
  const base = resolve(parent);
  const candidate = resolve(child);
  const separator = base.includes("\\") ? "\\" : "/";
  return candidate === base || candidate.startsWith(`${base}${separator}`);
}

function addCheck(report, id, status, detail, evidence = undefined) {
  const check = { id, status, detail };
  if (evidence !== undefined) check.evidence = evidence;
  report.checks.push(check);
  appendCheckDiagnostic({
    type: "check",
    id,
    status,
    detail: sanitize(detail, checkDiagnosticReplacements),
    evidence: evidence === undefined ? undefined : diagnosticValue(evidence),
  });
  return check;
}

function parseArgs(argv) {
  const options = { tgz: undefined, keep: false, phase: undefined, scope: undefined, only: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--tgz") options.tgz = argv[++index];
    else if (argument === "--keep") options.keep = true;
    else if (argument === "--phase") options.phase = argv[++index];
    else if (argument === "--scope") options.scope = argv[++index];
    else if (argument === "--only") options.only = argv[++index];
    else if (argument !== "") throw new Error(`unknown argument: ${argument}`);
  }
  if (options.phase !== undefined && options.phase !== "enabled-retained") {
    throw new Error(`unsupported phase filter: ${options.phase}`);
  }
  if (options.scope !== undefined && !["startup-native", "wsl-advanced", "git-advanced"].includes(options.scope)) {
    throw new Error(`unsupported scope filter: ${options.scope}`);
  }
  if (options.only !== undefined && options.only !== "bash-git-bash:natural-exit-noisy-background") {
    throw new Error(`unsupported test-only check filter: ${options.only}`);
  }
  return options;
}

function desktopPaths() {
  if (process.platform !== "win32") return undefined;
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) return undefined;
  const executable = process.env.DSH_DESKTOP_EXE ?? join(
    localAppData,
    "Programs",
    "DeepSeek Harness",
    "DeepSeek Harness.exe",
  );
  const resources = join(dirname(executable), "resources");
  return {
    executable,
    resources,
    asar: process.env.DSH_DESKTOP_ASAR ?? join(resources, "app.asar"),
    runtimeDir: join(resources, "app.asar", "dsh"),
    primaryRuntime: join(resources, "runtime", "primary-runtime"),
    node: join(
      resources,
      "runtime",
      "primary-runtime",
      "dependencies",
      "node",
      "bin",
      "node.exe",
    ),
    pnpm: join(
      resources,
      "runtime",
      "primary-runtime",
      "dependencies",
      "pnpm",
      "bin",
      "pnpm.mjs",
    ),
  };
}

/** Minimal ASAR reader used only for immutable host metadata and standard path. */
function openAsar(path) {
  const fd = openSync(path, "r");
  const prefix = Buffer.alloc(16);
  readSync(fd, prefix, 0, prefix.length, 0);
  const pickleHeaderSize = prefix.readUInt32LE(4);
  const jsonLength = prefix.readUInt32LE(12);
  const header = Buffer.alloc(jsonLength);
  readSync(fd, header, 0, jsonLength, 16);
  const tree = JSON.parse(header.toString("utf8"));
  const dataStart = 8 + pickleHeaderSize;
  if (dataStart < 16 + jsonLength) {
    closeSync(fd);
    throw new Error("unsupported ASAR header boundary");
  }
  function entry(pathName) {
    let current = tree;
    for (const part of pathName.split("/").filter(Boolean)) {
      current = current?.files?.[part];
      if (current === undefined) return undefined;
    }
    return current;
  }
  function resolvedEntry(pathName, seen = new Set()) {
    if (seen.has(pathName)) throw new Error(`ASAR link cycle: ${pathName}`);
    seen.add(pathName);
    const value = entry(pathName);
    if (value?.link !== undefined) {
      const parent = pathName.includes("/")
        ? `${pathName.slice(0, pathName.lastIndexOf("/"))}/`
        : "";
      const target = String(value.link);
      return resolvedEntry(target.startsWith("/") ? target.slice(1) : `${parent}${target}`, seen);
    }
    return value;
  }
  function read(pathName) {
    const value = resolvedEntry(pathName);
    if (value === undefined || value.files !== undefined) {
      throw new Error(`ASAR file is missing: ${pathName}`);
    }
    const size = Number(value.size);
    const offset = Number(value.offset ?? 0);
    if (!Number.isSafeInteger(size) || !Number.isSafeInteger(offset)) {
      throw new Error(`ASAR entry is not a regular file: ${pathName}`);
    }
    const content = Buffer.alloc(size);
    readSync(fd, content, 0, size, dataStart + offset);
    return content;
  }
  return {
    read,
    readJson(pathName) { return JSON.parse(read(pathName).toString("utf8")); },
    close() { closeSync(fd); },
  };
}

function parseTarGz(path) {
  const archive = gunzipSync(readFileSync(path));
  const files = new Map();
  const problems = [];
  let offset = 0;
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    const rawName = header.subarray(0, 100).toString("utf8").replace(/\0.*$/s, "");
    if (rawName.length === 0) break;
    const sizeText = header.subarray(124, 136).toString("ascii").replace(/\0.*$/s, "").trim();
    const size = Number.parseInt(sizeText || "0", 8);
    const type = String.fromCharCode(header[156] || 0);
    if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > archive.length) {
      problems.push(`invalid tar entry ${rawName || "<empty>"}`);
      break;
    }
    if (type === "0" || type === "\0") {
      files.set(rawName, Buffer.from(archive.subarray(offset + 512, offset + 512 + size)));
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return { files, problems };
}

function readJsonFile(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function inspectTarball(tgz) {
  const { files, problems } = parseTarGz(tgz);
  const names = [...files.keys()];
  const packageJsonBuffer = files.get("package/package.json");
  let manifest;
  try { manifest = packageJsonBuffer === undefined ? undefined : JSON.parse(packageJsonBuffer.toString("utf8")); }
  catch { manifest = undefined; }
  const unsafePaths = names.filter((name) => {
    const normalized = name.replaceAll("\\", "/");
    return normalized !== name
      || normalized.startsWith("/")
      || /^[A-Za-z]:/.test(normalized)
      || normalized.split("/").includes("..")
      || !normalized.startsWith("package/");
  });
  const forbiddenFiles = names.filter((name) => /^(?:package\/(?:src|test|测试|docs|scripts|node_modules)(?:\/|$))/i.test(name));
  const expectedFiles = [
    "package/package.json",
    "package/dist/index.js",
    "package/dist/modes.js",
    "package/dist/git/backend.js",
    "package/dist/config.js",
    "package/dist/prompt.js",
    "package/dist/runtime.js",
    "package/dist/tools/persistent.js",
    "package/cordis.patch.yml",
    "package/LICENSE",
    "package/NOTICE",
  ];
  const missingFiles = expectedFiles.filter((name) => !files.has(name));
  const privatePathHits = [];
  for (const [name, content] of files) {
    const text = content.toString("utf8");
    if (/(?:[A-Za-z]:[\\/]Users[\\/][^\s"']+|\/mnt\/c\/Users\/|-----BEGIN (?:RSA|OPENSSH|EC|PRIVATE) KEY-----|sk-[A-Za-z0-9]{20,})/i.test(text)) {
      privatePathHits.push(name);
    }
  }
  const sourceDistHashes = {};
  const tarDistHashes = {};
  for (const name of names.filter((value) => value.startsWith("package/dist/") && value.endsWith(".js"))) {
    const relativeName = name.slice("package/".length);
    const sourcePath = join(ROOT, relativeName.replaceAll("/", "\\"));
    tarDistHashes[relativeName] = sha256Bytes(files.get(name));
    if (existsSync(sourcePath) && statSync(sourcePath).isFile()) sourceDistHashes[relativeName] = sha256(sourcePath);
  }
  const distHashMismatches = Object.keys(tarDistHashes)
    .filter((name) => sourceDistHashes[name] !== tarDistHashes[name]);
  const peerVersions = manifest?.peerDependencies ?? {};
  const dependencies = manifest?.dependencies ?? {};
  const dependencyKeys = Object.keys(dependencies).sort();
  const peerRangeOk = manifest?.engines?.dsh === EXPECTED_DESKTOP_VERSION
    && Object.entries(peerVersions).every(([name, version]) =>
      version === (name === "@deepseek-ai/cordis" ? "4.0.5" : EXPECTED_DESKTOP_VERSION));
  const dependencyShapeOk = dependencyKeys.length === 1
    && dependencyKeys[0] === "@deepseek-ai/schemastery";
  const packageStatus = manifest?.name === "dsh-plugin-bash-wsl"
    && manifest.version === EXPECTED_PLUGIN_VERSION
    && problems.length === 0
    && unsafePaths.length === 0
    && forbiddenFiles.length === 0
    && missingFiles.length === 0
    && privatePathHits.length === 0
    && peerRangeOk
    && dependencyShapeOk
    && distHashMismatches.length === 0;
  return {
    status: packageStatus ? "PASS" : "FAIL",
    bytes: statSync(tgz).size,
    sha256: sha256(tgz),
    fileCount: names.length,
    manifest: manifest ? {
      name: manifest.name ?? null,
      version: manifest.version ?? null,
      peerDependencies: peerVersions,
      dependencies,
      files: manifest.files ?? null,
    } : null,
    problems,
    unsafePaths,
    forbiddenFiles,
    missingFiles,
    privatePathHits,
    peerRangeOk,
    dependencyShapeOk,
    distHashMismatches,
    sourceDistHashes,
    tarDistHashes,
  };
}

function packageSpec(profile, tgz) {
  const rel = relative(profile, tgz).replaceAll("\\", "/");
  return `file:${rel.startsWith(".") ? rel : `./${rel}`}`;
}

function writeProfile(profile, tgz, enabled, persistentTimeoutMs = undefined) {
  const manifest = {
    name: "dsh-native-modes-desktop-probe",
    private: true,
    dependencies: { "dsh-plugin-bash-wsl": packageSpec(profile, tgz) },
    dsh: {
      profile: {
        bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", ...(enabled ? ["dsh-plugin-bash-wsl"] : [])],
      },
    },
  };
  writeFileSync(join(profile, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(profile, "cordis.yml"), "[]\n");
  const testPatches = Number.isSafeInteger(persistentTimeoutMs) && persistentTimeoutMs > 0
    ? [
        "# Test-only timeout override for the diagnostic profile; production files are untouched.",
        "- id: bash-wsl-backend-and-tools",
        "  config:",
        `    timeoutMs: ${TEST_PERSISTENT_TIMEOUT_MS}`,
        "- id: bash-wsl-persistent-tool",
        "  config:",
        `    timeoutMs: ${TEST_PERSISTENT_TIMEOUT_MS}`,
        "",
      ].join("\n")
    : "[]\n";
  writeFileSync(join(profile, "cordis.patch.yml"), testPatches);
  writeFileSync(join(profile, "pnpm-workspace.yaml"), "packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n");
}

function retireInstalledBundle(profile) {
  const manifestPath = join(profile, "package.json");
  const manifest = readJsonFile(manifestPath);
  const before = Array.isArray(manifest.dsh?.profile?.bundles)
    ? [...manifest.dsh.profile.bundles]
    : [];
  if (!manifest.dsh?.profile || !Array.isArray(manifest.dsh.profile.bundles)) {
    throw new Error("isolated profile has no dsh.profile.bundles list to retire");
  }
  manifest.dsh.profile.bundles = before.filter((name) => name !== PLUGIN_ROW_NAME);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { before, after: [...manifest.dsh.profile.bundles] };
}

function filteredEnvironment(overrides = {}) {
  const filtered = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !/^(?:(?:DSH_|DEEPSEEK_|OPENAI_|ANTHROPIC_|AWS_|GITHUB_).*$|.*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PRIVATE[_-]?KEY))$/i.test(name),
  ));
  return { ...filtered, ...overrides };
}

function runOwnedProcess(executable, args, options = {}) {
  const stdoutPath = options.stdoutPath;
  const stderrPath = options.stderrPath;
  if (typeof stdoutPath !== "string" || typeof stderrPath !== "string") throw new Error("owned process log paths are required");
  mkdirSync(dirname(stdoutPath), { recursive: true });
  const stdoutFd = openSync(stdoutPath, "w");
  const stderrFd = openSync(stderrPath, "w");
  const child = spawn(executable, args, {
    cwd: options.cwd,
    env: filteredEnvironment(options.env ?? {}),
    stdio: ["ignore", stdoutFd, stderrFd],
    windowsHide: true,
    shell: false,
  });
  closeSync(stdoutFd);
  closeSync(stderrFd);
  return new Promise((resolveResult) => {
    let settled = false;
    let timedOut = false;
    let error;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill(); } catch {}
    }, options.timeoutMs ?? CHILD_TIMEOUT_MS);
    child.once("error", (value) => { error = value; });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveResult({
        code,
        signal,
        timedOut,
        error: error === undefined ? undefined : sanitize(error),
        closeObserved: true,
        reaped: true,
        stdout: existsSync(stdoutPath) ? readFileSync(stdoutPath, "utf8") : "",
        stderr: existsSync(stderrPath) ? readFileSync(stderrPath, "utf8") : "",
      });
    });
  });
}

async function reserveLocalPort() {
  const { createServer } = await import("node:net");
  const server = createServer();
  await new Promise((resolveResult, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveResult);
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : undefined;
  await new Promise((resolveResult, reject) => server.close((error) => error === undefined ? resolveResult() : reject(error)));
  if (!Number.isInteger(port) || port <= 0) throw new Error("could not reserve Desktop probe port");
  return port;
}

function protectedProfileSnapshot() {
  const userProfile = process.env.USERPROFILE;
  if (!userProfile) return {};
  const dshRoot = join(userProfile, ".dsh");
  const candidates = [
    ["web/package.json", join(dshRoot, "profiles", "web", "package.json")],
    ["web/pnpm-lock.yaml", join(dshRoot, "profiles", "web", "pnpm-lock.yaml")],
    ["web/cordis.patch.yml", join(dshRoot, "profiles", "web", "cordis.patch.yml")],
    ["web/plugin/package.json", join(dshRoot, "profiles", "web", "node_modules", PLUGIN_ROW_NAME, "package.json")],
    ["desktop/package.json", join(dshRoot, "profiles", "desktop", "package.json")],
    ["desktop/pnpm-lock.yaml", join(dshRoot, "profiles", "desktop", "pnpm-lock.yaml")],
    ["desktop/cordis.patch.yml", join(dshRoot, "profiles", "desktop", "cordis.patch.yml")],
    ["desktop/plugin/package.json", join(dshRoot, "profiles", "desktop", "node_modules", PLUGIN_ROW_NAME, "package.json")],
  ];
  return Object.fromEntries(candidates
    .filter(([, path]) => existsSync(path) && statSync(path).isFile())
    .map(([label, path]) => [label, { sha256: sha256(path), bytes: statSync(path).size }]));
}

function flattenRows(rows, output = []) {
  if (!Array.isArray(rows)) return output;
  for (const row of rows) {
    if (row && typeof row === "object" && row.group === true && Array.isArray(row.config)) flattenRows(row.config, output);
    else if (row && typeof row === "object") output.push(row);
  }
  return output;
}

function withoutStockBash(rows) {
  if (!Array.isArray(rows)) return rows;
  return rows
    .filter((row) => !(row && typeof row === "object" && row.name === STOCK_BASH_ROW))
    .map((row) => {
      if (row && typeof row === "object" && row.group === true && Array.isArray(row.config)) {
        return { ...row, config: withoutStockBash(row.config) };
      }
      return row;
    });
}

function isNativeModeGroup(row) {
  if (!row || typeof row !== "object" || row.group !== true || !row.isolate?.terminals || !Array.isArray(row.config)) return false;
  const names = flattenRows(row.config).map((child) => child.name);
  return names.includes(PLUGIN_ROW_NAME)
    && names.includes("@deepseek-ai/dsh-terminal")
    && names.includes(PERSISTENT_ROW_NAME);
}

function withoutNativeModeGroup(rows) {
  if (!Array.isArray(rows)) return rows;
  return rows
    .filter((row) => !isNativeModeGroup(row))
    .map((row) => {
      if (row && typeof row === "object" && row.group === true && Array.isArray(row.config)) {
        return { ...row, config: withoutNativeModeGroup(row.config) };
      }
      return row;
    });
}

function multiset(values) {
  const result = new Map();
  for (const value of values) result.set(value, (result.get(value) ?? 0) + 1);
  return result;
}

function sameMultiset(left, right) {
  const a = multiset(left);
  const b = multiset(right);
  if (a.size !== b.size) return false;
  for (const [key, value] of a) if (b.get(key) !== value) return false;
  return true;
}

function countJsNodes(value) {
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + countJsNodes(item), 0);
  if (value && typeof value === "object") {
    const own = Object.prototype.hasOwnProperty.call(value, "__jsExpr") ? 1 : 0;
    return own + Object.values(value).reduce((sum, item) => sum + countJsNodes(item), 0);
  }
  return 0;
}

function contentText(value, seen = new Set()) {
  if (value === undefined || value === null) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (typeof value !== "object") return "";
  if (seen.has(value)) return "";
  seen.add(value);
  if (Array.isArray(value)) return value.map((entry) => contentText(entry, seen)).filter(Boolean).join("\n");
  if (typeof value.text === "string") return value.text;
  if (typeof value.stdout === "string" || typeof value.stdout?.text === "string") {
    return String(value.stdout?.text ?? value.stdout);
  }
  if (typeof value.output === "string" || typeof value.output?.text === "string") {
    return String(value.output?.text ?? value.output);
  }
  if (value.content !== undefined) return contentText(value.content, seen);
  if (value.value !== undefined) return contentText(value.value, seen);
  if (value.error !== undefined) return contentText(value.error, seen);
  return "";
}

function textOf(result) {
  return contentText(result);
}

const TERMINAL_ROLLING_WINDOW_BYTES = 64 * 1024;
const CONTROLLED_PROMPT_STEM = "__DSH_PERSISTENT_BASH_PROMPT__";
const CONTROLLED_PROMPT_CONTRACT_WSL = "OSC133D-BEL+__DSH_PERSISTENT_BASH_PROMPT__ ";
const CONTROLLED_PROMPT_CONTRACT_GIT = "OSC133D-BEL+canonical-status;__DSH_PERSISTENT_BASH_PROMPT__+visible-__DSH_PERSISTENT_BASH_PROMPT__";
const CONTROLLED_PROMPT_CONTRACT_GIT_LEGACY = "OSC133D-BEL+[display-CSI]*+__DSH_PERSISTENT_BASH_PROMPT__";

function utf8Tail(value, limit = TERMINAL_ROLLING_WINDOW_BYTES) {
  const bytes = Buffer.from(String(value ?? ""), "utf8");
  const bounded = bytes.length > limit ? bytes.subarray(bytes.length - limit) : bytes;
  let start = 0;
  while (start < bounded.length && (bounded[start] & 0xc0) === 0x80) start += 1;
  return bounded.subarray(start).toString("utf8");
}

function stripAnsiControlSequences(value) {
  return String(value ?? "")
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b[@-_]/g, "");
}

function parseGitDisplayCsiGap(value) {
  const text = String(value ?? "");
  const csiPattern = /\u001b\[[0-?]*[ -/]*[@-~]/g;
  const sequences = [...text.matchAll(csiPattern)].map((match) => ({
    at: match.index ?? 0,
    endAt: (match.index ?? 0) + match[0].length,
    token: match[0],
  }));
  const legalDisplayCsi = /^(?:\u001b\[[0-9;?]*)(?:A|B|C|D|E|F|G|H|J|K|X|f|h|l|m|s|u)$/;
  const csiOffsets = new Set(sequences.map((entry) => entry.at));
  const hasUnmatchedEscape = [...text.matchAll(/\u001b/g)]
    .some((match) => !csiOffsets.has(match.index ?? 0));
  const wellFormed = !hasUnmatchedEscape
    && sequences.every((entry) => legalDisplayCsi.test(entry.token));
  return {
    complete: wellFormed
      && sequences.map((entry) => entry.token).join("") === text,
    wellFormed,
    sequences,
  };
}

function canonicalPromptStatus(value) {
  const text = String(value ?? "");
  if (!/^(?:0|[1-9][0-9]*)$/.test(text)) return null;
  const number = Number(text);
  return Number.isInteger(number)
    && number >= 0
    && number <= 255
    && String(number) === text
    ? number
    : null;
}

function parsePromptControlToken(token, backendType, promptStem) {
  const text = String(token ?? "");
  const match = text.match(/^\u001b\]([\s\S]*?)(\u0007|\u001b\\)$/);
  if (match === null) {
    return {
      payload: null,
      statusText: null,
      status: null,
      terminator: null,
      canonicalStatus: false,
      legacyControlValid: false,
      completeValidControl: false,
    };
  }
  const payload = match[1];
  const terminator = match[2] === "\u0007" ? "BEL" : "ST";
  const statusMatch = payload.match(/^133;D;([^;]*)(?:;(.*))?$/);
  const statusText = statusMatch?.[1] ?? null;
  const status = canonicalPromptStatus(statusText);
  const canonicalStatus = status !== null;
  const legacyControlValid = terminator === "BEL"
    && canonicalStatus
    && payload === `133;D;${statusText}`;
  const completeValidControl = backendType === "git-bash"
    && terminator === "BEL"
    && canonicalStatus
    && payload === `133;D;${statusText};${promptStem}`;
  return {
    payload,
    statusText,
    status,
    terminator,
    canonicalStatus,
    legacyControlValid,
    completeValidControl,
  };
}

function terminalFrameTrace(
  value,
  limit = TERMINAL_ROLLING_WINDOW_BYTES,
  source = "official-terminals.read",
  backendType = "wsl",
  observationMode = "raw",
) {
  const text = String(value ?? "");
  const window = utf8Tail(text, limit);
  const tokenRegex = observationMode === "public-visible"
    ? /(?:__DSH_PERSISTENT_BASH_PROMPT__|__DSH_PERSISTENT_BASH_START_[0-9a-f-]+__|__DSH_PERSISTENT_BASH_END_[0-9a-f-]+:\d+)/gi
    : /(?:\u001b\]133;D[^\u0007\u001b]*(?:\u0007|\u001b\\)|__DSH_PERSISTENT_BASH_PROMPT__|__DSH_PERSISTENT_BASH_START_[0-9a-f-]+__|__DSH_PERSISTENT_BASH_END_[0-9a-f-]+:\d+)/gi;
  const tokens = [...window.matchAll(tokenRegex)].slice(0, 128).map((match) => {
    const token = match[0];
    const kind = token.startsWith("\u001b]133;D")
      ? "osc133D"
      : token.includes("PROMPT")
        ? "controlledPrompt"
        : token.includes("_END_") ? "end" : "start";
    const control = kind === "osc133D"
      ? parsePromptControlToken(token, backendType, CONTROLLED_PROMPT_STEM)
      : null;
    return {
      at: match.index ?? 0,
      endAt: (match.index ?? 0) + token.length,
      kind,
      token: sanitize(token, checkDiagnosticReplacements),
      ...(control === null ? {} : {
        oscPayload: control.payload,
        oscStatusText: control.statusText,
        oscStatus: control.status,
        oscTerminator: control.terminator,
        canonicalStatus: control.canonicalStatus,
        legacyControlValid: control.legacyControlValid,
        completeValidControl: control.completeValidControl,
      }),
    };
  });
  const frameStarts = [...window.matchAll(/__DSH_PERSISTENT_BASH_START_([0-9a-f-]+)__/gi)]
    .map((match) => ({ nonce: match[1], at: match.index ?? 0 }));
  // The production wrapper's end marker is `...END_<nonce>:<exit>` with no
  // trailing `__`; the opening marker is the only one carrying that suffix.
  const frameEnds = [...window.matchAll(/__DSH_PERSISTENT_BASH_END_([0-9a-f-]+):(-?\d+)/gi)]
    .map((match) => ({ nonce: match[1], exitCode: Number(match[2]), at: match.index ?? 0 }));
  const framePairs = frameStarts.map((start) => ({
    ...start,
    end: frameEnds.find((end) => end.nonce === start.nonce && end.at > start.at) ?? null,
  }));
  const promptPattern = backendType === "git-bash"
    ? /__DSH_PERSISTENT_BASH_PROMPT__/g
    : /__DSH_PERSISTENT_BASH_PROMPT__ /g;
  const oscTokens = tokens.filter((token) => token.kind === "osc133D");
  const ignoredOscRanges = observationMode === "public-visible"
    ? [...window.matchAll(/\u001b\]133;D[^\u0007\u001b]*(?:\u0007|\u001b\\)/g)]
      .map((match) => ({
        at: match.index ?? 0,
        endAt: (match.index ?? 0) + match[0].length,
      }))
    : oscTokens;
  const visiblePromptMatches = [...window.matchAll(promptPattern)]
    .filter((match) => {
      const promptAt = match.index ?? 0;
      return !ignoredOscRanges.some((token) => token.at < promptAt && promptAt < token.endAt);
    });
  const promptPairs = visiblePromptMatches
    .map((match) => {
      const promptAt = match.index ?? 0;
      const promptEndAt = promptAt + match[0].length;
      const osc = [...oscTokens]
        .reverse()
        .find((token) => token.endAt <= promptAt);
      const gap = osc === undefined ? null : window.slice(osc.endAt, promptAt);
      const parsedGap = backendType === "git-bash"
        ? parseGitDisplayCsiGap(gap ?? "")
        : { complete: gap === "", wellFormed: gap === "", sequences: [] };
      const displayCsi = parsedGap.sequences.map((entry) => ({
        ...entry,
        at: (osc?.endAt ?? 0) + entry.at,
        endAt: (osc?.endAt ?? 0) + entry.endAt,
      }));
      const byteAdjacent = osc !== undefined && osc.endAt === promptAt;
      const completeValidControl = osc?.completeValidControl === true;
      const legacyControlValid = osc?.legacyControlValid === true;
      const controlContractValid = backendType === "git-bash"
        ? completeValidControl || legacyControlValid
        : legacyControlValid;
      const readinessKind = backendType === "git-bash"
        ? completeValidControl && parsedGap.wellFormed
          ? "native-full-control" : null
        : legacyControlValid && byteAdjacent ? "wsl-adjacent-visible" : null;
      const readinessPair = readinessKind === null || osc === undefined
        ? null
        : {
          kind: readinessKind,
          complete: true,
          controlAt: osc.at,
          controlEndAt: osc.endAt,
          controlToken: osc.token,
          controlPayload: osc.oscPayload ?? null,
          controlStatusText: osc.oscStatusText ?? null,
          controlStatus: osc.oscStatus ?? null,
          completeValidControl,
          legacyControlValid,
          visibleAt: promptAt,
          visibleEndAt: promptEndAt,
          visibleToken: match[0],
          byteAdjacent,
          gapAt: osc.endAt,
          gapEndAt: promptAt,
          gapBytes: Buffer.byteLength(gap ?? ""),
          gapText: sanitize(gap ?? "", checkDiagnosticReplacements),
          displayCsiComplete: parsedGap.complete,
          displayCsiWellFormed: parsedGap.wellFormed,
        };
      return {
        promptAt,
        promptEndAt,
        oscAt: osc?.at ?? null,
        oscEndAt: osc?.endAt ?? null,
        atomic: controlContractValid && parsedGap.complete,
        publicVisible: observationMode === "public-visible",
        byteAdjacent,
        completeValidControl,
        legacyControlValid,
        controlToken: osc?.token ?? null,
        controlPayload: osc?.oscPayload ?? null,
        controlStatusText: osc?.oscStatusText ?? null,
        controlStatus: osc?.oscStatus ?? null,
        readinessPair,
        displayCsiComplete: parsedGap.complete,
        displayCsiWellFormed: parsedGap.wellFormed,
        visibleGap: sanitize(gap ?? "", checkDiagnosticReplacements),
        displayCsi,
        backendType,
      };
    });
  const promptIndices = promptPairs
    .filter((entry) => entry.publicVisible === true
      || entry.atomic
      || entry.readinessPair?.complete === true)
    .map((entry) => entry.promptAt);
  const noisyIndices = [...window.matchAll(/NOISY_BG/g)].map((match) => match.index ?? 0);
  const compact = window.replace(/ {32,}/g, (spaces) => `<spaces:${spaces.length}>`);
  return {
    source,
    backendType,
    observationMode,
    rawBytes: Buffer.byteLength(text),
    rollingWindowBytes: Buffer.byteLength(window),
    rollingWindowSha256: sha256Bytes(window),
    tokens,
    frameStarts,
    frameEnds,
    framePairs,
    promptContract: backendType === "git-bash"
      ? CONTROLLED_PROMPT_CONTRACT_GIT
      : CONTROLLED_PROMPT_CONTRACT_WSL,
    legacyPromptContract: backendType === "git-bash"
      ? CONTROLLED_PROMPT_CONTRACT_GIT_LEGACY
      : null,
    promptPairs,
    promptIndices,
    noisyIndices,
    hasOsc133D: tokens.some((entry) => entry.kind === "osc133D"),
    hasVisiblePrompt: promptIndices.length > 0,
    hasControlledPrompt: observationMode !== "public-visible"
      && promptIndices.length > 0,
    hasStartFrame: tokens.some((entry) => entry.kind === "start"),
    hasEndFrame: tokens.some((entry) => entry.kind === "end"),
    compactHead: sanitize(compact.slice(0, 1_024), checkDiagnosticReplacements),
    compactTail: sanitize(compact.slice(-1_024), checkDiagnosticReplacements),
  };
}

function frameContractsFromTrace(trace, baselineNonces = new Set()) {
  if (!trace || !Array.isArray(trace.framePairs)) return [];
  const publicVisibleTrace = trace.observationMode === "public-visible";
  return trace.framePairs.map((pair) => {
    const end = pair.end;
    const nextStart = Array.isArray(trace.frameStarts)
      ? trace.frameStarts.find((start) => start.at > pair.at)
      : null;
    const frameLimit = nextStart?.at ?? Number.POSITIVE_INFINITY;
    const promptAfterEndEntry = end !== null
      && end.exitCode === 0
      && Array.isArray(trace.promptPairs)
      ? trace.promptPairs.find((entry) => {
        if (entry.promptAt <= end.at || entry.promptAt >= frameLimit) {
          return false;
        }
        if (publicVisibleTrace) return entry.publicVisible === true;
        const readiness = entry.readinessPair;
        if (readiness?.complete !== true) return false;
        if (trace.backendType === "git-bash") {
          return Number.isSafeInteger(readiness.controlAt)
            && readiness.controlAt >= pair.at
            && readiness.controlAt < frameLimit;
        }
        return readiness.byteAdjacent === true
          && Number.isSafeInteger(readiness.controlAt)
          && readiness.controlAt >= pair.at
          && readiness.controlAt > end.at
          && readiness.controlAt < frameLimit;
      })
      : undefined;
    const promptAfterEnd = promptAfterEndEntry !== undefined;
    const readinessPair = publicVisibleTrace
      ? null
      : promptAfterEndEntry?.readinessPair ?? null;
    const oscInFrame = !publicVisibleTrace && promptAfterEndEntry !== undefined
      && Number.isSafeInteger(readinessPair?.controlAt)
      && readinessPair.controlAt >= pair.at
      && (nextStart == null || readinessPair.controlAt < nextStart.at);
    const noisyAfterStart = Array.isArray(trace.noisyIndices)
      && trace.noisyIndices.some((index) => index > pair.at && index < frameLimit);
    const noisyAfterEnd = end !== null
      && Array.isArray(trace.noisyIndices)
      && trace.noisyIndices.some((index) => index > end.at && index < frameLimit);
    return {
      nonce: pair.nonce,
      startIndex: pair.at,
      endIndex: end?.at ?? null,
      nextStartIndex: nextStart?.at ?? null,
      exitCode: end?.exitCode ?? null,
      startObserved: true,
      endObserved: end !== null,
      promptAfterEnd,
      publicVisiblePrompt: promptAfterEndEntry?.publicVisible === true,
      promptAt: promptAfterEndEntry?.promptAt ?? null,
      promptEndAt: promptAfterEndEntry?.promptEndAt ?? null,
      promptOscAt: promptAfterEndEntry?.oscAt ?? null,
      promptOscEndAt: promptAfterEndEntry?.oscEndAt ?? null,
      promptDisplayCsi: promptAfterEndEntry?.displayCsi ?? [],
      promptDisplayCsiComplete: promptAfterEndEntry?.displayCsiComplete ?? false,
      promptDisplayCsiWellFormed: promptAfterEndEntry?.displayCsiWellFormed ?? false,
      promptVisibleGap: promptAfterEndEntry?.visibleGap ?? null,
      promptControlAt: readinessPair?.controlAt ?? null,
      promptControlEndAt: readinessPair?.controlEndAt ?? null,
      promptControlToken: readinessPair?.controlToken ?? null,
      promptControlPayload: readinessPair?.controlPayload ?? null,
      promptControlStatusText: readinessPair?.controlStatusText ?? null,
      promptControlStatus: readinessPair?.controlStatus ?? null,
      promptControlCompleteValid: readinessPair?.completeValidControl ?? false,
      promptControlLegacyValid: readinessPair?.legacyControlValid ?? false,
      promptControlByteAdjacent: readinessPair?.byteAdjacent ?? false,
      readinessPair,
      promptContract: trace.promptContract ?? null,
      oscInFrame,
      noisyAfterStart,
      noisyAfterEnd,
      isNew: !baselineNonces.has(pair.nonce),
      rollingWindowSha256: trace.rollingWindowSha256 ?? null,
      rollingWindowBytes: trace.rollingWindowBytes ?? null,
      source: trace.source ?? null,
      backendType: trace.backendType ?? null,
    };
  });
}

function traceNonces(traces) {
  return new Set((Array.isArray(traces) ? traces : [])
    .flatMap((trace) => Array.isArray(trace?.frameStarts) ? trace.frameStarts : [])
    .map((entry) => entry.nonce)
    .filter((nonce) => typeof nonce === "string" && nonce.length > 0));
}

function selectFreshBackgroundFrame(traces, baselineNonces) {
  const candidates = (Array.isArray(traces) ? traces : [])
    .flatMap((trace) => frameContractsFromTrace(trace, baselineNonces))
    .filter((frame) => frame.isNew && frame.endObserved);
  return candidates.find((frame) => frame.noisyAfterStart && frame.promptAfterEnd)
    ?? candidates.find((frame) => frame.noisyAfterStart)
    ?? candidates[0]
    ?? null;
}

function terminalReadTrace(read, backendType = "wsl", observationMode = "raw") {
  const text = typeof read?.text === "string" ? read.text : "";
  return {
    totalLines: read?.totalLines ?? null,
    lineBegin: read?.lineBegin ?? null,
    lineEnd: read?.lineEnd ?? null,
    truncated: read?.truncated ?? null,
    ...terminalFrameTrace(
      text,
      TERMINAL_ROLLING_WINDOW_BYTES,
      "official-terminals.read",
      backendType,
      observationMode,
    ),
  };
}

function stdoutObservationScope(request, backendType) {
  const argv = Array.isArray(request?.argv) ? request.argv.map((value) => String(value)) : [];
  const joined = argv.join("\u0000");
  if (backendType === "git-bash") {
    return argv.some((value) => /pty-helper[.]js$/i.test(value))
      ? "terminal-pty"
      : "discovery";
  }
  return argv.some((value) => /(?:^|[\\/])wsl(?:[.]exe)?$/i.test(value))
    && joined.includes("/usr/bin/bwrap")
    && joined.includes("/usr/bin/script")
    && joined.includes("DSH_PTY_SESSION_ID")
    ? "terminal-pty"
    : "discovery";
}

function instrumentPublicStdout(handle, streamRegistry = new WeakMap(), backendType = "wsl", observationScope = "terminal-pty") {
  let stream;
  let streamQueryError = null;
  try {
    stream = handle?.stdout;
  } catch (error) {
    streamQueryError = sanitize(error, checkDiagnosticReplacements);
  }
  const streamAvailable = streamQueryError === null
    && stream !== undefined
    && typeof stream.emit === "function"
    && typeof stream.pause === "function"
    && typeof stream.resume === "function";
  const state = {
    available: streamAvailable,
    installed: false,
    error: streamQueryError,
    registration: streamQueryError !== null
      ? "query-error"
      : stream === undefined
        ? "pending"
        : streamAvailable ? "not-installed" : "unavailable",
    reason: streamQueryError !== null
      ? "stdout-query-threw"
      : stream === undefined
        ? "public-handle-not-ready"
        : streamAvailable ? null : "stdout-interface-incomplete",
    observationScope,
    streamId: null,
    isUniqueObserver: false,
    reused: false,
    reuseCount: 0,
    lastAttempt: null,
    dataEvents: 0,
    totalBytes: 0,
    rolling: "",
    snapshot() {
      const trace = terminalFrameTrace(this.rolling, TERMINAL_ROLLING_WINDOW_BYTES, "public-subprocess.stdout data", backendType);
      return {
        source: "public-subprocess.stdout data",
        available: this.available,
        installed: this.installed,
        error: this.error,
          observationScope: this.observationScope,
        registration: this.registration,
        streamId: this.streamId,
        isUniqueObserver: this.isUniqueObserver,
        reused: this.reused,
        reuseCount: this.reuseCount,
        dataEvents: this.dataEvents,
        totalBytes: this.totalBytes,
        rollingTailBytes: trace.rollingWindowBytes,
        streamTrace: trace,
      };
    },
    restore() {},
  };
  const markAttempt = (registration = state.registration, reason = state.reason) => {
    state.registration = registration;
    state.reason = reason;
    state.lastAttempt = {
      registration,
      reason,
      observationScope,
      streamId: state.streamId,
      isUniqueObserver: registration === "installed",
      reused: registration === "reused",
      reuseCount: state.reuseCount,
    };
    return state;
  };
  if (!state.available) return markAttempt();
  const existing = typeof streamRegistry?.get === "function"
    ? streamRegistry.get(stream)
    : undefined;
  if (existing) {
    existing.reuseCount += 1;
    existing.lastAttempt = {
      registration: "reused",
      reason: "stream-already-instrumented",
      observationScope,
      streamId: existing.streamId,
      isUniqueObserver: false,
      reused: true,
      reuseCount: existing.reuseCount,
    };
    return existing;
  }
  const originalEmit = stream.emit;
  try {
    stream.emit = function observedPublicStdoutEmit(event, ...args) {
      if (event === "data") {
        const chunk = Buffer.isBuffer(args[0]) ? args[0] : Buffer.from(String(args[0] ?? ""), "utf8");
        state.dataEvents += 1;
        state.totalBytes += chunk.byteLength;
        state.rolling = utf8Tail(`${state.rolling}${chunk.toString("utf8")}`);
      }
      return originalEmit.call(this, event, ...args);
    };
    state.installed = true;
    state.registration = "installed";
    state.isUniqueObserver = true;
    state.streamId = `public-stdout-${++nextPublicStdoutStreamId}`;
    state.lastAttempt = {
      registration: "installed",
      reason: null,
      observationScope,
      streamId: state.streamId,
      isUniqueObserver: true,
      reused: false,
      reuseCount: 0,
    };
    if (typeof streamRegistry?.set === "function") {
      streamRegistry.set(stream, state);
    }
    state.restore = () => {
      try {
        if (stream.emit !== originalEmit) stream.emit = originalEmit;
      } catch (error) {
        state.error ??= sanitize(error, checkDiagnosticReplacements);
      }
    };
  } catch (error) {
    state.registration = "install-error";
    state.reason = "stdout-instrumentation-threw";
    state.error = sanitize(error, checkDiagnosticReplacements);
    state.lastAttempt = {
      registration: state.registration,
      reason: state.reason,
      observationScope,
      streamId: state.streamId,
      isUniqueObserver: false,
      reused: false,
      reuseCount: state.reuseCount,
    };
  }
  return state;
}

function recordStdoutObserverAttempt(observer, attempts, terminalObservers, discoveryObservers, allObservers) {
  const attempt = { ...(observer.lastAttempt ?? {}) };
  attempts.push({ observer, attempt });
  if (observer.installed && !allObservers.includes(observer)) {
    allObservers.push(observer);
  }
  if (observer.installed && attempt.observationScope === "terminal-pty" && !terminalObservers.includes(observer)) {
    terminalObservers.push(observer);
  }
  if (observer.installed && attempt.observationScope === "discovery" && !discoveryObservers.includes(observer)) {
    discoveryObservers.push(observer);
  }
}

function observerErrorsFromAttempts(attempts) {
  return [...new Set(
    (Array.isArray(attempts) ? attempts : [])
      .map((entry) => entry?.observer?.error ?? entry?.error ?? null)
      .filter(Boolean),
  )];
}

function stdoutObserverAttemptSnapshot(record) {
  const observer = record.observer ?? record;
  const snapshot = observer.snapshot();
  return {
    ...snapshot,
    attempt: record.attempt ?? observer.lastAttempt ?? null,
  };
}

function nestedStringField(value, field, seen = new Set(), depth = 0) {
  if (depth > 4 || value === null || typeof value !== "object" || seen.has(value)) return null;
  seen.add(value);
  if (typeof value[field] === "string") return value[field];
  for (const key of ["error", "cause", "value", "reason", "info"]) {
    const nested = value[key];
    const found = nestedStringField(nested, field, seen, depth + 1);
    if (found !== null) return found;
  }
  return null;
}

function persistentResultSummary(result) {
  const text = textOf(result);
  const match = /Command finished with exit code\s+(-?\d+)/i.exec(text);
  const shellExit = /\[shell exited: code\s+(-?\d+)\]/i.exec(text);
  const failure = result && typeof result === "object"
    ? (result.failure ?? result.value?.failure ?? null)
    : null;
  const resultError = result && typeof result === "object"
    ? (result.error ?? result.value?.error ?? null)
    : null;
  return {
    resultType: typeof result,
    isError: result && typeof result === "object" && "isError" in result ? result.isError : null,
    error: resultError === null ? null : sanitize(resultError),
    errorName: nestedStringField(resultError, "name"),
    errorCode: nestedStringField(resultError, "code"),
    errorObject: resultError === null ? null : diagnosticValue(resultError),
    failureKind: nestedStringField(failure, "kind"),
    failureCode: nestedStringField(failure, "code"),
    toolExitCode: result && typeof result === "object" && "exitCode" in result ? result.exitCode : null,
    timedOut: result && typeof result === "object" && "timedOut" in result ? result.timedOut : null,
    aborted: result && typeof result === "object" && "aborted" in result ? result.aborted : null,
    parsedExitCode: match === null
      ? shellExit === null ? null : Number(shellExit[1])
      : Number(match[1]),
    shellExited: shellExit !== null,
    output: sanitize(text),
  };
}

function terminalSnapshotsOf(terminals, agent) {
  return terminals?.list?.(agent)?.map((row) => ({
    sessionId: row.sessionId ?? row.id ?? null,
    type: row.type ?? row.backendType ?? null,
    status: row.status ?? null,
    pid: row.pid ?? row.processId ?? null,
  })) ?? [];
}

function publicTerminalObservation(terminals, agent, replacements = [], backendType = "wsl") {
  const observation = {
    listAvailable: typeof terminals?.list === "function",
    readAvailable: typeof terminals?.read === "function",
    snapshots: [],
    reads: [],
    observationErrors: [],
  };
  let rows;
  try {
    if (!observation.listAvailable) {
      observation.observationErrors.push("official terminals.list is unavailable");
      return observation;
    }
    rows = terminals.list(agent);
    if (!Array.isArray(rows)) {
      observation.observationErrors.push("official terminals.list returned a non-array");
      return observation;
    }
  } catch (error) {
    observation.observationErrors.push("terminals.list: " + sanitize(error));
    return observation;
  }
  observation.snapshots = rows.map((row) => ({
    sessionId: row.sessionId ?? row.id ?? null,
    type: row.type ?? row.backendType ?? null,
    status: row.status ?? null,
    pid: row.pid ?? row.processId ?? null,
  }));
  if (!observation.readAvailable) {
    observation.observationErrors.push("official terminals.read is unavailable");
    return observation;
  }
  for (const row of rows) {
    const sessionId = row.sessionId ?? row.id;
    if (sessionId === undefined || sessionId === null) {
      observation.observationErrors.push("terminals.list returned a session without sessionId");
      continue;
    }
    try {
      // Read the host-owned latest terminal window directly.  This is a
      // non-consuming public snapshot; do not call the lower-level
      // operation.readOutput seam or combine it with tool-result prefixes.
      const read = terminals.read(agent, sessionId, {
        offset: 0,
        count: TERMINAL_ROLLING_WINDOW_BYTES,
      });
      const text = sanitize(read?.text ?? "", replacements);
      const streamTrace = terminalReadTrace(
        { ...read, text },
        backendType,
        "public-visible",
      );
      const noisyIndex = text.indexOf("NOISY_BG");
      const promptIndex = streamTrace.promptIndices[0] ?? -1;
      const contextIndex = noisyIndex >= 0 && promptIndex >= 0
        ? Math.min(noisyIndex, promptIndex)
        : Math.max(noisyIndex, promptIndex);
      const context = contextIndex >= 0
        ? text.slice(Math.max(0, contextIndex - 120), contextIndex + 500)
        : text.slice(-620);
      observation.reads.push({
        sessionId,
        ...streamTrace,
        streamTrace,
        hasNoisyBackground: noisyIndex >= 0,
        hasVisiblePrompt: promptIndex >= 0,
        hasControlledPrompt: streamTrace.observationMode !== "public-visible"
          && promptIndex >= 0,
        noisyIndex,
        controlledPromptIndex: promptIndex,
        context,
      });
    } catch (error) {
      observation.observationErrors.push("terminals.read(" + String(sessionId) + "): " + sanitize(error));
    }
  }
  return observation;
}

async function observePublicTerminalCall(promise, terminals, agent, options = {}) {
  const intervalMs = options.intervalMs ?? 250;
  const maxMs = options.maxMs ?? 12_500;
  const startedAt = Date.now();
  const observations = [];
  const settled = Promise.resolve(promise).then(
    (value) => ({ status: "fulfilled", value }),
    (error) => ({ status: "rejected", error: thrownErrorSummary(error) }),
  );
  let outcome;
  let observerDeadlineExceeded = false;
  while (Date.now() - startedAt < maxMs) {
    observations.push({
      at: Date.now(),
      elapsedMs: Date.now() - startedAt,
      observation: publicTerminalObservation(
        terminals,
        agent,
        options.replacements ?? [],
        options.backendType ?? "wsl",
      ),
    });
    outcome = await Promise.race([
      settled,
      new Promise((resolveResult) => setTimeout(resolveResult, intervalMs, undefined)),
    ]);
    if (outcome !== undefined) break;
  }
  if (outcome === undefined) {
    observerDeadlineExceeded = true;
    outcome = {
      status: "observer-timeout",
      error: {
        name: "TimeoutError",
        code: "TEST_OBSERVER_TIMEOUT",
        message: `public terminal observer exceeded ${maxMs}ms`,
      },
    };
  }
  if (outcome?.status === "fulfilled" || outcome?.status === "rejected") {
    observations.push({
      at: Date.now(),
      elapsedMs: Date.now() - startedAt,
      phase: "settled-final",
      observation: publicTerminalObservation(
        terminals,
        agent,
        options.replacements ?? [],
        options.backendType ?? "wsl",
      ),
    });
  }
  return {
    startedAt,
    endedAt: Date.now(),
    intervalMs,
    maxMs,
    observerDeadlineExceeded,
    outcome,
    observations,
  };
}

function resultSucceeded(summary, marker = undefined) {
  return summary?.parsedExitCode === 0
    && summary?.isError !== true
    && summary?.error === null
    && summary?.timedOut !== true
    && summary?.aborted !== true
    && (marker === undefined || summary.output.includes(marker));
}

function naturalNoisyPrepareSucceeded(summary) {
  return summary?.parsedExitCode === 0
    && summary?.isError !== true
    && summary?.error === null
    && summary?.timedOut !== true
    && summary?.aborted !== true
    && summary?.output.includes("natural-noisy-prepared");
}

function xtermProtocolProbeSummary(summary) {
  const output = String(summary?.output ?? "");
    const field = (name) => new RegExp(`(?:^|[\\s])${name}=([^\\s\\r\\n]*)`, "m").exec(output)?.[1] ?? null;
  const rawHex = field("xterm-probe-raw-hex");
  const dsrHex = field("xterm-probe-dsr-hex");
  const daHex = field("xterm-probe-da-hex");
  const dsrReplyShape = typeof dsrHex === "string"
    && /^1b5b3[1-9](?:3[0-9])*3b3[1-9](?:3[0-9])*52$/i.test(dsrHex);
  const daReplyShape = typeof daHex === "string"
    && /^1b5b3f3[0-9](?:3[0-9])*(?:(?:3b|3e)3[0-9](?:3[0-9])*)*63$/i.test(daHex);
  const sttyRestored = output.includes("xterm-probe-stty-restored=1");
  const actualExit0 = summary?.parsedExitCode === 0
    && summary?.isError !== true
    && summary?.error === null
    && summary?.timedOut !== true
    && summary?.aborted !== true
    && summary?.shellExited !== true
    && output.includes("xterm-probe-ok");
  return {
    requestHex: field("xterm-probe-request-hex"),
    rawHex,
    rawEscaped: field("xterm-probe-raw-escaped"),
    dsrHex,
    dsrEscaped: field("xterm-probe-dsr-escaped"),
    daHex,
    daEscaped: field("xterm-probe-da-escaped"),
    dsrReplyShape,
    daReplyShape,
    sttyRestored,
    shellExited: summary?.shellExited ?? null,
    actualExit0,
    ok: actualExit0 && sttyRestored && dsrReplyShape && daReplyShape,
  };
}

function wrapXtermProbeInSubshell(command) {
  return `( ${String(command)} )`;
}

function officialPersistentTimeoutText(summary, timeoutMs) {
  const seconds = Math.round(timeoutMs / 1_000);
  const output = String(summary?.output ?? "");
  return output.startsWith(`Your command timed out after ${seconds} seconds or experienced an OOM error. Below is partial output:`)
    && output.includes("[Command timed out or OOM]")
    && output.includes("The persistent bash shell was reset; the next bash call starts from the workspace with a fresh current directory and environment.");
}

function thrownErrorSummary(error) {
  return {
    name: typeof error?.name === "string" ? error.name : null,
    code: typeof error?.code === "string" ? error.code : null,
    message: sanitize(error?.message ?? error),
  };
}

async function awaitBounded(promise, timeoutMs, label) {
  let timer;
  const outcome = await Promise.race([
    Promise.resolve(promise).then(
      (value) => ({ status: "fulfilled", value }),
      (error) => ({ status: "rejected", error: thrownErrorSummary(error) }),
    ),
    new Promise((resolveResult) => {
      timer = setTimeout(() => resolveResult({
        status: "timeout",
        error: {
          name: "TimeoutError",
          code: "TEST_TIMEOUT",
          message: `${label} exceeded ${timeoutMs}ms`,
        },
      }), timeoutMs);
    }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
  return outcome;
}

async function runBoundedOwnedTool(service, name, agent, args, timeoutMs, label) {
  const controller = new AbortController();
  let call;
  try {
    call = executeOwnedTool(service, name, agent, args, { signal: controller.signal });
  } catch (error) {
    return {
      controller,
      initial: { status: "rejected", error: thrownErrorSummary(error) },
      afterAbort: null,
      timedOut: false,
    };
  }
  const initial = await awaitBounded(call, timeoutMs, label);
  if (initial.status !== "timeout") {
    return { controller, initial, afterAbort: null, timedOut: false };
  }
  controller.abort(new DOMException(`${label} test deadline`, "AbortError"));
  const afterAbort = await awaitBounded(call, 5_000, `${label} abort settlement`);
  return { controller, initial, afterAbort, timedOut: true };
}

async function disposeOwnedHandleBounded(handle, label, timeoutMs = 15_000) {
  if (typeof handle?.dispose !== "function") {
    return {
      status: "rejected",
      error: { name: "TypeError", code: "TEST_DISPOSE_API", message: `${label} has no dispose API` },
    };
  }
  let call;
  try {
    call = handle.dispose();
  } catch (error) {
    return { status: "rejected", error: thrownErrorSummary(error) };
  }
  return await awaitBounded(call, timeoutMs, label);
}

async function shutdownBounded(shutdown, label, timeoutMs = 15_000) {
  if (typeof shutdown?.shutdown !== "function") return { status: "fulfilled", value: null };
  let call;
  try {
    call = shutdown.shutdown(0);
  } catch (error) {
    return { status: "rejected", error: thrownErrorSummary(error) };
  }
  return await awaitBounded(call, timeoutMs, label);
}

async function settleObservedHandleResults(results, timeoutMs = 5_000) {
  const raceWithDeadline = async (promise, label) => {
    let timer;
    try {
      return await Promise.race([
        Promise.resolve(promise),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`${label} deadline exceeded`)), timeoutMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
  const settle = async (result) => {
    const handle = await raceWithDeadline(result, "native handle resolution");
    let done = null;
    if (handle?.done !== undefined) {
      done = await raceWithDeadline(handle.done, "native handle done");
    }
    const waitForExit = typeof handle?.waitForExit === "function"
      ? await raceWithDeadline(handle.waitForExit(), "native handle waitForExit")
      : null;
    return { done, waitForExit };
  };
  return Promise.allSettled(results.map((result) => settle(result)));
}

async function waitForNativeHandleBatchQuiescence(events, baselineCount, quietMs = 250, maxMs = 3_000) {
  const startedAt = Date.now();
  let lastCount = Array.isArray(events) ? events.length : 0;
  let stableSince = startedAt;
  while (Date.now() - startedAt < maxMs) {
    const count = Array.isArray(events) ? events.length : 0;
    if (count !== lastCount) {
      lastCount = count;
      stableSince = Date.now();
    }
    if (Date.now() - stableSince >= quietMs) {
      return {
        baselineCount,
        finalCount: count,
        lateCount: Math.max(0, count - baselineCount),
        quietMs,
        maxMs,
        quiescent: true,
        elapsedMs: Date.now() - startedAt,
      };
    }
    await new Promise((resolveResult) => setTimeout(resolveResult, 25));
  }
  const finalCount = Array.isArray(events) ? events.length : 0;
  return {
    baselineCount,
    finalCount,
    lateCount: Math.max(0, finalCount - baselineCount),
    quietMs,
    maxMs,
    quiescent: false,
    elapsedMs: Date.now() - startedAt,
  };
}

function nativeHandleEventEvidence(events) {
  return (Array.isArray(events) ? events : []).map((event) => ({
    batchIndex: event?.batchIndex ?? null,
    method: event?.methodName ?? null,
    pid: event?.spawnEntry?.pid ?? null,
    capability: event?.capability === undefined || event?.capability === null
      ? null
      : { ...event.capability },
  }));
}

function boundedManagedSettlementsClean(settlements) {
  return Array.isArray(settlements)
    && settlements.length > 0
    && settlements.every((entry) => entry?.status === "fulfilled"
      && entry.value?.done !== null
      && entry.value?.done !== undefined
      && entry.value?.waitForExit === true);
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `\'"'"'`)}'`;
}

function shellPathForMode(modeId, windowsPath) {
  const match = /^([A-Za-z]):[\\/](.*)$/s.exec(String(windowsPath));
  if (match?.[1] === undefined) throw new Error(`cannot map Windows path to ${modeId} shell: ${windowsPath}`);
  const rest = match[2].replaceAll("\\", "/");
  return modeId === "bash-git-bash"
    ? `${match[1].toUpperCase()}:/${rest}`
    : `/mnt/${match[1].toLowerCase()}/${rest}`;
}

function windowsProcessSnapshot() {
  if (process.platform !== "win32") return { available: false, rows: [], error: "Windows process ledger requires win32" };
  const script = "$rows=Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CreationDate,Name,ExecutablePath,CommandLine; $rows | ConvertTo-Json -Compress";
  try {
    const text = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3_000,
      maxBuffer: 4 * 1024 * 1024,
    }).trim();
    if (text.length === 0) {
      return { available: false, rows: [], observationError: "Win32 process query returned empty output" };
    }
    const value = JSON.parse(text);
    return { available: true, rows: Array.isArray(value) ? value : [value] };
  } catch (error) {
    return {
      available: false,
      rows: [],
      observationError: sanitize(error),
      timedOut: error?.code === "ETIMEDOUT" || error?.killed === true,
    };
  }
}

function processIdentity(row) {
  const pid = Number(row?.ProcessId);
  const creation = String(row?.CreationDate ?? "");
  return Number.isSafeInteger(pid) && pid > 0 && creation.length > 0 ? `${pid}:${creation}` : null;
}

function processCreationTimeMs(row) {
  const match = /^\/Date\((\d+)(?:[+-]\d+)?\)\/$/.exec(String(row?.CreationDate ?? ""));
  return match === null ? null : Number(match[1]);
}

function processTreeRows(snapshot, rootPids) {
  const rows = Array.isArray(snapshot?.rows) ? snapshot.rows : [];
  const byParent = new Map();
  for (const row of rows) {
    const parent = Number(row?.ParentProcessId);
    const children = byParent.get(parent) ?? [];
    children.push(row);
    byParent.set(parent, children);
  }
  const result = [];
  const seen = new Set();
  const queue = rootPids.map(Number).filter((pid) => Number.isSafeInteger(pid) && pid > 0);
  while (queue.length > 0) {
    const pid = queue.shift();
    if (seen.has(pid)) continue;
    seen.add(pid);
    const row = rows.find((candidate) => Number(candidate?.ProcessId) === pid);
    if (row !== undefined) result.push(row);
    for (const child of byParent.get(pid) ?? []) queue.push(Number(child?.ProcessId));
  }
  return result;
}

function sanitizeProcessRows(rows, replacements = []) {
  return (Array.isArray(rows) ? rows : []).map((row) => ({
    identity: processIdentity(row),
    pid: Number(row?.ProcessId) || null,
    parentPid: Number(row?.ParentProcessId) || null,
    name: typeof row?.Name === "string" ? row.Name : null,
    executablePath: typeof row?.ExecutablePath === "string" ? sanitize(row.ExecutablePath, replacements) : null,
    commandLine: typeof row?.CommandLine === "string" ? sanitize(row.CommandLine, replacements) : null,
  }));
}

function capabilitySkip(value) {
  return /(?:ENOENT|not found|not installed|could not locate|unavailable|missing.*(?:WSL|Git Bash|bwrap|script))/i.test(String(value?.message ?? value?.failure?.message ?? value?.stderr?.text ?? value ?? ""));
}

async function loadChildRuntime(runtimeDir) {
  const importPackage = (packageName, fileName) => import(pathToFileURL(join(runtimeDir, "node_modules", "@deepseek-ai", packageName, "lib", fileName)).href);
  const [boot, dsh, systemPrompt] = await Promise.all([
    importPackage("dsh-app-boot", "index.js"),
    import(pathToFileURL(join(runtimeDir, "node_modules", "@deepseek-ai", "dsh", "lib", "profile-boot.js")).href),
    importPackage("dsh-system-prompt", "index.js"),
  ]);
  return { boot, dsh, systemPrompt };
}

async function readOfficialStandard(installAnchor) {
  const hostRequire = createRequire(installAnchor);
  const registryRequire = createRequire(hostRequire.resolve("@deepseek-ai/dsh-agent-preset-registry"));
  const include = await import(pathToFileURL(registryRequire.resolve("@deepseek-ai/cordis-plugin-include")).href);
  const yaml = registryRequire("js-yaml");
  const patchPath = hostRequire.resolve("@deepseek-ai/dsh-web-app/presets/standard.patch.yml");
  const patch = yaml.load(readFileSync(patchPath, "utf8"), { schema: include.entryListSchema });
  if (!Array.isArray(patch)) throw new Error("official standard.patch.yml is not an entry-list patch");
  const rows = patch.flatMap((item) => item && typeof item === "object" && Array.isArray(item.insert) ? item.insert : []);
  const standard = rows.find((row) => row && row.name === "@deepseek-ai/dsh-agent-preset" && row.config?.id === "standard");
  if (!Array.isArray(standard?.config?.plugins)) throw new Error("official Standard preset row was not found");
  return { plugins: standard.config.plugins, yaml, include, patchPath };
}

function findRows(rows, predicate, output = []) {
  if (!Array.isArray(rows)) return output;
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    if (predicate(row)) output.push(row);
    if (row.group === true && Array.isArray(row.config)) findRows(row.config, predicate, output);
  }
  return output;
}

function rowId(row) {
  return typeof row?.id === "string" ? row.id : null;
}

function schemaNames(service, scope = undefined) {
  return typeof service?.schemas === "function" ? service.schemas(scope).map((schema) => schema.name) : [];
}

function toolFingerprint(service, name, scope = undefined) {
  const tool = service?.get?.(name, scope);
  if (tool === undefined) return { exists: false };
  return {
    exists: true,
    constructor: tool?.constructor?.name ?? null,
    keys: Object.keys(tool),
    name: typeof tool?.name === "string" ? tool.name : null,
    description: typeof tool?.description === "string" ? tool.description : null,
    executeSha256: typeof tool?.execute === "function" ? sha256Bytes(String(tool.execute)) : null,
    presentResultSha256: typeof tool?.presentResult === "function" ? sha256Bytes(String(tool.presentResult)) : null,
  };
}

async function waitFor(predicate, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolveResult) => setTimeout(resolveResult, 50));
  }
  return await predicate();
}

let toolCallSequence = 0;

async function executeOwnedTool(service, name, agent, args, options = {}) {
  // The public host pipeline is the only execution path that applies the
  // selected Agent's scope, permission guard, post-execute policy, and result
  // projection.  `get(name, agent).execute(...)` is a lower-level seam and
  // deliberately not used as evidence for mode dispatch.
  if (typeof service?.execute !== "function") throw new Error(`scoped ToolRuntime.execute is unavailable for ${name}`);
  const controller = options.signal === undefined ? new AbortController() : undefined;
  const callId = `desktop-new-mode-${name}-${process.pid}-${++toolCallSequence}`;
  return service.execute({
    name,
    arguments: args,
    agent,
    callId,
    signal: options.signal ?? controller.signal,
  });
}

function profileFilesSnapshot(profile) {
  const files = ["package.json", "cordis.yml", "cordis.patch.yml", "pnpm-workspace.yaml"];
  return Object.fromEntries(files.map((name) => {
    const path = join(profile, name);
    return [name, existsSync(path) ? { sha256: sha256(path), bytes: statSync(path).size } : null];
  }));
}

function installedDistIdentity(profile, packageAudit) {
  const sourceDistHashes = packageAudit?.sourceDistHashes ?? {};
  const installedDistHashes = {};
  const missing = [];
  for (const relativeName of Object.keys(sourceDistHashes)) {
    const path = join(profile, "node_modules", PLUGIN_ROW_NAME, relativeName);
    if (!existsSync(path) || !statSync(path).isFile()) {
      missing.push(relativeName);
      continue;
    }
    installedDistHashes[relativeName] = sha256(path);
  }
  const mismatches = Object.keys(sourceDistHashes).filter((relativeName) =>
    installedDistHashes[relativeName] !== sourceDistHashes[relativeName]);
  return {
    sourceDistHashes,
    installedDistHashes,
    missing,
    mismatches,
    match: missing.length === 0 && mismatches.length === 0
      && Object.keys(sourceDistHashes).length > 0,
  };
}

async function runFocusedGitNoisyExit({
  modeId,
  modeTools,
  handle,
  workspace,
  modeTerminals,
  nativeSpawns,
  terminalSnapshots,
  nativeStdoutObservers,
  nativeStdoutDiscoveryObservers,
  nativeStdoutAllObservers,
  nativeStdoutObserverAttempts,
  nativeHandleEvents,
  evidence,
}) {
  let noisyMarkerPath;
  let noisyDiagnosticPath;
  appendCheckDiagnostic({ type: "begin", id: `${modeId}:natural-exit-noisy-background`, modeId, focused: true });
  try {
    noisyMarkerPath = join(workspace, `.dsh-native-${modeId}-noisy-${process.pid}.marker`);
    noisyDiagnosticPath = join(workspace, `.dsh-native-${modeId}-noisy-${process.pid}.log`);
    rmSync(noisyMarkerPath, { force: true });
    rmSync(noisyDiagnosticPath, { force: true });
    const noisyMarkerShell = shellQuote(shellPathForMode(modeId, noisyMarkerPath));
    const noisyDiagnosticShell = shellQuote(shellPathForMode(modeId, noisyDiagnosticPath));
    const captureObserverEvidence = () => {
      const snapshots = (nativeStdoutAllObservers ?? [])
        .map((observer) => observer.snapshot());
      const rawTraces = snapshots.map((entry) => entry.streamTrace).filter(Boolean);
      return {
        snapshots,
        terminalSnapshots: (nativeStdoutObservers ?? [])
          .map((observer) => observer.snapshot()),
        discoverySnapshots: (nativeStdoutDiscoveryObservers ?? [])
          .map((observer) => observer.snapshot()),
        observerAttempts: (nativeStdoutObserverAttempts ?? [])
          .map(stdoutObserverAttemptSnapshot),
        observerErrors: observerErrorsFromAttempts(nativeStdoutObserverAttempts),
        rawTraces,
        frameCandidates: rawTraces
          .flatMap((trace) => frameContractsFromTrace(trace)),
      };
    };
    const processBeforeNoisy = windowsProcessSnapshot();
    const xtermProbeCommand = wrapXtermProbeInSubshell([
      "saved_stty=$(stty -g 2>/dev/null); save_status=$?",
      "if [ \"$save_status\" -ne 0 ] || [ -z \"$saved_stty\" ]; then printf 'xterm-probe-stty-save-fail\\n'; exit 90; fi",
      "restore_stty() { stty \"$saved_stty\" >/dev/null 2>&1; }",
      "trap restore_stty EXIT HUP INT TERM",
      "setup_status=0; stty -icanon -echo min 0 time 1 >/dev/null 2>&1 || setup_status=$?",
      "raw=''; dsr=''; da=''",
      "if [ \"$setup_status\" -eq 0 ]; then printf '\\033[6n\\033[c'; dsr_re=$'\\033''\\[[1-9][0-9]*;[1-9][0-9]*R'; da_re=$'\\033''\\[\\?[0-9]+(;[0-9]+)*c'; for ((i=0; i<30; i++)); do ch=''; if IFS= read -r -N 1 -t 0.1 ch; then raw+=\"$ch\"; fi; if [[ -z \"$dsr\" && \"$raw\" =~ $dsr_re ]]; then dsr=\"${BASH_REMATCH[0]}\"; fi; if [[ -z \"$da\" && \"$raw\" =~ $da_re ]]; then da=\"${BASH_REMATCH[0]}\"; fi; if [[ -n \"$dsr\" && -n \"$da\" ]]; then break; fi; done; fi",
      "restore_status=0; restore_stty || restore_status=$?; trap - EXIT HUP INT TERM",
      "raw_hex=$(printf '%s' \"$raw\" | od -An -tx1 -v | tr -d '[:space:]'); dsr_hex=$(printf '%s' \"$dsr\" | od -An -tx1 -v | tr -d '[:space:]'); da_hex=$(printf '%s' \"$da\" | od -An -tx1 -v | tr -d '[:space:]')",
      "printf 'xterm-probe-request-hex=1b5b366e1b5b63\\n'; printf 'xterm-probe-raw-hex=%s\\n' \"$raw_hex\"; printf 'xterm-probe-raw-escaped='; printf '%q' \"$raw\"; printf '\\n'; printf 'xterm-probe-dsr-hex=%s\\n' \"$dsr_hex\"; printf 'xterm-probe-dsr-escaped='; printf '%q' \"$dsr\"; printf '\\n'; printf 'xterm-probe-da-hex=%s\\n' \"$da_hex\"; printf 'xterm-probe-da-escaped='; printf '%q' \"$da\"; printf '\\n'",
      "if [ \"$restore_status\" -eq 0 ]; then printf 'xterm-probe-stty-restored=1\\n'; else printf 'xterm-probe-stty-restored=0\\n'; fi",
      "if [ \"$setup_status\" -eq 0 ] && [ \"$restore_status\" -eq 0 ] && [ -n \"$dsr\" ] && [ -n \"$da\" ]; then printf 'xterm-probe-ok\\n'; exit 0; else printf 'xterm-probe-fail setup=%s restore=%s dsr=%s da=%s\\n' \"$setup_status\" \"$restore_status\" \"${#dsr}\" \"${#da}\"; exit 91; fi",
    ].join("; "));
    let protocolCall;
    let protocolCallError = null;
    try {
      protocolCall = await executeOwnedTool(modeTools, "bash", handle.agent, {
        command: xtermProbeCommand,
      });
    } catch (error) {
      protocolCallError = sanitize(error);
    }
    const protocolSummary = protocolCallError === null
      ? persistentResultSummary(protocolCall)
      : {
        resultType: "thrown",
        isError: true,
        error: protocolCallError,
        parsedExitCode: null,
        timedOut: null,
        aborted: null,
        output: "",
      };
    const protocolResult = xtermProtocolProbeSummary(protocolSummary);
    const protocolEvidence = {
      prerequisite: true,
      requests: ["ESC[6n", "ESC[c"],
      commandExitError: protocolCallError,
      result: protocolSummary,
      parsed: protocolResult,
      rawStdoutTrace: captureObserverEvidence(),
    };
    appendCheckDiagnostic({
      type: "checkpoint",
      id: `${modeId}:natural-exit-noisy-background`,
      phase: "xterm-protocol",
      status: protocolResult.ok ? "PASS" : "FAIL",
      evidence: protocolEvidence,
    });
    if (!protocolResult.ok) {
      const protocolFailureEvidence = {
        focused: true,
        protocol: protocolEvidence,
        prepare: null,
        prepareContract: null,
        naturalExit: null,
        naturalExitClock: null,
        reset: null,
        processLedger: {
          available: processBeforeNoisy.available === true,
          observationErrors: processBeforeNoisy.observationError
            ? [processBeforeNoisy.observationError]
            : [],
          identityBinding: {
            performed: false,
            reason: "DSR/DA protocol prerequisite failed; noisy prepare was not started",
          },
        },
        noisyOk: false,
      };
      addCheck(evidence, `${modeId}:natural-exit-noisy-background`, "FAIL",
        "host xterm DSR/DA protocol prerequisite failed; noisy prepare was skipped",
        protocolFailureEvidence);
      appendCheckDiagnostic({
        type: "checkpoint",
        id: `${modeId}:natural-exit-noisy-background`,
        phase: "xterm-protocol-failed",
        status: "FAIL",
        detail: "DSR/DA reply failure is retained; prepare skipped",
        evidence: protocolFailureEvidence,
      });
      rmSync(noisyMarkerPath, { force: true });
      rmSync(noisyDiagnosticPath, { force: true });
      return {
        available: false,
        protocol: protocolEvidence,
        observationError: "host xterm DSR/DA protocol prerequisite failed",
        observationErrors: ["host xterm DSR/DA protocol prerequisite failed"],
      };
    }
    appendCheckDiagnostic({ type: "checkpoint", id: `${modeId}:natural-exit-noisy-background`, phase: "prepare-begin" });
    const prepareStartedAt = Date.now();
    const noisyPrepare = await executeOwnedTool(modeTools, "bash", handle.agent, {
      command: [
        `printf 'noisy-started\\n' > ${noisyDiagnosticShell}`,
        `(i=0; while [ \"$i\" -lt 400 ]; do printf 'NATIVE_NOISY_BG\\n'; i=$((i+1)); sleep 0.02; done; printf 'noisy-ticks=400\\n' >> ${noisyDiagnosticShell}; printf 'noisy-delayed-marker\\n' > ${noisyMarkerShell}) & noisy_bg_pid=$!`,
        "noisy_shell_winpid=$(cat /proc/$$/winpid 2>/dev/null | tr -d '[:space:]'); if [ -z \"$noisy_shell_winpid\" ]; then noisy_shell_winpid=$(ps -p $$ -o winpid= 2>/dev/null | tr -d '[:space:]'); fi",
        "noisy_bg_winpid=$(cat /proc/$noisy_bg_pid/winpid 2>/dev/null | tr -d '[:space:]'); if [ -z \"$noisy_bg_winpid\" ]; then noisy_bg_winpid=$(ps -p $noisy_bg_pid -o winpid= 2>/dev/null | tr -d '[:space:]'); fi",
        "printf 'natural-noisy-live shell_pid=%s shell_winpid=%s bg_pid=%s bg_winpid=%s\\n' \"$$\" \"$noisy_shell_winpid\" \"$noisy_bg_pid\" \"$noisy_bg_winpid\"",
        "printf 'natural-noisy-prepared\\n'",
      ].join("; "),
    });
    const prepareEndedAt = Date.now();
    const prepareSummary = persistentResultSummary(noisyPrepare);
    const prepareObserverEvidence = captureObserverEvidence();
    const prepareHandleEvidence = {
      capturedAt: "prepare-end",
      count: Array.isArray(nativeHandleEvents) ? nativeHandleEvents.length : 0,
      events: nativeHandleEventEvidence(nativeHandleEvents),
    };
    appendCheckDiagnostic({
      type: "checkpoint",
      id: `${modeId}:natural-exit-noisy-background`,
      phase: "prepare-end",
      result: prepareSummary,
      rawStdoutTrace: prepareObserverEvidence,
      nativeHandleBatch: prepareHandleEvidence,
    });
    if (!naturalNoisyPrepareSucceeded(prepareSummary)) {
      const prepareDiagnostic = existsSync(noisyDiagnosticPath)
        ? readFileSync(noisyDiagnosticPath, "utf8")
        : "";
      const prepareMarkerCreated = existsSync(noisyMarkerPath);
      const prepareFrame = /natural-noisy-live shell_pid=(\d+) shell_winpid=(\d*) bg_pid=(\d+) bg_winpid=(\d*)/
        .exec(prepareSummary.output);
      const prepareFailureRootPids = prepareFrame === null ? [] : [
        prepareFrame[2] === "" ? null : Number(prepareFrame[2]),
        prepareFrame[4] === "" ? null : Number(prepareFrame[4]),
      ].filter((pid) => Number.isSafeInteger(pid) && pid > 0);
      const prepareFailureLedger = {
        available: processBeforeNoisy.available === true,
        observationErrors: processBeforeNoisy.observationError
          ? [processBeforeNoisy.observationError]
          : [],
        frame: prepareFrame === null ? null : {
          shellPid: Number(prepareFrame[1]),
          shellWinPid: prepareFrame[2] === "" ? null : Number(prepareFrame[2]),
          backgroundPid: Number(prepareFrame[3]),
          backgroundWinPid: prepareFrame[4] === "" ? null : Number(prepareFrame[4]),
        },
        identityBinding: {
          performed: false,
          reason: "prepare did not return an actual parsed exit-0 result; no post-reset PID snapshot was used",
        },
        beforeRows: sanitizeProcessRows(
          processTreeRows(processBeforeNoisy, prepareFailureRootPids),
          [[workspace, "<workspace>"]],
        ),
        noisyDiagnostic: sanitize(prepareDiagnostic, [[workspace, "<workspace>"]]),
        markerCreated: prepareMarkerCreated,
        afterNaturalExitRows: [],
        afterDelayRows: [],
        remaining: [],
      };
      const prepareFailureEvidence = {
        focused: true,
        protocol: protocolEvidence,
        prepare: prepareSummary,
        prepareContract: {
          acceptedOutcome: "actual-parsed-exit-0-required",
          actualParsedExitCode: prepareSummary.parsedExitCode,
          actualExit0: false,
          officialTimeoutText: officialPersistentTimeoutText(prepareSummary, 10_000),
          timeoutMs: 10_000,
          startedAt: prepareStartedAt,
          endedAt: prepareEndedAt,
          naturalExitSkipped: true,
        },
        rawStdoutTrace: prepareObserverEvidence,
        nativeHandleBatch: prepareHandleEvidence,
        naturalExit: null,
        naturalExitClock: null,
        reset: null,
        processLedger: prepareFailureLedger,
        noisyDiagnostic: sanitize(prepareDiagnostic, [[workspace, "<workspace>"]]),
        markerCreated: prepareMarkerCreated,
        noisyOutputObserved: prepareSummary.output.includes("NATIVE_NOISY_BG"),
        noisyOk: false,
      };
      addCheck(evidence, `${modeId}:natural-exit-noisy-background`, "FAIL",
        "noisy prepare did not return an actual parsed exit-0 frame; natural-exit/reset and post-window PID snapshots were skipped",
        prepareFailureEvidence);
      appendCheckDiagnostic({
        type: "checkpoint",
        id: `${modeId}:natural-exit-noisy-background`,
        phase: "prepare-failed",
        status: "FAIL",
        detail: "actual parsed exit-0 required; natural-exit/reset skipped",
        rawStdoutTrace: prepareObserverEvidence,
        nativeHandleBatch: prepareHandleEvidence,
      });
      rmSync(noisyMarkerPath, { force: true });
      rmSync(noisyDiagnosticPath, { force: true });
      return prepareFailureLedger;
    }
    const processAfterPrepare = windowsProcessSnapshot();
    await new Promise((resolveResult) => setTimeout(resolveResult, 500));
    appendCheckDiagnostic({ type: "checkpoint", id: `${modeId}:natural-exit-noisy-background`, phase: "natural-exit-begin" });
    const naturalStartedAt = Date.now();
    const noisyNatural = await executeOwnedTool(modeTools, "bash", handle.agent, {
      command: "printf 'natural-noisy-shell-end\\n'; exit 0",
    });
    const naturalEndedAt = Date.now();
    appendCheckDiagnostic({ type: "checkpoint", id: `${modeId}:natural-exit-noisy-background`, phase: "natural-exit-end", result: persistentResultSummary(noisyNatural) });
    const noisyReset = await executeOwnedTool(modeTools, "bash", handle.agent, {
      command: "printf 'natural-noisy-reset\\n'",
    });
    const noisyNaturalSummary = persistentResultSummary(noisyNatural);
    const noisyResetSummary = persistentResultSummary(noisyReset);
    const processAfterNoisyExit = windowsProcessSnapshot();
    const noisyOutput = prepareSummary.output;
    const noisyFrame = /natural-noisy-live shell_pid=(\d+) shell_winpid=(\d*) bg_pid=(\d+) bg_winpid=(\d*)/.exec(noisyOutput);
    const noisyLinuxFramePids = noisyFrame === null ? [] : [Number(noisyFrame[1]), Number(noisyFrame[3])];
    const noisyNativeWindowsPids = noisyFrame === null ? [] : [noisyFrame[2], noisyFrame[4]]
      .filter((pid) => pid.length > 0).map(Number);
    const noisyRootPids = [
      ...noisyNativeWindowsPids.filter((pid) => Number.isSafeInteger(pid) && pid > 0),
      ...nativeSpawns.map((entry) => Number(entry.pid)).filter((pid) => Number.isSafeInteger(pid) && pid > 0),
      ...terminalSnapshots.map((entry) => Number(entry.pid)).filter((pid) => Number.isSafeInteger(pid) && pid > 0),
    ];
    const noisyInitialRows = processTreeRows(processBeforeNoisy, noisyRootPids);
    const noisyPrepareRows = processTreeRows(processAfterPrepare, noisyRootPids);
    const prepareIdentityRows = noisyPrepareRows.filter((row) =>
      noisyNativeWindowsPids.includes(Number(row?.ProcessId)));
    const identityBindingRows = new Map(prepareIdentityRows.map((row) => [
      Number(row?.ProcessId),
      processCreationTimeMs(row),
    ]));
    const identityBindingOk = processAfterPrepare.available === true
      && noisyNativeWindowsPids.length > 0
      && noisyNativeWindowsPids.every((pid) => identityBindingRows.has(pid)
        && Number.isSafeInteger(identityBindingRows.get(pid))
        && identityBindingRows.get(pid) <= prepareEndedAt);
    const noisyIdentities = [...new Set([...noisyInitialRows, ...noisyPrepareRows]
      .map((row) => processIdentity(row)).filter((identity) => identity !== null))];
    const noisyAfterExitRows = processAfterNoisyExit.rows.filter((row) =>
      noisyIdentities.includes(processIdentity(row)));
    appendCheckDiagnostic({ type: "checkpoint", id: `${modeId}:natural-exit-noisy-background`, phase: "marker-window-begin", delayMs: 10_000 });
    const markerWindowStartedAt = Date.now();
    await new Promise((resolveResult) => setTimeout(resolveResult, 10_000));
    const markerWindowEndedAt = Date.now();
    const noisyMarkerCreated = existsSync(noisyMarkerPath);
    const noisyDiagnostic = existsSync(noisyDiagnosticPath) ? readFileSync(noisyDiagnosticPath, "utf8") : "";
    const noisyAfterDelay = windowsProcessSnapshot();
    const noisyRemaining = noisyAfterDelay.rows.filter((row) => noisyIdentities.includes(processIdentity(row)));
    const noisyOk = naturalNoisyPrepareSucceeded(prepareSummary)
      && prepareSummary.output.includes("NATIVE_NOISY_BG")
      && resultSucceeded(noisyNaturalSummary, "natural-noisy-shell-end")
      && noisyNaturalSummary.shellExited === true
      && noisyNaturalSummary.parsedExitCode === 0
      && noisyFrame !== null
      && noisyLinuxFramePids.every((pid) => Number.isSafeInteger(pid) && pid > 0)
      && noisyNativeWindowsPids.length > 0
      && noisyNativeWindowsPids.every((pid) => Number.isSafeInteger(pid) && pid > 0)
      && processBeforeNoisy.available === true
      && identityBindingOk
      && processAfterNoisyExit.available === true
      && noisyAfterDelay.available === true
      && noisyIdentities.length > 0
      && noisyDiagnostic.includes("noisy-started")
      && noisyMarkerCreated === false
      && !noisyDiagnostic.includes("noisy-delayed-marker")
      && noisyRemaining.length === 0
      && resultSucceeded(noisyResetSummary, "natural-noisy-reset");
    const processLedger = {
      available: processBeforeNoisy.available && processAfterPrepare.available
        && processAfterNoisyExit.available && noisyAfterDelay.available,
      observationErrors: [processBeforeNoisy, processAfterPrepare,
        processAfterNoisyExit, noisyAfterDelay]
        .map((snapshot) => snapshot.observationError).filter(Boolean),
      frame: noisyFrame === null ? null : {
        shellPid: Number(noisyFrame[1]),
        shellWinPid: noisyFrame[2] === "" ? null : Number(noisyFrame[2]),
        backgroundPid: Number(noisyFrame[3]),
        backgroundWinPid: noisyFrame[4] === "" ? null : Number(noisyFrame[4]),
        linuxFramePids: noisyLinuxFramePids,
        nativeWindowsPids: noisyNativeWindowsPids,
      },
      identityBinding: {
        performed: true,
        frameObservedInPrepare: noisyFrame !== null,
        frameOperationEndedAt: prepareEndedAt,
        nativeWindowsPids: noisyNativeWindowsPids,
        creationTimeMs: Object.fromEntries(identityBindingRows),
        creationTimeBeforeFrameOperationEnd: identityBindingOk,
        rows: sanitizeProcessRows(prepareIdentityRows, [[workspace, "<workspace>"]]),
      },
      ownedIdentityCount: noisyIdentities.length,
      beforeRows: sanitizeProcessRows(noisyInitialRows, [[workspace, "<workspace>"]]),
      duringPrepareRows: sanitizeProcessRows(noisyPrepareRows, [[workspace, "<workspace>"]]),
      afterNaturalExitRows: sanitizeProcessRows(noisyAfterExitRows, [[workspace, "<workspace>"]]),
      afterDelayRows: sanitizeProcessRows(noisyRemaining, [[workspace, "<workspace>"]]),
      noisyDiagnostic: sanitize(noisyDiagnostic, [[workspace, "<workspace>"]]),
      markerCreated: noisyMarkerCreated,
      delayedMarkerCreated: noisyMarkerCreated,
      naturalOwnedIdentities: noisyIdentities,
      remaining: sanitizeProcessRows(noisyRemaining, [[workspace, "<workspace>"]]),
    };
    const noisyEvidence = {
      focused: true,
        protocol: protocolEvidence,
      prepare: prepareSummary,
      prepareContract: {
        acceptedOutcome: "actual-parsed-exit-0",
        actualParsedExitCode: prepareSummary.parsedExitCode,
        actualExit0: naturalNoisyPrepareSucceeded(prepareSummary),
        timeoutMs: 10_000,
        startedAt: prepareStartedAt,
        endedAt: prepareEndedAt,
      },
      rawStdoutTrace: captureObserverEvidence(),
      nativeHandleBatch: {
        capturedAt: "after-natural-exit",
        count: Array.isArray(nativeHandleEvents) ? nativeHandleEvents.length : 0,
        events: nativeHandleEventEvidence(nativeHandleEvents),
      },
      naturalExit: noisyNaturalSummary,
      naturalExitClock: { startedAt: naturalStartedAt, endedAt: naturalEndedAt },
      reset: noisyResetSummary,
      markerWindowClock: { startedAt: markerWindowStartedAt, endedAt: markerWindowEndedAt, requiredMs: 10_000 },
      processLedger,
      noisyOutputObserved: prepareSummary.output.includes("NATIVE_NOISY_BG"),
      noisyOk,
    };
    addCheck(evidence, `${modeId}:natural-exit-noisy-background`, noisyOk ? "PASS" : "FAIL",
      noisyOk ? "Git Bash natural exit reaped continuous noisy background output and its delayed marker-window identities"
        : "Git Bash natural exit did not prove continuous noisy background reaping",
      noisyEvidence);
    appendCheckDiagnostic({ type: "checkpoint", id: `${modeId}:natural-exit-noisy-background`, phase: "marker-window-end", status: noisyOk ? "PASS" : "FAIL" });
    rmSync(noisyMarkerPath, { force: true });
    rmSync(noisyDiagnosticPath, { force: true });
    return processLedger;
  } catch (error) {
    if (noisyMarkerPath !== undefined) rmSync(noisyMarkerPath, { force: true });
    if (noisyDiagnosticPath !== undefined) rmSync(noisyDiagnosticPath, { force: true });
    addCheck(evidence, `${modeId}:natural-exit-noisy-background`, "FAIL", "continuous noisy natural-exit probe threw", {
      focused: true,
      error: sanitize(error),
      observationError: sanitize(error),
    });
    appendCheckDiagnostic({ type: "checkpoint", id: `${modeId}:natural-exit-noisy-background`, phase: "error", status: "FAIL", error: sanitize(error) });
    return { available: false, observationError: sanitize(error), observationErrors: [sanitize(error)] };
  }
}

async function enabledChildMain(argv) {
  const [runtimeDir, profileDir, pnpm, nodeBin, evidencePath, workspace, diagnosticPath, permissionMode, scope, onlyCheck] = argv;
  configureCheckDiagnostics(diagnosticPath, [
    [runtimeDir, "<runtime>"],
    [profileDir, "<profile>"],
    [workspace, "<workspace>"],
  ]);
  appendCheckDiagnostic({ type: "child-start", phase: "enabled", scope: scope ?? null, onlyCheck: onlyCheck ?? null });
  const minimalEnabled = scope === "startup-native";
  const diagnosticAdvanced = scope === "wsl-advanced" || scope === "git-advanced";
  const diagnosticMode = scope === "wsl-advanced" || scope === "git-advanced" ? scope : null;
  const focusedNoisyOnly = onlyCheck === "bash-git-bash:natural-exit-noisy-background";
  const checks = [];
  const evidence = { schemaVersion: 1, phase: "enabled", runtime: "installed Desktop app.asar/dsh", checks };
  const agents = [];
  let application;
  let shutdown;
  let pluginFiber;
  let retainedAgent;
  let retainedHandle;
  try {
    const { boot, dsh, systemPrompt } = await loadChildRuntime(runtimeDir);
    const installAnchor = join(runtimeDir, "node_modules", "@deepseek-ai", "dsh", "package.json");
    const standard = await readOfficialStandard(installAnchor);
    const installedPrompt = await import(pathToFileURL(join(profileDir, "node_modules", PLUGIN_ROW_NAME, "dist", "prompt.js")).href);
    const installedPromptTexts = {
      "bash-wsl": installedPrompt.BASH_WSL_SYSTEM_PROMPT,
      "bash-git-bash": installedPrompt.GIT_BASH_SYSTEM_PROMPT,
    };
    const standardFlat = flattenRows(standard.plugins);
    const standardNames = standardFlat.map((row) => row.name).filter((name) => typeof name === "string");
    const standardDocHash = sha256Bytes(JSON.stringify(standard.plugins));
    const port = await reserveLocalPort();
    const bootstrapEnv = {
      DSH_CLIENT_VERSION: EXPECTED_DESKTOP_VERSION,
      DSH_TELEMETRY_DISABLED: "1",
      DSH_PRODUCT_ANALYTICS_OTLP_URL: "http://127.0.0.1:1/v1/logs",
      DSH_PERMISSION_MODE: permissionMode || "workspace-write",
    };
    const profile = boot.loadProfileDirectory("dsh", profileDir, installAnchor);
    const started = await dsh.runProfile({
      environment: boot.loadLayeredEnv("dsh"),
      profile: "desktop",
      resolvedProfile: { profile, installAnchor },
      patchFiles: [],
      args: ["--no-open", "--port", String(port)],
      packageManager: {
        command: process.execPath,
        args: ["--expose-internals", pnpm],
        env: {
          ELECTRON_RUN_AS_NODE: "1",
          DSH_DESKTOP_NODE_EXECUTABLE: process.execPath,
          ...bootstrapEnv,
          PATH: `${dirname(nodeBin)}${delimiter}${process.env.PATH ?? ""}`,
        },
      },
    });
    application = started;
    shutdown = started.shutdown;
    const { ctx } = started;
    const profileContext = ctx.get("profileContext");
    addCheck(evidence, "host-anchor", profileContext?.installAnchor === installAnchor ? "PASS" : "FAIL",
      profileContext?.installAnchor === installAnchor ? "Desktop context uses the app.asar DSH install anchor" : "Desktop context anchor differs from app.asar", {
        expected: "app.asar/dsh/node_modules/@deepseek-ai/dsh/package.json",
        observedBasename: String(profileContext?.installAnchor ?? "").split(/[\\/]/).at(-1) ?? null,
      });
    const presets = ctx.get("agentPresets");
    const tools = ctx.get("tools");
    const loader = ctx.get("loader");
    const pluginEntry = loader?.entries?.().find((entry) => entry.options?.name === PLUGIN_ROW_NAME || entry.options?.id === "bash-wsl-backend-and-tools");
    pluginFiber = pluginEntry?.fiber;
    // The terminal registry is intentionally supplied by the plugin's own
    // injected scope.  It is not a root Desktop service in rc.2; mode scopes
    // receive their own isolated terminal registry as well.
    const terminals = ctx.get("terminals") ?? pluginFiber?.ctx?.get?.("terminals");
    const prompts = ctx.get("systemPrompt");
    const permissions = ctx.get("permissionPresets");
    const servicePresence = {
      agentPresets: presets !== undefined,
      tools: tools !== undefined,
      terminals: terminals !== undefined,
      systemPrompt: prompts !== undefined,
      permissionPresets: permissions !== undefined,
    };
    addCheck(evidence, "official-service-presence", Object.values(servicePresence).every(Boolean) ? "PASS" : "FAIL",
      Object.values(servicePresence).every(Boolean) ? "mode audit has all required official Desktop services" : "mode audit is missing one or more official Desktop services",
      servicePresence);
    if (!Object.values(servicePresence).every(Boolean)) throw new Error(`Desktop context is missing an official service: ${JSON.stringify(servicePresence)}`);
    const initialDefault = presets.defaultId;
    const initialRoster = await presets.remoteExportList();
    const initialStandard = await presets.readDocument("standard");
    const initialStandardParsed = standard.yaml.load(initialStandard.content, { schema: standard.include.entryListSchema });
    const initialStandardHash = sha256Bytes(JSON.stringify(initialStandardParsed));
    const registeredModes = await waitFor(async () => {
      const roster = await presets.remoteExportList();
      return EXPECTED_MODE_IDS.every((id) => roster.presets.some((row) => row.id === id)) ? roster : undefined;
    });
    const modeRoster = registeredModes ?? await presets.remoteExportList();
    const rosterIds = modeRoster.presets.map((row) => row.id);
    const modeRows = Object.fromEntries(EXPECTED_MODE_IDS.map((id) => [id, modeRoster.presets.find((row) => row.id === id) ?? null]));
    addCheck(evidence, "mode-roster", registeredModes !== undefined ? "PASS" : "FAIL",
      registeredModes !== undefined ? "both native mode definitions are visible in the real Desktop roster" : "one or more native modes did not register in the real Desktop roster", {
        ids: rosterIds,
        rows: modeRows,
        duplicateIds: rosterIds.filter((id, index) => rosterIds.indexOf(id) !== index),
      });
    addCheck(evidence, "default-unchanged", initialDefault === "standard" && modeRoster.presets.filter((row) => row.isDefault).map((row) => row.id).join() === "standard" ? "PASS" : "FAIL",
      initialDefault === "standard" ? "native modes did not replace the selected default" : "native mode registration changed the selected default", {
        defaultBefore: initialDefault,
        defaultAfter: modeRoster.presets.filter((row) => row.isDefault).map((row) => row.id),
      });
    addCheck(evidence, "standard-doc-unchanged-before", initialStandardHash === standardDocHash ? "PASS" : "FAIL",
      initialStandardHash === standardDocHash ? "live standard declaration matches the host standard.patch.yml" : "live standard declaration differs from the host standard.patch.yml", {
        hostStandardSha256: standardDocHash,
        liveStandardSha256: initialStandardHash,
        standardPatchPath: "app.asar/dsh/node_modules/@deepseek-ai/dsh-web-app/presets/standard.patch.yml",
      });
    const rootToolNames = schemaNames(tools);
    const standardHasPwsh = standardNames.includes("@deepseek-ai/dsh-tool-pwsh");
    addCheck(evidence, "pwsh-preserved-root", standardHasPwsh ? "PASS" : "FAIL",
      standardHasPwsh ? "official Standard composition retains the PowerShell row" : "official Standard composition is missing the PowerShell row", { observedRootToolNames: rootToolNames, standardHasPwsh });
    addCheck(evidence, "plugin-fiber-visible", pluginFiber !== undefined ? "PASS" : "FAIL",
      pluginFiber !== undefined ? "the live loader exposes the owned plugin fiber" : "could not locate the live plugin fiber for unload evidence", {
        entryId: pluginEntry?.options?.id ?? null,
        entryName: pluginEntry?.options?.name ?? null,
        fiberState: pluginFiber?.state ?? null,
      });

    const modeAudits = {};
    const modeIds = diagnosticMode === "wsl-advanced"
      ? ["bash-wsl"]
      : diagnosticMode === "git-advanced"
        ? ["bash-git-bash"]
        : EXPECTED_MODE_IDS;
    for (const modeId of modeIds) {
      appendCheckDiagnostic({ type: "mode-begin", modeId, scope: scope ?? null });
      const mode = await presets.resolve(modeId);
      const document = await presets.readDocument(modeId);
      const rows = standard.yaml.load(document.content, { schema: standard.include.entryListSchema });
      const flat = flattenRows(rows);
      const flatNames = flat.map((row) => row.name).filter((name) => typeof name === "string");
      const modeOwnedRows = new Set([PLUGIN_ROW_NAME, PERSISTENT_ROW_NAME, "@deepseek-ai/dsh-terminal"]);
      const expectedNonStock = standardNames.filter((name) => name !== STOCK_BASH_ROW);
      const rowPreservesStandard = sameMultiset(flatNames.filter((name) => !modeOwnedRows.has(name)), expectedNonStock.filter((name) => !modeOwnedRows.has(name)));
      const pluginRows = findRows(rows, (row) => row.name === PLUGIN_ROW_NAME);
      const persistentRows = findRows(rows, (row) => row.name === PERSISTENT_ROW_NAME);
      const groupRows = findRows(rows, (row) => row.group === true && row.isolate?.terminals === true);
      const nativeModeGroups = findRows(rows, (row) => isNativeModeGroup(row));
      const modeTreeWithoutNative = withoutNativeModeGroup(rows);
      const standardTreeWithoutStock = withoutStockBash(standard.plugins);
      const deepConfigMatch = JSON.stringify(modeTreeWithoutNative) === JSON.stringify(standardTreeWithoutStock);
      const jsNodeCountMatch = countJsNodes(modeTreeWithoutNative) === countJsNodes(standardTreeWithoutStock);
      const modePluginConfig = pluginRows.find((row) => row.config && typeof row.config === "object" && !Array.isArray(row.config))?.config;
      const expectedBackendType = modeId === "bash-git-bash" ? "git-bash" : "wsl";
      const persistentConfig = persistentRows.length === 1
        && persistentRows[0].config
        && typeof persistentRows[0].config === "object"
        && !Array.isArray(persistentRows[0].config)
        ? persistentRows[0].config
        : null;
      const configOk = modePluginConfig?.registerModes === false
        && modePluginConfig?.backendType === expectedBackendType
        && modePluginConfig?.persistentShell === expectedBackendType;
      const timeoutConfigOk = modePluginConfig?.timeoutMs === TEST_PERSISTENT_TIMEOUT_MS
        && persistentConfig?.timeoutMs === TEST_PERSISTENT_TIMEOUT_MS
        && persistentConfig?.backendType === expectedBackendType;
      const stockBashRemoved = !flatNames.includes(STOCK_BASH_ROW);
      const standardMode = mode.id === modeId && modeRoster.presets.find((row) => row.id === modeId)?.name === EXPECTED_MODE_NAMES[modeId];
      modeAudits[modeId] = {
        mode,
        documentHash: sha256Bytes(JSON.stringify(rows)),
        flatNames,
        standardNames,
        rowPreservesStandard,
        stockBashRemoved,
        pluginRows: pluginRows.length,
        persistentRows: persistentRows.length,
        persistentConfigs: persistentRows.map((row) => row.config ?? null),
        isolatedTerminalGroups: groupRows.length,
        nativeModeGroups: nativeModeGroups.length,
        deepConfigMatch,
        jsNodeCountMode: countJsNodes(modeTreeWithoutNative),
        jsNodeCountStandard: countJsNodes(standardTreeWithoutStock),
        jsNodeCountMatch,
        config: modePluginConfig ?? null,
        persistentConfig,
        expectedBackendType,
        timeoutConfigOk,
        configOk,
      };
      addCheck(evidence, `${modeId}:standard-composition`, standardMode && rowPreservesStandard && deepConfigMatch && jsNodeCountMatch && stockBashRemoved && pluginRows.length === 1 && persistentRows.length === 1 && nativeModeGroups.length === 1 && configOk ? "PASS" : "FAIL",
        standardMode && rowPreservesStandard && deepConfigMatch && jsNodeCountMatch && stockBashRemoved && pluginRows.length === 1 && persistentRows.length === 1 && nativeModeGroups.length === 1 && configOk
          ? "mode composition preserves the official Standard rows, replaces stock Bash, and isolates terminals"
          : "mode composition does not match the official Standard comparison or recursion guard", modeAudits[modeId]);
      const agentService = ctx.get("agents");
      if (!agentService?.create) throw new Error("official agents.create is unavailable");
      let handle = await agentService.create({
        sessionId: `desktop-new-mode-${modeId}-${process.pid}`,
        meta: { cwd: workspace, agentPreset: modeId },
        agentOptions: { provider: "desktop-new-mode-probe", model: "desktop-new-mode-probe" },
        setup: async (agentCtx) => { await presets.mount(agentCtx, modeId); },
      });
      agents.push(handle);
      if (!handle?.agent || typeof handle.dispose !== "function") throw new Error(`${modeId} agent factory returned no owned handle`);
      let modeTools = presets.serviceFor(handle.agent, "tools") ?? handle.agent.ctx.get("tools");
      let modeTerminals = presets.serviceFor(handle.agent, "terminals") ?? handle.agent.ctx.get("terminals");
      const modePrompt = handle.agent.ctx.get("systemPrompt") ?? prompts;
      const agentContextTools = handle.agent.ctx.get("tools");
      const agentContextTerminals = handle.agent.ctx.get("terminals");
      const bashTool = modeTools?.get?.("bash", handle.agent);
      const selectedBackend = modeTerminals?.backends?.get?.(modeId === "bash-git-bash" ? "git-bash" : "wsl");
        const rootSubprocess = ctx.get("subprocess");
        const agentSubprocess = handle.agent.ctx.get("subprocess");
        const modeTerminalSubprocess = modeTerminals?.ctx?.get?.("subprocess")
          ?? modeTerminals?.ctx?.subprocess;
        const backendContext = selectedBackend?.ctx;
        const backendSubprocess = backendContext?.get?.("subprocess")
          ?? backendContext?.subprocess;
        const subprocessIdentity = (service) => ({
          available: service !== undefined && typeof service?.spawn === "function",
          constructor: service?.constructor?.name ?? null,
          spawnSha256: typeof service?.spawn === "function"
            ? sha256Bytes(String(service.spawn))
            : null,
        });
      const selectedBackendPrototype = selectedBackend === undefined ? undefined : Object.getPrototypeOf(selectedBackend);
      const serviceIdentity = {
        modeToolsMatchesAgentContext: modeTools === agentContextTools,
        modeTerminalsMatchesAgentContext: modeTerminals === agentContextTerminals,
        modeTerminalBackends: modeTerminals?.listBackends?.() ?? [],
        agentContextTerminalBackends: agentContextTerminals?.listBackends?.() ?? [],
        bashToolConstructor: bashTool?.constructor?.name ?? null,
        bashToolKeys: bashTool === undefined ? [] : Object.keys(bashTool),
        selectedBackendConstructor: selectedBackend?.constructor?.name ?? null,
        selectedBackendPrototypeMethods: selectedBackendPrototype === undefined ? [] : Object.getOwnPropertyNames(selectedBackendPrototype),
        selectedBackendSpawnSha256: typeof selectedBackend?.spawn === "function" ? sha256Bytes(String(selectedBackend.spawn)) : null,
          subprocessProviders: {
            root: subprocessIdentity(rootSubprocess),
            agentContext: subprocessIdentity(agentSubprocess),
            modeTerminalContext: subprocessIdentity(modeTerminalSubprocess),
            selectedBackendContext: subprocessIdentity(backendSubprocess),
            selectedBackendContextAvailable: backendContext !== undefined,
            selectedBackendSubprocessMatchesRoot: backendSubprocess === rootSubprocess,
            selectedBackendSubprocessMatchesAgentContext: backendSubprocess === agentSubprocess,
            selectedBackendSubprocessMatchesModeTerminalContext: backendSubprocess === modeTerminalSubprocess,
          },
      };
      const modeSchemas = schemaNames(modeTools, handle.agent);
      const requiredModeTools = ["bash", "wsl_bash", "git_bash"];
      const schemasOk = requiredModeTools.every((name) => modeSchemas.includes(name));
      const expectedBackendName = modeAudits[modeId].expectedBackendType;
      const availableBackendNames = typeof modeTerminals?.listBackends === "function"
        ? modeTerminals.listBackends()
        : [];
      const mountedAgent = presets.composedPreset(handle.agent.ctx) === modeId;
      const selectedBackendConfigTimeoutMs = selectedBackend?.config?.timeoutMs ?? null;
      const persistentToolPublicConfigTimeoutMs = bashTool?.config?.timeoutMs ?? null;
      const timeoutConfigEvidence = {
        expectedTimeoutMs: TEST_PERSISTENT_TIMEOUT_MS,
        modeConfigTimeoutMs: modeAudits[modeId].config?.timeoutMs ?? null,
        persistentToolConfigTimeoutMs: modeAudits[modeId].persistentConfig?.timeoutMs ?? null,
        modeConfigBackendType: modeAudits[modeId].config?.backendType ?? null,
        persistentToolConfigBackendType: modeAudits[modeId].persistentConfig?.backendType ?? null,
        expectedBackendType: expectedBackendName,
        selectedBackendPresent: selectedBackend !== undefined,
        selectedBackendConfigTimeoutMs,
        availableBackendNames,
        scopedBashToolPresent: bashTool !== undefined,
        persistentToolPublicConfigTimeoutMs,
        persistentToolConfigSource: "mounted profile persistent row; public Bash tool config may be unavailable",
        scopedAgentMounted: mountedAgent,
      };
      const mountedTimeoutConfigOk = modeAudits[modeId].timeoutConfigOk
        && selectedBackend !== undefined
        && selectedBackendConfigTimeoutMs === TEST_PERSISTENT_TIMEOUT_MS
        && availableBackendNames.includes(expectedBackendName)
        && bashTool !== undefined
        && mountedAgent;
      addCheck(evidence, `${modeId}:timeout-config`, mountedTimeoutConfigOk ? "PASS" : "FAIL",
        mountedTimeoutConfigOk
          ? "the mounted mode Agent, scoped Bash tool, and selected backend all use the test-only 10s timeout"
          : "the mounted mode Agent/backend/tool timeout configuration was not the test-only 10s value",
        timeoutConfigEvidence);
      if (!mountedTimeoutConfigOk) continue;
      let promptOk = false;
      let promptEvidence;
      let promptSchemaHasPwsh = false;
      if (typeof prompts.assemble === "function") {
        const assembly = await prompts.assemble({ agent: handle.agent, scope: handle.agent });
        const promptSections = assembly.sections.filter((entry) => entry.name === PROMPT_SECTION);
        const section = promptSections[0];
        const rendered = typeof systemPrompt.renderPrompt === "function" ? systemPrompt.renderPrompt(assembly) : "";
        const expectedHeader = modeId === "bash-wsl" ? /WSL/ : /Git Bash/;
        promptSchemaHasPwsh = assembly.tools.some((schema) => schema.name === "pwsh");
        const expectedPromptText = installedPromptTexts[modeId];
        const exactInstalledText = typeof expectedPromptText === "string" && section?.text === expectedPromptText;
        const oppositeHeaderAbsent = modeId === "bash-wsl"
          ? !String(section?.text ?? "").includes(installedPromptTexts["bash-git-bash"] ?? "__missing_git_prompt__")
          : !String(section?.text ?? "").includes(installedPromptTexts["bash-wsl"] ?? "__missing_wsl_prompt__");
        promptOk = promptSections.length === 1 && section?.interpolate === false && exactInstalledText && expectedHeader.test(String(section.text)) && oppositeHeaderAbsent && rendered.includes(PLUGIN_ROW_NAME) && promptSchemaHasPwsh;
        promptEvidence = {
          sectionCount: promptSections.length,
          sectionPresent: section !== undefined,
          interpolate: section?.interpolate ?? null,
          exactInstalledText,
          oppositeHeaderAbsent,
          expectedPromptTextSha256: typeof expectedPromptText === "string" ? sha256Bytes(expectedPromptText) : null,
          hasModeHeader: section === undefined ? false : expectedHeader.test(String(section.text)),
          renderedPluginMarker: rendered.includes(PLUGIN_ROW_NAME),
          promptSchemaHasPwsh,
          schemaNames: assembly.tools.map((schema) => schema.name),
          sectionTextSha256: section === undefined ? null : sha256Bytes(String(section.text)),
        };
      }
      addCheck(evidence, `${modeId}:agent-mount-and-schemas`, presets.composedPreset(handle.agent.ctx) === modeId && schemasOk ? "PASS" : "FAIL",
        presets.composedPreset(handle.agent.ctx) === modeId && schemasOk ? "official Agent mounts the selected mode and exposes persistent/one-shot Bash plus pwsh" : "selected mode did not mount or expose the required tool schemas", {
          composedPreset: presets.composedPreset(handle.agent.ctx),
          schemaNames: modeSchemas,
          required: [...requiredModeTools, "pwsh (official prompt assembly)"],
          serviceIdentity,
          prompt: promptEvidence ?? null,
        });
      addCheck(evidence, `${modeId}:system-prompt`, promptOk ? "PASS" : "FAIL",
        promptOk ? "mode-specific literal system prompt is assembled by the official scoped service" : "mode-specific prompt section/header was not observed", promptEvidence);

      const permissionBefore = typeof permissions.current === "function" ? permissions.current(handle.agent.session) : null;
      const terminalBackendsBefore = typeof modeTerminals?.listBackends === "function" ? modeTerminals.listBackends() : [];
      let resolvedPolicyBefore = null;
      try {
        const policy = ctx.get("sandboxPolicy");
        resolvedPolicyBefore = policy?.resolve?.({ session: handle.agent.session })?.mode ?? null;
      } catch (error) {
        resolvedPolicyBefore = `error:${sanitize(error)}`;
      }
      let backendPolicyBefore = null;
      try {
        const backend = modeTerminals?.backends?.get?.(modeId === "bash-git-bash" ? "git-bash" : "wsl");
        backendPolicyBefore = backend?.ctx?.sandboxPolicy?.resolve?.({ session: handle.agent.session })?.mode ?? null;
      } catch (error) {
        backendPolicyBefore = `error:${sanitize(error)}`;
      }
      let bashResult;
      let spawnDelta = null;
      const observedSubprocessServices = [...new Set([
        ctx.get("subprocess"),
        handle.agent.ctx.get("subprocess"),
        modeTerminals?.ctx?.subprocess,
        selectedBackend?.ctx?.subprocess,
      ])].filter((service) => service !== undefined);
      const originalSpawnMethods = [];
      let spawnCount = 0;
      const nativeSpawns = [];
      const nativeSpawnHandles = [];
      const nativeHandleCapabilities = [];
      const nativeHandleEvents = [];
      const nativeStdoutObservers = [];
        const nativeStdoutDiscoveryObservers = [];
        const nativeStdoutAllObservers = [];
        const nativeStdoutObserverAttempts = [];
        const observedStdoutStreams = new WeakMap();
      const observerInstallErrors = [];
      for (const service of observedSubprocessServices) {
        for (const methodName of ["spawn", "spawnTerminal"]) {
          const original = service[methodName];
          if (typeof original !== "function") continue;
          try {
              service[methodName] = function observedNativeSpawn(...args) {
              spawnCount += 1;
              const request = args[0] ?? {};
                const result = Reflect.apply(original, this, args);
              nativeSpawnHandles.push(result);
                const observationScope = stdoutObservationScope(request, expectedBackendName);
                const stdoutObserver = instrumentPublicStdout(result, observedStdoutStreams, expectedBackendName, observationScope);
                recordStdoutObserverAttempt(
                  stdoutObserver,
                  nativeStdoutObserverAttempts,
                  nativeStdoutObservers,
                  nativeStdoutDiscoveryObservers,
                  nativeStdoutAllObservers,
                );
              const capability = {
                hasDone: result?.done !== undefined,
                hasWaitForExit: typeof result?.waitForExit === "function",
                hasTerminate: typeof result?.terminate === "function",
                hasControl: result?.control !== undefined,
              };
              nativeHandleCapabilities.push(capability);
              const spawnEntry = {
                method: methodName,
                argv: Array.isArray(request.argv) ? request.argv.map((value) => String(value)).slice(0, 80) : null,
                cwd: typeof request.cwd === "string" ? request.cwd : null,
                pid: result?.pid ?? result?.processId ?? null,
              };
              nativeSpawns.push(spawnEntry);
              nativeHandleEvents.push({
                batchIndex: nativeHandleEvents.length,
                methodName,
                result,
                capability,
                spawnEntry,
              });
              // rc.2 may return a thenable handle whose public lifecycle methods
              // only exist after the native process is ready.  Resolve it here so
              // the evidence describes the actual public handle, not Promise
              // shape or the initial ConPTY pid=0 placeholder.
              Promise.resolve(result).then((resolved) => {
                  const resolvedStdoutObserver = instrumentPublicStdout(resolved, observedStdoutStreams, expectedBackendName, observationScope);
                  recordStdoutObserverAttempt(
                    resolvedStdoutObserver,
                    nativeStdoutObserverAttempts,
                    nativeStdoutObservers,
                    nativeStdoutDiscoveryObservers,
                    nativeStdoutAllObservers,
                  );
                capability.hasDone ||= resolved?.done !== undefined;
                capability.hasWaitForExit ||= typeof resolved?.waitForExit === "function";
                capability.hasTerminate ||= typeof resolved?.terminate === "function";
                capability.hasControl ||= resolved?.control !== undefined;
                spawnEntry.pid ??= resolved?.pid ?? resolved?.processId ?? null;
              }).catch((error) => {
                capability.resolveError = sanitize(error);
              });
              return result;
            };
            originalSpawnMethods.push({ service, methodName, original });
          } catch (error) {
            observerInstallErrors.push(`${methodName}:${sanitize(error)}`);
          }
        }
      }
      const observerInstalled = originalSpawnMethods.length > 0 && observerInstallErrors.length === 0;
        let backgroundEvidenceRecord = null;
        let backgroundCheckRecord = null;
      try {
        if (modeId === "bash-git-bash" && permissionBefore !== "danger-full-access") {
          let denied = false;
          let directSpawnError;
          let directSpawnResult;
          try {
            if (typeof modeTerminals?.spawn !== "function") throw new Error("official scoped terminal spawn API is unavailable");
            directSpawnResult = await modeTerminals.spawn(handle.agent, { type: "git-bash", cwd: workspace }, new AbortController().signal);
          } catch (error) {
            directSpawnError = sanitize(error);
            denied = /danger-full-access|permission|restricted|denied/i.test(directSpawnError);
          }
          if (directSpawnResult !== undefined) {
            try {
              if (directSpawnResult.sessionId !== undefined && typeof modeTerminals.kill === "function") {
                await modeTerminals.kill(handle.agent, directSpawnResult.sessionId, "new-mode unauthorized spawn regression cleanup");
              }
            } catch (error) {
              directSpawnError = `${directSpawnError ?? ""} cleanup=${sanitize(error)}`.trim();
            }
          }
          try {
            bashResult = await executeOwnedTool(modeTools, "bash", handle.agent, { command: "printf 'unexpected-git-shell\\n'" });
          } catch (error) {
            denied = /danger-full-access|permission|restricted|denied/i.test(String(error));
          }
          const bashFailureText = String(bashResult?.error?.message ?? bashResult?.error ?? textOf(bashResult));
          denied ||= bashResult?.sandbox?.denied === true
            || bashResult?.failure?.kind === "sandbox-denied"
            || (bashResult?.isError === true && /danger-full-access|permission|restricted|denied/i.test(bashFailureText));
          spawnDelta = spawnCount;
          const directDenied = typeof directSpawnError === "string" && /danger-full-access|permission|restricted|denied/i.test(directSpawnError);
          addCheck(evidence, `${modeId}:no-implicit-escalation`, observerInstalled && directDenied && directSpawnResult === undefined && spawnDelta === 0 ? "PASS" : "FAIL",
            observerInstalled && directDenied && directSpawnResult === undefined && spawnDelta === 0 ? "Git Bash persistent mode denied before spawn without changing the session permission" : "Git Bash mode either spawned or did not report the explicit permission denial", {
              permissionBefore,
              resolvedPolicyBefore,
              backendPolicyBefore,
              denied,
              directDenied,
              directSpawnError: directSpawnError ?? null,
              directSpawnedSession: directSpawnResult?.sessionId ?? null,
              spawnDelta,
              observerInstalled,
              observerInstallErrors,
              observedServiceCount: observedSubprocessServices.length,
              nativeSpawns: nativeSpawns.map((entry) => ({
                ...entry,
                argv: entry.argv?.map((value) => sanitize(value, [[workspace, "<workspace>"]])),
                cwd: typeof entry.cwd === "string" ? sanitize(entry.cwd, [[workspace, "<workspace>"]]) : null,
              })),
              result: bashResult === undefined ? null : {
                isError: bashResult.isError ?? null,
                exitCode: bashResult.exitCode ?? null,
                timedOut: bashResult.timedOut ?? null,
                aborted: bashResult.aborted ?? null,
                sandbox: bashResult.sandbox ?? null,
                failure: bashResult.failure ?? null,
                error: bashResult.error === undefined ? null : sanitize(bashResult.error),
                output: sanitize(textOf(bashResult)),
              },
            });
          // The denial attempt must be released before changing permission:
          // rc.2 correctly refuses a live persistent session mutation.  A
          // fresh owned Agent then proves the explicit danger retry path.
          try {
              const disposed = await disposeOwnedHandleBounded(handle, `${modeId}:restricted-agent-dispose`);
              if (disposed.status !== "fulfilled") {
                throw new Error(JSON.stringify(disposed.error));
              }
            const disposedIndex = agents.indexOf(handle);
            if (disposedIndex >= 0) agents.splice(disposedIndex, 1);
            if (typeof permissions.resolve !== "function" || typeof permissions.set !== "function") throw new Error("official permission preset mutation API is unavailable");
            await permissions.resolve("danger-full-access");
            const replacement = await agentService.create({
              sessionId: `desktop-new-mode-${modeId}-danger-${process.pid}`,
              meta: { cwd: workspace, agentPreset: modeId },
              agentOptions: { provider: "desktop-new-mode-probe", model: "desktop-new-mode-probe" },
              setup: async (agentCtx) => { await presets.mount(agentCtx, modeId); },
            });
            handle = replacement;
            agents.push(handle);
            await permissions.set(handle.agent.session, "danger-full-access");
            modeTools = presets.serviceFor(handle.agent, "tools") ?? handle.agent.ctx.get("tools");
            modeTerminals = presets.serviceFor(handle.agent, "terminals") ?? handle.agent.ctx.get("terminals");
          } catch (error) {
            addCheck(evidence, `${modeId}:danger-permission-setup`, "FAIL", "host could not explicitly select danger-full-access for a fresh Git Bash agent", { error: sanitize(error) });
          }
        }
        const permissionAfter = typeof permissions.current === "function" ? permissions.current(handle.agent.session) : null;
        if (modeId === "bash-git-bash") {
          addCheck(evidence, `${modeId}:standing-full-access`, permissionAfter === "danger-full-access" ? "PASS" : "FAIL",
            permissionAfter === "danger-full-access"
              ? "Git Bash persistent lifecycle is standing in the explicitly selected danger-full-access session"
              : "Git Bash persistent lifecycle did not retain the explicitly selected danger-full-access session",
            { permissionBefore, permissionAfter });
        }
        if (modeId === "bash-git-bash" && permissionAfter !== "danger-full-access") {
          addCheck(evidence, `${modeId}:native-lifecycle`, "SKIP", "danger-full-access could not be explicitly selected for the owned Git Bash agent", { permissionAfter });
        } else {
            appendCheckDiagnostic({
              type: "begin",
              id: `${modeId}:initial-persistent-calls`,
              modeId,
            });
            const positiveSpawnStart = spawnCount;
          bashResult = await executeOwnedTool(modeTools, "bash", handle.agent, { command: "export DSH_NEW_MODE_OWNER=owner-a; printf 'new-mode-owner-a\\n'" });
          const second = await executeOwnedTool(modeTools, "bash", handle.agent, { command: "if [ \"${DSH_NEW_MODE_OWNER-}\" = owner-a ]; then printf 'new-mode-owner-a-persisted\\n'; else printf 'new-mode-owner-lost\\n'; fi" });
            appendCheckDiagnostic({
              type: "end",
              id: `${modeId}:initial-persistent-calls`,
              modeId,
            });
          const positiveSpawnDelta = spawnCount - positiveSpawnStart;
          const output = `${textOf(bashResult)} ${textOf(second)}`;
          const firstResultSummary = persistentResultSummary(bashResult);
          const secondResultSummary = persistentResultSummary(second);
          const terminalActivity = modeTerminals?.hasOwnerActivity?.(handle.agent) === true;
          const terminalSnapshots = modeTerminals?.list?.(handle.agent)?.map((row) => ({
            sessionId: row.sessionId ?? row.id ?? null,
            type: row.type ?? row.backendType ?? null,
            status: row.status ?? null,
            pid: row.pid ?? row.processId ?? null,
          })) ?? [];
            const publicSessionObservation = publicTerminalObservation(
              modeTerminals,
              handle.agent,
              [[workspace, "<workspace>"]],
              expectedBackendName,
            );
            const publicSessionObserved = publicSessionObservation.listAvailable
              && publicSessionObservation.readAvailable
              && publicSessionObservation.snapshots.length > 0
              && publicSessionObservation.observationErrors.length === 0;
          let nativePtyEvidence;
          if (modeId === "bash-git-bash") {
            const positivePidRows = terminalSnapshots.filter((row) => Number.isSafeInteger(Number(row.pid)) && Number(row.pid) > 0);
            const helperSpawn = nativeSpawns.find((entry) => entry.method === "spawn"
              && Array.isArray(entry.argv)
              && entry.argv.some((value) => /pty-helper[.]js$/i.test(String(value))));
            const truePty = positivePidRows.some((row) => /git|pty/i.test(String(row.type ?? "")));
            const nativePid = positivePidRows[0]?.pid ?? null;
            nativePtyEvidence = {
              nativePid,
              positivePidRows,
              truePty,
              helperSpawn: helperSpawn ?? null,
              helperSpawnObserved: helperSpawn !== undefined,
            };
            addCheck(evidence, `${modeId}:native-pid-pty`, nativePid !== null && truePty && helperSpawn !== undefined ? "PASS" : "FAIL",
              nativePid !== null && truePty && helperSpawn !== undefined
                ? "Git Bash exposed a positive scoped PTY pid and the broker helper native spawn"
                : "Git Bash did not expose a positive scoped PTY pid plus broker helper native spawn",
              nativePtyEvidence);
          }
          let processLedgerEvidence;
          if (focusedNoisyOnly && modeId === "bash-git-bash") {
            processLedgerEvidence = await runFocusedGitNoisyExit({
              modeId,
              modeTools,
              handle,
              workspace,
              modeTerminals,
              nativeSpawns,
              terminalSnapshots,
              nativeStdoutObservers,
              nativeStdoutDiscoveryObservers,
              nativeStdoutAllObservers,
              nativeStdoutObserverAttempts,
              nativeHandleEvents,
              evidence,
            });
            for (const skippedId of [
              `${modeId}:background-process-cleanup`,
              `${modeId}:natural-exit-reset`,
              `${modeId}:natural-exit-delayed-background`,
              `${modeId}:timeout-reset`,
              `${modeId}:cancel-reset`,
              `${modeId}:cross-agent-isolation`,
            ]) {
              addCheck(evidence, skippedId, "SKIP", "test-only focused filter omitted this advanced lifecycle case");
            }
          }
          if (!minimalEnabled && !focusedNoisyOnly) {
          let backgroundEvidence;
          appendCheckDiagnostic({ type: "begin", id: `${modeId}:background-process-cleanup`, modeId });
          try {
            appendCheckDiagnostic({ type: "begin", id: `${modeId}:background-start`, modeId });
            let backgroundStart;
            let backgroundStartCallError;
            const publicTerminalObservations = [];
            const backgroundBaselinePublic = publicTerminalObservation(
              modeTerminals,
              handle.agent,
              [[workspace, "<workspace>"]],
              expectedBackendName,
            );
            const backgroundBaselinePublicTraces = backgroundBaselinePublic.reads
              .map((entry) => entry.streamTrace ?? entry)
              .filter((entry) => Array.isArray(entry?.frameStarts));
            const backgroundBaselineRawSnapshots = nativeStdoutObservers.map((observer) => observer.snapshot());
            const backgroundBaselineRawTraces = backgroundBaselineRawSnapshots
              .map((entry) => entry.streamTrace)
              .filter(Boolean);
            const backgroundBaselinePublicNonces = traceNonces(backgroundBaselinePublicTraces);
            const backgroundBaselineRawNonces = traceNonces(backgroundBaselineRawTraces);
              const backgroundStartController = new AbortController();
              const backgroundStartCall = executeOwnedTool(modeTools, "bash", handle.agent, {
              // Leave the owned background process alive after its finite noisy
              // burst so this case proves active kill/wait rather than natural
              // completion.  Natural continuous-noise reaping is covered by
              // the separate natural-exit-noisy-background case.
              command: "(i=0; while [ \"$i\" -lt 50 ]; do printf 'NOISY_BG\\n'; i=$((i+1)); sleep 0.01; done; sleep 30) & DSH_NEW_MODE_BG_PID=$!; export DSH_NEW_MODE_BG_PID; printf 'live-bg-started pid=%s\\n' \"$DSH_NEW_MODE_BG_PID\"",
              }, { signal: backgroundStartController.signal }).then(
              (result) => { backgroundStart = result; },
              (error) => { backgroundStartCallError = thrownErrorSummary(error); },
            );
            const backgroundObservation = await observePublicTerminalCall(
              backgroundStartCall,
              modeTerminals,
              handle.agent,
              {
                intervalMs: 250,
                maxMs: 12_500,
                backendType: expectedBackendName,
                replacements: [[workspace, "<workspace>"]],
              },
            );
            publicTerminalObservations.push({
              source: "official-terminals.read rolling64KiB snapshots",
              observerDeadlineExceeded: backgroundObservation.observerDeadlineExceeded,
              startedAt: backgroundObservation.startedAt,
              endedAt: backgroundObservation.endedAt,
              intervalMs: backgroundObservation.intervalMs,
              maxMs: backgroundObservation.maxMs,
              outcome: backgroundObservation.outcome,
              snapshots: backgroundObservation.observations,
            });
              if (backgroundObservation.observerDeadlineExceeded) {
                backgroundStartController.abort(new DOMException(
                  `${modeId} background observer deadline`,
                  "AbortError",
                ));
              }
              const backgroundStartSettled = await awaitBounded(
                backgroundStartCall,
                8_000,
                `${modeId}:background-start`,
              );
              if (backgroundStartSettled.status === "timeout") {
                backgroundStartCallError = backgroundStartSettled.error;
                backgroundStartController.abort(new DOMException(
                  `${modeId} background start test deadline`,
                  "AbortError",
                ));
              }
            appendCheckDiagnostic({ type: "end", id: `${modeId}:background-start`, modeId });
            appendCheckDiagnostic({ type: "begin", id: `${modeId}:background-stop`, modeId });
              let backgroundStop;
              let backgroundStopCallError;
              const backgroundStopController = new AbortController();
              const backgroundStopCall = executeOwnedTool(modeTools, "bash", handle.agent, {
              command: "bg_pid=\"${DSH_NEW_MODE_BG_PID-}\"; bg_jobs_before=$(jobs -p 2>/dev/null | tr '\\n' ' '); bg_job_present_before=0; case \" $bg_jobs_before \" in *\" $bg_pid \"*) bg_job_present_before=1;; esac; bg_alive_before=0; bg_kill_attempted=0; bg_kill_status=0; bg_wait_attempted=0; bg_wait_status=127; if [ -n \"$bg_pid\" ]; then if [ \"$bg_job_present_before\" = 1 ] && kill -0 \"$bg_pid\" 2>/dev/null; then bg_alive_before=1; kill \"$bg_pid\" 2>/dev/null; bg_kill_status=$?; bg_kill_attempted=1; fi; wait \"$bg_pid\" 2>/dev/null; bg_wait_status=$?; bg_wait_attempted=1; fi; bg_alive_after=0; if [ -n \"$bg_pid\" ] && kill -0 \"$bg_pid\" 2>/dev/null; then bg_alive_after=1; fi; bg_jobs_after=$(jobs -p 2>/dev/null | tr '\\n' ' '); printf 'bg-reaped pid=%s jobPresentBefore=%s aliveBefore=%s killAttempted=%s killStatus=%s waitAttempted=%s waitStatus=%s aliveAfter=%s jobsBefore=%s|jobsAfter=%s|\\n' \"$bg_pid\" \"$bg_job_present_before\" \"$bg_alive_before\" \"$bg_kill_attempted\" \"$bg_kill_status\" \"$bg_wait_attempted\" \"$bg_wait_status\" \"$bg_alive_after\" \"$bg_jobs_before\" \"$bg_jobs_after\"; unset DSH_NEW_MODE_BG_PID",
              }, { signal: backgroundStopController.signal }).then(
                (result) => { backgroundStop = result; },
                (error) => { backgroundStopCallError = thrownErrorSummary(error); },
              );
              const backgroundStopSettled = await awaitBounded(
                backgroundStopCall,
                8_000,
                `${modeId}:background-stop`,
              );
              if (backgroundStopSettled.status === "timeout") {
                backgroundStopCallError = backgroundStopSettled.error;
                backgroundStopController.abort(new DOMException(
                  `${modeId} background stop test deadline`,
                  "AbortError",
                ));
              }
              appendCheckDiagnostic({ type: "end", id: `${modeId}:background-stop`, modeId });
            const startSummary = persistentResultSummary(backgroundStart);
            const stopSummary = persistentResultSummary(backgroundStop);
            const startPidMatch = /live-bg-started pid=(\d+)/.exec(startSummary.output);
            const reapMatch = /bg-reaped pid=(\d+) jobPresentBefore=(\d+) aliveBefore=(\d+) killAttempted=(\d+) killStatus=(-?\d+) waitAttempted=(\d+) waitStatus=(-?\d+) aliveAfter=(\d+) jobsBefore=([^|]*)\|jobsAfter=([^|]*)\|/.exec(stopSummary.output);
            const backgroundReap = reapMatch === null ? null : {
              backgroundLinuxPid: Number(reapMatch[1]),
              jobPresentBefore: Number(reapMatch[2]),
              aliveBefore: Number(reapMatch[3]),
              killAttempted: Number(reapMatch[4]),
              killStatus: Number(reapMatch[5]),
              waitAttempted: Number(reapMatch[6]),
              waitStatus: Number(reapMatch[7]),
              aliveAfter: Number(reapMatch[8]),
              jobsBefore: reapMatch[9] ?? "",
              jobsAfter: reapMatch[10] ?? "",
              pidMatchesStart: startPidMatch !== null && Number(reapMatch[1]) === Number(startPidMatch[1]),
            };
            const backgroundReapOk = backgroundReap !== null
              && backgroundReap.pidMatchesStart
              && backgroundReap.jobPresentBefore === 1
              && backgroundReap.aliveBefore === 1
              && backgroundReap.killAttempted === 1
              && backgroundReap.killStatus === 0
              && backgroundReap.waitAttempted === 1
              && backgroundReap.waitStatus === 143
              && backgroundReap.aliveAfter === 0
              && !backgroundReap.jobsAfter.split(/\s+/).filter(Boolean).includes(String(backgroundReap.backgroundLinuxPid));
            const rollingSnapshots = publicTerminalObservations
              .flatMap((entry) => entry.snapshots ?? [])
              .flatMap((entry) => entry.observation?.reads ?? []);
            const rollingObservationErrors = publicTerminalObservations
              .flatMap((entry) => entry.snapshots ?? [])
              .flatMap((entry) => entry.observation?.observationErrors ?? []);
            const rawStdoutSnapshots = nativeStdoutObservers.map((observer) => observer.snapshot());
            const rawStdoutDiscoverySnapshots = nativeStdoutDiscoveryObservers.map((observer) => observer.snapshot());
            const rawStdoutObserverErrors = observerErrorsFromAttempts(nativeStdoutObserverAttempts);
            const rawStdoutObserverAttempts = nativeStdoutObserverAttempts.map(stdoutObserverAttemptSnapshot);
            const publicTraces = rollingSnapshots
              .map((entry) => entry.streamTrace ?? entry)
              .filter((entry) => Array.isArray(entry?.frameStarts));
            const rawTraces = rawStdoutSnapshots.map((entry) => entry.streamTrace).filter(Boolean);
            const publicFrameCandidates = publicTraces
              .flatMap((trace) => frameContractsFromTrace(trace, backgroundBaselinePublicNonces));
            const rawFrameCandidates = rawTraces
              .flatMap((trace) => frameContractsFromTrace(trace, backgroundBaselineRawNonces));
            const publicFreshFrame = selectFreshBackgroundFrame(publicTraces, backgroundBaselinePublicNonces);
            const rawFreshFrame = selectFreshBackgroundFrame(rawTraces, backgroundBaselineRawNonces);
            const rollingTraceObserved = publicFreshFrame !== null
              && publicFreshFrame.endObserved
              && publicFreshFrame.exitCode === 0
              && publicFreshFrame.promptAfterEnd === true;
            const rawStdoutTraceObserved = rawFreshFrame !== null
              && rawFreshFrame.endObserved
              && rawFreshFrame.exitCode === 0
              && rawFreshFrame.promptAfterEnd === true
              && rawFreshFrame.oscInFrame === true;
            const sameFreshFrameNonce = publicFreshFrame !== null
              && rawFreshFrame !== null
              && publicFreshFrame.nonce === rawFreshFrame.nonce;
            const rawNoisyAfterStart = rawFrameCandidates.some((frame) => frame.isNew && frame.noisyAfterStart);
            const publicNoisyAfterStart = publicFrameCandidates.some((frame) => frame.isNew && frame.noisyAfterStart);
            const noisyOutputObserved = rawNoisyAfterStart || publicNoisyAfterStart;
            const backgroundOk = backgroundStartCallError === undefined
              && backgroundStopCallError === undefined
              && resultSucceeded(startSummary, "live-bg-started")
              && resultSucceeded(stopSummary, "bg-reaped")
              && publicTerminalObservations.length > 0
              && backgroundBaselinePublic.observationErrors.length === 0
              && backgroundBaselineRawSnapshots.every((entry) => entry.error === null)
              && rawStdoutObserverErrors.length === 0
              && rollingObservationErrors.length === 0
              && backgroundReapOk
              && noisyOutputObserved
              && sameFreshFrameNonce
              && rollingTraceObserved
              && rawStdoutTraceObserved;
            backgroundEvidence = {
              start: startSummary,
              stop: stopSummary,
              timeoutOverrideMs: 10_000,
              startCallError: backgroundStartCallError ?? null,
              stopCallError: backgroundStopCallError ?? null,
              startBounded: backgroundStartSettled,
              stopBounded: backgroundStopSettled,
              publicTerminalObservations,
              backendType: expectedBackendName,
              baseline: {
                publicFrameNonces: [...backgroundBaselinePublicNonces],
                rawFrameNonces: [...backgroundBaselineRawNonces],
                publicObservationErrors: backgroundBaselinePublic.observationErrors,
                rawObserverErrors: rawStdoutObserverErrors,
                rawObserverAttemptStatuses: rawStdoutObserverAttempts.map((entry) => entry.attempt),
                rawTotalBytes: backgroundBaselineRawSnapshots.map((entry) => entry.totalBytes),
              },
              frameContracts: {
                publicFreshFrame,
                rawFreshFrame,
                sameFreshFrameNonce,
                publicCandidates: publicFrameCandidates,
                rawCandidates: rawFrameCandidates,
              },
              backgroundReap,
              backgroundReapOk,
              rollingTrace: {
                source: "official-terminals.read",
                windowBytes: TERMINAL_ROLLING_WINDOW_BYTES,
                snapshotCount: rollingSnapshots.length,
                observationErrors: rollingObservationErrors,
                observed: rollingTraceObserved,
                requiredTokens: [
                  expectedBackendName === "git-bash"
                    ? CONTROLLED_PROMPT_CONTRACT_GIT
                    : CONTROLLED_PROMPT_CONTRACT_WSL,
                  "current START nonce",
                  "current END:0",
                ],
                oscRequired: false,
                tokenSnapshots: rollingSnapshots.map((entry) => ({
                  sessionId: entry.sessionId,
                  rollingWindowBytes: entry.rollingWindowBytes,
                  rollingWindowSha256: entry.rollingWindowSha256,
                  hasOsc133D: entry.streamTrace?.hasOsc133D ?? entry.hasOsc133D ?? false,
                  hasControlledPrompt: entry.streamTrace?.hasControlledPrompt ?? entry.hasControlledPrompt ?? false,
                  hasEndFrame: entry.streamTrace?.hasEndFrame ?? entry.hasEndFrame ?? false,
                  backendType: entry.streamTrace?.backendType ?? expectedBackendName,
                  promptContract: entry.streamTrace?.promptContract ?? null,
                  framePairs: entry.streamTrace?.framePairs ?? [],
                  streamTrace: entry.streamTrace ?? null,
                })),
              },
              rawStdoutTrace: {
                source: "public-subprocess.stdout data",
                windowBytes: TERMINAL_ROLLING_WINDOW_BYTES,
                observerCount: rawStdoutSnapshots.length,
                discoveryObserverCount: rawStdoutDiscoverySnapshots.length,
                observerAttemptCount: rawStdoutObserverAttempts.length,
                outOfScopeAttemptCount: rawStdoutObserverAttempts.filter((entry) => entry.attempt?.observationScope === "discovery").length,
                observed: rawStdoutTraceObserved,
                oscRequired: true,
                snapshots: rawStdoutSnapshots,
                discoverySnapshots: rawStdoutDiscoverySnapshots,
                observerAttempts: rawStdoutObserverAttempts,
              },
              noisyOutputObserved,
              rawNoisyAfterStart,
              publicNoisyAfterStart,
              backgroundOk,
            };
            backgroundEvidenceRecord = backgroundEvidence;
            backgroundCheckRecord = addCheck(evidence, `${modeId}:background-process-cleanup`, backgroundOk ? "PASS" : "FAIL",
              backgroundOk ? "live/noisy background activity was observed and reaped by the owner shell" : "live/noisy background activity did not return a clean reaped state",
              backgroundEvidence);
            appendCheckDiagnostic({ type: "end", id: `${modeId}:background-process-cleanup`, modeId, status: backgroundOk ? "PASS" : "FAIL" });
          } catch (error) {
            backgroundEvidence = { error: sanitize(error), backgroundOk: false };
              backgroundEvidenceRecord = backgroundEvidence;
              backgroundCheckRecord = addCheck(evidence, `${modeId}:background-process-cleanup`, "FAIL", "background/noisy process lifecycle probe threw", backgroundEvidence);
            appendCheckDiagnostic({ type: "end", id: `${modeId}:background-process-cleanup`, modeId, status: "FAIL", error: sanitize(error) });
          }
          let naturalExitEvidence;
          let naturalMarkerPath;
          appendCheckDiagnostic({ type: "begin", id: `${modeId}:natural-exit-reset`, modeId });
          try {
            naturalMarkerPath = join(workspace, `.dsh-native-${modeId}-natural-${process.pid}.marker`);
            rmSync(naturalMarkerPath, { force: true });
            const naturalMarkerShell = shellQuote(shellPathForMode(modeId, naturalMarkerPath));
            const processBeforeNatural = windowsProcessSnapshot();
            const naturalCommand = [
              `rm -f ${naturalMarkerShell}`,
              "natural_shell_winpid=$(cat /proc/$$/winpid 2>/dev/null | tr -d '[:space:]'); if [ -z \"$natural_shell_winpid\" ]; then natural_shell_winpid=$(ps -p $$ -o winpid= 2>/dev/null | tr -d '[:space:]'); fi",
              "(i=0; while [ \"$i\" -lt 300 ]; do sleep 0.02; i=$((i+1)); done; printf 'natural-delayed-marker\\n' > " + naturalMarkerShell + ") & natural_bg_pid=$!",
              "natural_bg_winpid=$(cat /proc/$natural_bg_pid/winpid 2>/dev/null | tr -d '[:space:]'); if [ -z \"$natural_bg_winpid\" ]; then natural_bg_winpid=$(ps -p $natural_bg_pid -o winpid= 2>/dev/null | tr -d '[:space:]'); fi",
              "printf 'natural-live shell_pid=%s shell_winpid=%s bg_pid=%s bg_winpid=%s\\n' \"$$\" \"$natural_shell_winpid\" \"$natural_bg_pid\" \"$natural_bg_winpid\"",
              "exit 0",
            ].join("; ");
            const naturalExit = await executeOwnedTool(modeTools, "bash", handle.agent, {
              command: naturalCommand,
            });
            const naturalSummary = persistentResultSummary(naturalExit);
            const processAfterNaturalExit = windowsProcessSnapshot();
            const naturalFrame = /natural-live shell_pid=(\d+) shell_winpid=(\d*) bg_pid=(\d+) bg_winpid=(\d*)/.exec(naturalSummary.output);
              const processLedgerRequired = modeId === "bash-git-bash";
            const linuxFramePids = naturalFrame === null ? [] : [Number(naturalFrame[1]), Number(naturalFrame[3])];
              const nativeWindowsPids = !processLedgerRequired || naturalFrame === null ? [] : [naturalFrame[2], naturalFrame[4]]
              .filter((pid) => pid.length > 0).map(Number);
              const rootPids = processLedgerRequired ? [
                ...nativeWindowsPids.filter((pid) => Number.isSafeInteger(pid) && pid > 0),
                ...nativeSpawns.map((entry) => Number(entry.pid)).filter((pid) => Number.isSafeInteger(pid) && pid > 0),
                ...terminalSnapshots.map((entry) => Number(entry.pid)).filter((pid) => Number.isSafeInteger(pid) && pid > 0),
              ] : [];
            const naturalRows = [
              ...processTreeRows(processBeforeNatural, rootPids),
              ...processTreeRows(processAfterNaturalExit, rootPids),
            ];
            const uniqueNaturalRows = [...new Map(naturalRows
              .map((row) => [processIdentity(row), row])
              .filter(([identity]) => identity !== null)).values()];
            const naturalOwnedIdentities = uniqueNaturalRows
              .map((row) => processIdentity(row))
              .filter((identity) => identity !== null);
            // Keep the full delayed marker window: an orphaned BG/ConHost/MSYS
            // child that survives only after the shell's natural exit must still
            // have time to write its marker before the reset assertion runs.
            await new Promise((resolveResult) => setTimeout(resolveResult, 7_000));
            const delayedMarkerCreated = existsSync(naturalMarkerPath);
            const afterDelayNatural = windowsProcessSnapshot();
            const afterNaturalExit = await executeOwnedTool(modeTools, "bash", handle.agent, {
              command: "printf 'natural-exit-reset\\n'",
            });
            const resetSummary = persistentResultSummary(afterNaturalExit);
            const remainingBeforeOwnerDispose = afterDelayNatural.rows
              .filter((row) => naturalOwnedIdentities.includes(processIdentity(row)));
            const naturalOk = naturalSummary.shellExited === true
              && naturalSummary.parsedExitCode === 0
              && naturalSummary.isError !== true
              && naturalSummary.error === null
              && (!processLedgerRequired || (
                naturalFrame !== null
                && linuxFramePids.every((pid) => Number.isSafeInteger(pid) && pid > 0)
                && nativeWindowsPids.length > 0
                && nativeWindowsPids.every((pid) => Number.isSafeInteger(pid) && pid > 0)
                && processBeforeNatural.available === true
                && processAfterNaturalExit.available === true
                && uniqueNaturalRows.length > 0
                && delayedMarkerCreated === false
                && remainingBeforeOwnerDispose.length === 0
              ))
              && resetSummary.parsedExitCode === 0
              && resetSummary.isError !== true
              && resetSummary.error === null
              && resetSummary.output.includes("natural-exit-reset");
            processLedgerEvidence = {
              available: processBeforeNatural.available && processAfterNaturalExit.available && afterDelayNatural.available,
              observationErrors: [processBeforeNatural, processAfterNaturalExit, afterDelayNatural]
                .map((snapshot) => snapshot.observationError)
                .filter(Boolean),
              frame: naturalFrame === null ? null : {
                shellPid: Number(naturalFrame[1]),
                  shellWinPid: !processLedgerRequired || naturalFrame[2] === "" ? null : Number(naturalFrame[2]),
                backgroundPid: Number(naturalFrame[3]),
                  backgroundWinPid: !processLedgerRequired || naturalFrame[4] === "" ? null : Number(naturalFrame[4]),
                linuxFramePids,
                nativeWindowsPids,
              },
              ownedIdentityCount: naturalOwnedIdentities.length,
              beforeRows: sanitizeProcessRows(processTreeRows(processBeforeNatural, rootPids), [[workspace, "<workspace>"]]),
              afterNaturalExitRows: sanitizeProcessRows(processTreeRows(processAfterNaturalExit, rootPids), [[workspace, "<workspace>"]]),
              afterDelayRows: sanitizeProcessRows(remainingBeforeOwnerDispose, [[workspace, "<workspace>"]]),
              delayedMarkerPath: "<owned-workspace>/native-natural.marker",
              delayedMarkerCreated,
              remainingBeforeOwnerDispose: sanitizeProcessRows(remainingBeforeOwnerDispose, [[workspace, "<workspace>"]]),
              naturalOwnedIdentities,
            };
            naturalExitEvidence = {
              naturalExit: naturalSummary,
              reset: resetSummary,
              processLedger: processLedgerEvidence,
              naturalOk,
            };
            rmSync(naturalMarkerPath, { force: true });
            addCheck(evidence, `${modeId}:natural-exit-reset`, naturalOk ? "PASS" : "FAIL",
              naturalOk ? "natural shell exit returned code 0, delayed noisy BG/Windows identities quiesced, and the next call reset cleanly" : "natural shell exit/delayed BG identity/reset was not cleanly observed",
              naturalExitEvidence);
            if (modeId === "bash-git-bash") {
              addCheck(evidence, `${modeId}:natural-exit-delayed-background`, naturalOk ? "PASS" : "FAIL",
                naturalOk ? "Git Bash natural exit reaped a delayed live background process through the full marker window"
                  : "Git Bash natural exit did not prove delayed live background reaping",
                naturalExitEvidence);
            }
              appendCheckDiagnostic({ type: "end", id: `${modeId}:natural-exit-reset`, modeId, status: naturalOk ? "PASS" : "FAIL" });
          } catch (error) {
            if (naturalMarkerPath !== undefined) rmSync(naturalMarkerPath, { force: true });
            processLedgerEvidence = {
              available: false,
              observationError: sanitize(error),
              observationErrors: [sanitize(error)],
            };
            naturalExitEvidence = { error: sanitize(error), naturalOk: false };
            addCheck(evidence, `${modeId}:natural-exit-reset`, "FAIL", "natural shell exit probe threw", naturalExitEvidence);
              appendCheckDiagnostic({ type: "end", id: `${modeId}:natural-exit-reset`, modeId, status: "FAIL", error: sanitize(error) });
          }
          if (modeId === "bash-git-bash") {
            let noisyMarkerPath;
            let noisyDiagnosticPath;
              appendCheckDiagnostic({ type: "begin", id: `${modeId}:natural-exit-noisy-background`, modeId });
            try {
              noisyMarkerPath = join(workspace, `.dsh-native-${modeId}-noisy-${process.pid}.marker`);
              noisyDiagnosticPath = join(workspace, `.dsh-native-${modeId}-noisy-${process.pid}.log`);
              rmSync(noisyMarkerPath, { force: true });
              rmSync(noisyDiagnosticPath, { force: true });
              const noisyMarkerShell = shellQuote(shellPathForMode(modeId, noisyMarkerPath));
              const noisyDiagnosticShell = shellQuote(shellPathForMode(modeId, noisyDiagnosticPath));
              const processBeforeNoisy = windowsProcessSnapshot();
              const noisyPrepare = await executeOwnedTool(modeTools, "bash", handle.agent, {
                command: [
                  `printf 'noisy-started\\n' > ${noisyDiagnosticShell}`,
                  `(i=0; while [ \"$i\" -lt 400 ]; do printf 'NATIVE_NOISY_BG\\n'; i=$((i+1)); sleep 0.02; done; printf 'noisy-ticks=400\\n' >> ${noisyDiagnosticShell}; printf 'noisy-delayed-marker\\n' > ${noisyMarkerShell}) & noisy_bg_pid=$!`,
                  "noisy_shell_winpid=$(cat /proc/$$/winpid 2>/dev/null | tr -d '[:space:]'); if [ -z \"$noisy_shell_winpid\" ]; then noisy_shell_winpid=$(ps -p $$ -o winpid= 2>/dev/null | tr -d '[:space:]'); fi",
                  "noisy_bg_winpid=$(cat /proc/$noisy_bg_pid/winpid 2>/dev/null | tr -d '[:space:]'); if [ -z \"$noisy_bg_winpid\" ]; then noisy_bg_winpid=$(ps -p $noisy_bg_pid -o winpid= 2>/dev/null | tr -d '[:space:]'); fi",
                  "printf 'natural-noisy-live shell_pid=%s shell_winpid=%s bg_pid=%s bg_winpid=%s\\n' \"$$\" \"$noisy_shell_winpid\" \"$noisy_bg_pid\" \"$noisy_bg_winpid\"",
                  "printf 'natural-noisy-prepared\\n'",
                ].join("; "),
              });
              await new Promise((resolveResult) => setTimeout(resolveResult, 500));
              const noisyNatural = await executeOwnedTool(modeTools, "bash", handle.agent, {
                command: "printf 'natural-noisy-shell-end\\n'; exit 0",
              });
              const noisyReset = await executeOwnedTool(modeTools, "bash", handle.agent, {
                command: "printf 'natural-noisy-reset\\n'",
              });
              const prepareSummary = persistentResultSummary(noisyPrepare);
              const noisyNaturalSummary = persistentResultSummary(noisyNatural);
              const noisyResetSummary = persistentResultSummary(noisyReset);
              const processAfterNoisyExit = windowsProcessSnapshot();
              const noisyOutput = `${prepareSummary.output} ${noisyNaturalSummary.output}`;
              const noisyFrame = /natural-noisy-live shell_pid=(\d+) shell_winpid=(\d*) bg_pid=(\d+) bg_winpid=(\d*)/.exec(noisyOutput);
              const noisyLinuxFramePids = noisyFrame === null ? [] : [Number(noisyFrame[1]), Number(noisyFrame[3])];
              const noisyNativeWindowsPids = noisyFrame === null ? [] : [noisyFrame[2], noisyFrame[4]]
                .filter((pid) => pid.length > 0).map(Number);
              const noisyRootPids = [
                ...noisyNativeWindowsPids.filter((pid) => Number.isSafeInteger(pid) && pid > 0),
                ...nativeSpawns.map((entry) => Number(entry.pid)).filter((pid) => Number.isSafeInteger(pid) && pid > 0),
                ...terminalSnapshots.map((entry) => Number(entry.pid)).filter((pid) => Number.isSafeInteger(pid) && pid > 0),
              ];
              const noisyInitialRows = processTreeRows(processBeforeNoisy, noisyRootPids);
              const noisyAfterExitRows = processTreeRows(processAfterNoisyExit, noisyRootPids);
              const noisyIdentities = [...new Set([...noisyInitialRows, ...noisyAfterExitRows]
                .map((row) => processIdentity(row)).filter((identity) => identity !== null))];
              await new Promise((resolveResult) => setTimeout(resolveResult, 10_000));
              const noisyMarkerCreated = existsSync(noisyMarkerPath);
              const noisyDiagnostic = existsSync(noisyDiagnosticPath)
                ? readFileSync(noisyDiagnosticPath, "utf8")
                : "";
              const noisyAfterDelay = windowsProcessSnapshot();
              const noisyRemaining = noisyAfterDelay.rows.filter((row) => noisyIdentities.includes(processIdentity(row)));
              const prepareOfficialTimeoutText = officialPersistentTimeoutText(prepareSummary, 10_000)
                && prepareSummary.output.includes("natural-noisy-prepared");
              const noisyOk = (resultSucceeded(prepareSummary, "natural-noisy-prepared") || prepareOfficialTimeoutText)
                && prepareSummary.output.includes("NATIVE_NOISY_BG")
                && resultSucceeded(noisyNaturalSummary, "natural-noisy-shell-end")
                && noisyNaturalSummary.shellExited === true
                && noisyNaturalSummary.parsedExitCode === 0
                && noisyFrame !== null
                && noisyLinuxFramePids.every((pid) => Number.isSafeInteger(pid) && pid > 0)
                && noisyNativeWindowsPids.length > 0
                && noisyNativeWindowsPids.every((pid) => Number.isSafeInteger(pid) && pid > 0)
                && processBeforeNoisy.available === true
                && processAfterNoisyExit.available === true
                && noisyAfterDelay.available === true
                && noisyIdentities.length > 0
                && noisyDiagnostic.includes("noisy-started")
                && noisyMarkerCreated === false
                && !noisyDiagnostic.includes("noisy-delayed-marker")
                && noisyRemaining.length === 0
                && resultSucceeded(noisyResetSummary, "natural-noisy-reset");
              const noisyEvidence = {
                prepare: prepareSummary,
                naturalExit: noisyNaturalSummary,
                reset: noisyResetSummary,
                processLedger: {
                  available: processBeforeNoisy.available && processAfterNoisyExit.available && noisyAfterDelay.available,
                  observationErrors: [processBeforeNoisy, processAfterNoisyExit, noisyAfterDelay]
                    .map((snapshot) => snapshot.observationError)
                    .filter(Boolean),
                  frame: noisyFrame === null ? null : {
                    shellPid: Number(noisyFrame[1]),
                    shellWinPid: noisyFrame[2] === "" ? null : Number(noisyFrame[2]),
                    backgroundPid: Number(noisyFrame[3]),
                    backgroundWinPid: noisyFrame[4] === "" ? null : Number(noisyFrame[4]),
                    linuxFramePids: noisyLinuxFramePids,
                    nativeWindowsPids: noisyNativeWindowsPids,
                  },
                  ownedIdentityCount: noisyIdentities.length,
                  beforeRows: sanitizeProcessRows(noisyInitialRows, [[workspace, "<workspace>"]]),
                  afterNaturalExitRows: sanitizeProcessRows(noisyAfterExitRows, [[workspace, "<workspace>"]]),
                  afterDelayRows: sanitizeProcessRows(noisyRemaining, [[workspace, "<workspace>"]]),
                  noisyDiagnostic: sanitize(noisyDiagnostic, [[workspace, "<workspace>"]]),
                  markerCreated: noisyMarkerCreated,
                  remaining: sanitizeProcessRows(noisyRemaining, [[workspace, "<workspace>"]]),
                },
                noisyOutputObserved: prepareSummary.output.includes("NATIVE_NOISY_BG"),
                noisyOk,
              };
              addCheck(evidence, `${modeId}:natural-exit-noisy-background`, noisyOk ? "PASS" : "FAIL",
                noisyOk ? "Git Bash natural exit reaped continuous noisy background output and its delayed marker-window identities"
                  : "Git Bash natural exit did not prove continuous noisy background reaping",
                noisyEvidence);
                appendCheckDiagnostic({ type: "end", id: `${modeId}:natural-exit-noisy-background`, modeId, status: noisyOk ? "PASS" : "FAIL" });
              rmSync(noisyMarkerPath, { force: true });
              rmSync(noisyDiagnosticPath, { force: true });
            } catch (error) {
              if (noisyMarkerPath !== undefined) rmSync(noisyMarkerPath, { force: true });
              if (noisyDiagnosticPath !== undefined) rmSync(noisyDiagnosticPath, { force: true });
              addCheck(evidence, `${modeId}:natural-exit-noisy-background`, "FAIL", "continuous noisy natural-exit probe threw", {
                error: sanitize(error),
                observationError: sanitize(error),
              });
                appendCheckDiagnostic({ type: "end", id: `${modeId}:natural-exit-noisy-background`, modeId, status: "FAIL", error: sanitize(error) });
            }
          }
            appendCheckDiagnostic({ type: "begin", id: `${modeId}:timeout-reset`, modeId });
            let timeoutEvidence;
          let timeoutMarkerPath;
          let timeoutLeakPath;
          let timeoutDiagnosticPath;
          try {
            timeoutMarkerPath = join(workspace, `.dsh-native-${modeId}-timeout-ready-${process.pid}.marker`);
            timeoutLeakPath = join(workspace, `.dsh-native-${modeId}-timeout-leak-${process.pid}.marker`);
            timeoutDiagnosticPath = join(workspace, `.dsh-native-${modeId}-timeout-${process.pid}.log`);
            for (const path of [timeoutMarkerPath, timeoutLeakPath, timeoutDiagnosticPath]) rmSync(path, { force: true });
            const timeoutMarkerShell = shellQuote(shellPathForMode(modeId, timeoutMarkerPath));
            const timeoutLeakShell = shellQuote(shellPathForMode(modeId, timeoutLeakPath));
            const timeoutDiagnosticShell = shellQuote(shellPathForMode(modeId, timeoutDiagnosticPath));
            const timeoutProcessBefore = windowsProcessSnapshot();
              const timeoutSpawnStart = nativeSpawnHandles.length;
              const timeoutHandleBatchStart = nativeHandleEvents.length;
            const timeoutExistingNativeSpawns = nativeSpawns.slice();
              const timeoutExistingHandleEvents = nativeHandleEvents.slice();
              const timeoutExistingHandleCapabilities = timeoutExistingHandleEvents
                .map((event) => event.capability);
            const timeoutExistingTerminalSnapshots = terminalSnapshots.slice();
            const timeoutCall = executeOwnedTool(modeTools, "bash", handle.agent, {
              command: [
                `rm -f ${timeoutMarkerShell} ${timeoutLeakShell} ${timeoutDiagnosticShell}`,
                "export DSH_NEW_MODE_TIMEOUT=stale",
                "timeout_shell_winpid=$(cat /proc/$$/winpid 2>/dev/null | tr -d '[:space:]'); if [ -z \"$timeout_shell_winpid\" ]; then timeout_shell_winpid=$(ps -p $$ -o winpid= 2>/dev/null | tr -d '[:space:]'); fi",
                `(sleep 14; printf 'timeout-leaked\\n' > ${timeoutLeakShell}) & timeout_bg_pid=$!`,
                "timeout_bg_winpid=$(cat /proc/$timeout_bg_pid/winpid 2>/dev/null | tr -d '[:space:]'); if [ -z \"$timeout_bg_winpid\" ]; then timeout_bg_winpid=$(ps -p $timeout_bg_pid -o winpid= 2>/dev/null | tr -d '[:space:]'); fi",
                `printf 'timeout-ready shell_winpid=%s bg_winpid=%s\\n' \"$timeout_shell_winpid\" \"$timeout_bg_winpid\" > ${timeoutMarkerShell}`,
                `printf 'timeout-ready\\n' > ${timeoutDiagnosticShell}`,
                "wait \"$timeout_bg_pid\"",
              ].join("; "),
            });
            const timeoutReady = await waitFor(() => existsSync(timeoutMarkerPath), 5_000);
            const timeoutProcessAtReady = windowsProcessSnapshot();
              const timeoutPublicSessionAtBarrier = publicTerminalObservation(
                modeTerminals,
                handle.agent,
                [[workspace, "<workspace>"]],
                expectedBackendName,
              );
              const timeoutPublicSessionOk = timeoutPublicSessionAtBarrier.listAvailable
                && timeoutPublicSessionAtBarrier.readAvailable
                && timeoutPublicSessionAtBarrier.snapshots.length > 0
                && timeoutPublicSessionAtBarrier.observationErrors.length === 0;
            let timeoutResult;
            let timeoutGuarded = false;
            let timeoutGuardTimer;
            let timeoutCallError;
            try {
              timeoutResult = await Promise.race([
                timeoutCall,
                new Promise((_, reject) => {
                  timeoutGuardTimer = setTimeout(() => {
                    timeoutGuarded = true;
                    reject(new Error("persistent timeout call did not settle by bounded diagnostic deadline"));
                  }, 15_000);
                }),
              ]);
            } catch (error) {
              timeoutCallError = thrownErrorSummary(error);
            } finally {
              if (timeoutGuardTimer !== undefined) clearTimeout(timeoutGuardTimer);
            }
            const timeoutSummary = persistentResultSummary(timeoutResult);
              const timeoutHandleEventsAfter = nativeHandleEvents.slice();
              const timeoutExistingHandleResults = timeoutExistingHandleEvents
                .map((event) => event.result);
              const timeoutNewHandleEvents = timeoutHandleEventsAfter.slice(timeoutHandleBatchStart);
              const timeoutNewHandleResults = timeoutNewHandleEvents
                .map((event) => event.result);
            const timeoutHandlesToSettle = [
              ...timeoutExistingHandleResults,
              ...timeoutNewHandleResults,
            ];
            const timeoutExistingHandleObserved = timeoutExistingHandleCapabilities.length > 0
              && timeoutExistingHandleCapabilities.every((capability) => capability.hasDone
                && capability.hasWaitForExit
                && capability.hasTerminate);
            const timeoutExistingIdentityObserved = timeoutExistingTerminalSnapshots.some((row) =>
              Number.isSafeInteger(Number(row?.pid)) && Number(row.pid) > 0)
              || timeoutExistingNativeSpawns.some((entry) =>
                Number.isSafeInteger(Number(entry?.pid)) && Number(entry.pid) > 0);
            // Sleep in the command is intentionally 14s: a real 10s Host
            // deadline must interrupt it before the delayed leak marker writes.
            // The post-call window extends beyond that marker deadline.
            await new Promise((resolveResult) => setTimeout(resolveResult, 7_000));
            const timeoutLeakCreated = existsSync(timeoutLeakPath);
            const timeoutProcessAfterDelay = windowsProcessSnapshot();
            const timeoutReadyText = existsSync(timeoutMarkerPath) ? readFileSync(timeoutMarkerPath, "utf8") : "";
            const timeoutFrame = /timeout-ready shell_winpid=(\d+) bg_winpid=(\d+)/.exec(timeoutReadyText);
              const timeoutProcessRequired = modeId === "bash-git-bash";
              const timeoutNativeWindowsPids = !timeoutProcessRequired || timeoutFrame === null ? [] : timeoutFrame.slice(1).map(Number);
              const timeoutRootPids = timeoutProcessRequired ? [
              // Include both the old shell and its delayed background child:
              // the shell may remain during the command, but after the
              // official reset both old creation identities must be gone.
              timeoutFrame === null ? null : Number(timeoutFrame[1]),
              timeoutFrame === null ? null : Number(timeoutFrame[2]),
                ...timeoutNewHandleEvents.map((event) => Number(event.spawnEntry?.pid)).filter((pid) => Number.isSafeInteger(pid) && pid > 0),
              ] : [];
            const timeoutRowsBefore = processTreeRows(timeoutProcessAtReady, timeoutRootPids);
            const timeoutRowsAfterDelay = processTreeRows(timeoutProcessAfterDelay, timeoutRootPids);
            const timeoutHostAlive = (snapshot) => snapshot.available
              && snapshot.rows.some((row) => Number(row?.ProcessId) === process.pid && processIdentity(row) !== null);
              const timeoutResetOutcome = await runBoundedOwnedTool(
                modeTools,
                "bash",
                handle.agent,
                {
                  command: "if [ \"${DSH_NEW_MODE_TIMEOUT-}\" = stale ]; then printf 'timeout-state-stale\\n'; else printf 'timeout-state-reset\\n'; fi; printf 'timeout-reset\\n'",
                },
                15_000,
                `${modeId}:timeout-reset-tool`,
              );
              const afterTimeout = timeoutResetOutcome.initial.status === "fulfilled"
                ? timeoutResetOutcome.initial.value
                : undefined;
              const resetSummary = persistentResultSummary(afterTimeout);
            const timeoutProcessAfterReset = windowsProcessSnapshot();
            const timeoutRowsAfterReset = processTreeRows(timeoutProcessAfterReset, timeoutRootPids);
            const timeoutAllObservedRows = [...timeoutRowsBefore, ...timeoutRowsAfterDelay, ...timeoutRowsAfterReset];
            const timeoutIdentities = [...new Set(timeoutAllObservedRows
              .map((row) => processIdentity(row)).filter((identity) => identity !== null))];
            const timeoutRemaining = timeoutProcessAfterReset.rows
              .filter((row) => timeoutIdentities.includes(processIdentity(row)));
            const timeoutResetSettlements = await settleObservedHandleResults(timeoutHandlesToSettle, 5_000);
            const timeoutHandleQuiesced = boundedManagedSettlementsClean(timeoutResetSettlements);
            const timeoutOfficialText = officialPersistentTimeoutText(timeoutSummary, 10_000);
            const timeoutProcessOk = !timeoutProcessRequired || (
              timeoutProcessAtReady.available
              && timeoutProcessAfterDelay.available
              && timeoutProcessAfterReset.available
              && timeoutIdentities.length > 0
              && timeoutRemaining.length === 0
              && timeoutHostAlive(timeoutProcessAtReady)
              && timeoutHostAlive(timeoutProcessAfterReset)
            );
              const timeoutOk = timeoutResetOutcome.timedOut === false
                && timeoutResetOutcome.initial.status === "fulfilled"
                && timeoutReady === true
                && timeoutPublicSessionOk
              && timeoutGuarded === false
              && timeoutCallError === undefined
              && (timeoutSummary.timedOut === true || timeoutOfficialText)
              && timeoutSummary.aborted !== true
              && timeoutHandleQuiesced
              && timeoutProcessOk
              && timeoutLeakCreated === false
              && resetSummary.parsedExitCode === 0
              && resetSummary.isError !== true
              && resetSummary.error === null
              && resetSummary.output.includes("timeout-state-reset")
              && resetSummary.output.includes("timeout-reset")
              && !resetSummary.output.includes("timeout-state-stale");
            timeoutEvidence = {
              timeout: timeoutSummary,
              timeoutContract: {
                officialTimeoutText: timeoutOfficialText,
                timeoutMs: 10_000,
              },
              reset: resetSummary,
                resetTool: {
                  initial: timeoutResetOutcome.initial,
                  afterAbort: timeoutResetOutcome.afterAbort,
                  timedOut: timeoutResetOutcome.timedOut,
                  signalAborted: timeoutResetOutcome.controller.signal.aborted,
                },
              readyObserved: timeoutReady === true,
              timeoutGuarded,
              timeoutCallError: timeoutCallError ?? null,
              timeoutReadyText: sanitize(timeoutReadyText, [[workspace, "<workspace>"]]),
                timeoutPublicSessionAtBarrier,
                timeoutPublicSessionOk,
              nativeWindowsPids: timeoutNativeWindowsPids,
              timeoutLeakCreated,
              timeoutHandleSettlements: timeoutResetSettlements,
              timeoutHandlesToSettleCount: timeoutHandlesToSettle.length,
              timeoutHandleQuiesced,
              timeoutNewHandleCount: timeoutNewHandleEvents.length,
              timeoutExistingHandleObserved,
              timeoutExistingIdentityObserved,
              timeoutExistingManagedHandles: timeoutExistingHandleCapabilities,
              timeoutExistingTerminalSnapshots,
              timeoutProcess: {
                required: timeoutProcessRequired,
                hostAliveBefore: timeoutHostAlive(timeoutProcessAtReady),
                hostAliveAfterDelay: timeoutHostAlive(timeoutProcessAfterReset),
                availableBefore: timeoutProcessAtReady.available,
                availableAfterDelay: timeoutProcessAfterReset.available,
                observationErrors: [timeoutProcessBefore, timeoutProcessAtReady, timeoutProcessAfterDelay, timeoutProcessAfterReset]
                  .map((snapshot) => snapshot.observationError)
                  .filter(Boolean),
                ownedIdentityCount: timeoutIdentities.length,
                atReadyRows: sanitizeProcessRows(timeoutRowsBefore, [[workspace, "<workspace>"]]),
                afterResetRows: sanitizeProcessRows(timeoutRowsAfterReset, [[workspace, "<workspace>"]]),
                remaining: sanitizeProcessRows(timeoutRemaining, [[workspace, "<workspace>"]]),
              },
              timeoutOk,
            };
            addCheck(evidence, `${modeId}:timeout-reset`, timeoutOk ? "PASS" : "FAIL",
              timeoutOk ? "bounded persistent timeout returned timedOut and the next call reset cleanly"
                : "bounded persistent timeout/reset did not prove timedOut and clean shell state",
              timeoutEvidence);
            appendCheckDiagnostic({ type: "end", id: `${modeId}:timeout-reset`, modeId, status: timeoutOk ? "PASS" : "FAIL" });
          } catch (error) {
            for (const path of [timeoutMarkerPath, timeoutLeakPath, timeoutDiagnosticPath]) {
              if (path !== undefined) rmSync(path, { force: true });
            }
            timeoutEvidence = { error: sanitize(error), observationError: sanitize(error), timeoutOk: false };
            addCheck(evidence, `${modeId}:timeout-reset`, "FAIL", "timeout/reset lifecycle probe threw", timeoutEvidence);
            appendCheckDiagnostic({ type: "end", id: `${modeId}:timeout-reset`, modeId, status: "FAIL", error: sanitize(error) });
          }
          for (const path of [timeoutMarkerPath, timeoutLeakPath, timeoutDiagnosticPath]) {
            if (path !== undefined) rmSync(path, { force: true });
          }
          let cancelEvidence;
          let cancelReadyPath;
          let cancelLeakPath;
          let cancelDiagnosticPath;
          let cancelReleasePath;
          appendCheckDiagnostic({ type: "begin", id: `${modeId}:cancel-reset`, modeId });
          try {
            const cancelController = new AbortController();
            cancelReadyPath = join(workspace, `.dsh-native-${modeId}-cancel-ready-${process.pid}.marker`);
            cancelLeakPath = join(workspace, `.dsh-native-${modeId}-cancel-leak-${process.pid}.marker`);
            cancelDiagnosticPath = join(workspace, `.dsh-native-${modeId}-cancel-${process.pid}.log`);
            cancelReleasePath = join(workspace, `.dsh-native-${modeId}-cancel-release-${process.pid}.marker`);
            for (const path of [cancelReadyPath, cancelLeakPath, cancelDiagnosticPath, cancelReleasePath]) rmSync(path, { force: true });
            const cancelReadyShell = shellQuote(shellPathForMode(modeId, cancelReadyPath));
            const cancelLeakShell = shellQuote(shellPathForMode(modeId, cancelLeakPath));
            const cancelDiagnosticShell = shellQuote(shellPathForMode(modeId, cancelDiagnosticPath));
            const cancelReleaseShell = shellQuote(shellPathForMode(modeId, cancelReleasePath));
            const cancelProcessBefore = windowsProcessSnapshot();
              const cancelSpawnStart = nativeSpawnHandles.length;
              const cancelHandleBatchStart = nativeHandleEvents.length;
            const cancelExistingNativeSpawns = nativeSpawns.slice();
              const cancelExistingHandleEvents = nativeHandleEvents.slice();
              const cancelExistingHandleCapabilities = cancelExistingHandleEvents
                .map((event) => event.capability);
              let cancelExistingTerminalSnapshots = [];
            let cancelResult;
            let cancelError;
            let cancelTimedOut = false;
            const cancelCall = executeOwnedTool(modeTools, "bash", handle.agent, {
              command: [
                `rm -f ${cancelReadyShell} ${cancelLeakShell} ${cancelDiagnosticShell}`,
                "cancel_shell_winpid=$(cat /proc/$$/winpid 2>/dev/null | tr -d '[:space:]'); if [ -z \"$cancel_shell_winpid\" ]; then cancel_shell_winpid=$(ps -p $$ -o winpid= 2>/dev/null | tr -d '[:space:]'); fi",
                `(while [ ! -f ${cancelReleaseShell} ]; do sleep 0.01; done; sleep 14; printf 'cancel-leaked\\n' > ${cancelLeakShell}) & cancel_bg_pid=$!`,
                "cancel_bg_winpid=$(cat /proc/$cancel_bg_pid/winpid 2>/dev/null | tr -d '[:space:]'); if [ -z \"$cancel_bg_winpid\" ]; then cancel_bg_winpid=$(ps -p $cancel_bg_pid -o winpid= 2>/dev/null | tr -d '[:space:]'); fi",
                `export DSH_NEW_MODE_CANCEL=stale; printf 'cancel-ready shell_winpid=%s bg_winpid=%s\\n' \"$cancel_shell_winpid\" \"$cancel_bg_winpid\" > ${cancelReadyShell}`,
                `printf 'cancel-ready\\n' > ${cancelDiagnosticShell}`,
                "wait \"$cancel_bg_pid\"",
              ].join("; "),
            }, { signal: cancelController.signal });
            const cancelReady = await waitFor(() => existsSync(cancelReadyPath), 5_000);
            const cancelReadyTextAtBarrier = existsSync(cancelReadyPath) ? readFileSync(cancelReadyPath, "utf8") : "";
            const cancelFrameAtBarrier = /cancel-ready shell_winpid=(\d+) bg_winpid=(\d+)/.exec(cancelReadyTextAtBarrier);
            const cancelProcessAtReady = windowsProcessSnapshot();
            const cancelPublicSessionAtBarrier = publicTerminalObservation(
              modeTerminals,
              handle.agent,
              [[workspace, "<workspace>"]],
              expectedBackendName,
            );
              cancelExistingTerminalSnapshots = cancelPublicSessionAtBarrier.snapshots
                .map((snapshot) => ({ ...snapshot }));
            const cancelObserverReady = cancelReady === true && (modeId === "bash-git-bash"
              ? cancelProcessAtReady.available === true
                && cancelFrameAtBarrier !== null
                && cancelFrameAtBarrier.slice(1).every((pid) => Number(pid) > 0)
              : cancelPublicSessionAtBarrier.listAvailable
                && cancelPublicSessionAtBarrier.readAvailable
                && cancelPublicSessionAtBarrier.snapshots.length > 0
                && cancelPublicSessionAtBarrier.observationErrors.length === 0);
            let cancelAbortAt = null;
            let cancelReleaseAt = null;
            if (cancelReady) {
              // Do not spend the delayed-marker window while the observer is
              // doing its readiness/CIM/public-session work.  Release the
              // background timer only after that barrier, then abort.
              writeFileSync(cancelReleasePath, "release\\n");
              cancelReleaseAt = Date.now();
              cancelAbortAt = Date.now();
              cancelController.abort(new DOMException("desktop native mode cancellation", "AbortError"));
            } else {
              cancelController.abort(new DOMException("cancel readiness deadline", "AbortError"));
            }
            let cancelGuardTimer;
            const cancelGuard = new Promise((_, reject) => {
              cancelGuardTimer = setTimeout(() => {
                cancelTimedOut = true;
                reject(new Error("native mode cancellation did not settle"));
              }, 8_000);
            });
            try {
              cancelResult = await Promise.race([cancelCall, cancelGuard]);
            } catch (error) {
              cancelError = thrownErrorSummary(error);
            } finally {
              clearTimeout(cancelGuardTimer);
            }
            // The background marker is intentionally delayed beyond the
            // readiness/abort barrier; observe through the complete 14s
            // window before declaring cancellation clean.
            await new Promise((resolveResult) => setTimeout(resolveResult, 15_000));
            const cancelLeakCreated = existsSync(cancelLeakPath);
            const cancelProcessAfterDelay = windowsProcessSnapshot();
            const cancelReadyText = existsSync(cancelReadyPath) ? readFileSync(cancelReadyPath, "utf8") : "";
            const cancelFrame = /cancel-ready shell_winpid=(\d+) bg_winpid=(\d+)/.exec(cancelReadyText);
              const cancelProcessRequired = modeId === "bash-git-bash";
              const cancelNativeWindowsPids = !cancelProcessRequired || cancelFrame === null ? [] : cancelFrame.slice(1).map(Number);
              const cancelRootPids = cancelProcessRequired ? [
              // Include the old shell and its delayed background child: the
              // shell may remain during cancellation, but after the official
              // reset both old creation identities must be gone.
              cancelFrame === null ? null : Number(cancelFrame[1]),
              cancelFrame === null ? null : Number(cancelFrame[2]),
                ...nativeHandleEvents.slice(cancelHandleBatchStart)
                  .map((event) => Number(event.spawnEntry?.pid))
                  .filter((pid) => Number.isSafeInteger(pid) && pid > 0),
              ] : [];
            const cancelRowsBefore = processTreeRows(cancelProcessAtReady, cancelRootPids);
            const cancelRowsAfterDelay = processTreeRows(cancelProcessAfterDelay, cancelRootPids);
            const cancelHostAlive = (snapshot) => snapshot.available
              && snapshot.rows.some((row) => Number(row?.ProcessId) === process.pid && processIdentity(row) !== null);
              const cancelHandleEventsAfter = nativeHandleEvents.slice();
              const cancelExistingHandleResults = cancelExistingHandleEvents
                .map((event) => event.result);
              const cancelNewHandleEvents = cancelHandleEventsAfter.slice(cancelHandleBatchStart);
              const cancelNewHandleResults = cancelNewHandleEvents.map((event) => event.result);
            const cancelHandlesToSettle = [
              ...cancelExistingHandleResults,
              ...cancelNewHandleResults,
            ];
            const cancelExistingHandleObserved = cancelExistingHandleCapabilities.length > 0
              && cancelExistingHandleCapabilities.every((capability) => capability.hasDone
                && capability.hasWaitForExit
                && capability.hasTerminate);
              const cancelExistingIdentityObserved = modeId === "bash-wsl"
                ? cancelExistingTerminalSnapshots.length > 0
                  && cancelPublicSessionAtBarrier.observationErrors.length === 0
                : cancelExistingTerminalSnapshots.some((row) =>
                  Number.isSafeInteger(Number(row?.pid)) && Number(row.pid) > 0)
                  || cancelExistingNativeSpawns.some((entry) =>
                    Number.isSafeInteger(Number(entry?.pid)) && Number(entry.pid) > 0);
            const cancelSummary = persistentResultSummary(cancelResult);
            const typedAbort = cancelError?.name === "AbortError"
              || /^(?:ABORT(?:ED|_ERR)|ERR_ABORTED)$/i.test(String(cancelError?.code ?? ""))
              || /^(?:ABORT(?:ED|_ERR)|CANCELLED)$/i.test(String(cancelSummary.failureKind ?? cancelSummary.failureCode ?? ""))
              || cancelSummary.errorName === "AbortError"
              || /^(?:ABORT(?:ED|_ERR)|ERR_ABORTED)$/i.test(String(cancelSummary.errorCode ?? ""));
            // The public Desktop pipeline currently exposes a typed
            // AbortError/ABORTED envelope in result.error.info. Do not treat
            // an arbitrary empty/error result as cancellation evidence.
            const emptyOutputAbortContract = false;
            const abortContract = typedAbort;
            const cancelStarted = cancelReady === true && cancelAbortAt !== null;
            const abortSignalReasonName = typeof cancelController.signal.reason?.name === "string"
              ? cancelController.signal.reason.name
              : null;
            const abortSignalReasonCode = typeof cancelController.signal.reason?.code === "string"
              ? cancelController.signal.reason.code
              : null;
              const resetOutcome = await runBoundedOwnedTool(
                modeTools,
                "bash",
                handle.agent,
                {
                  command: "if [ \"${DSH_NEW_MODE_CANCEL-clean}\" = clean ]; then printf 'cancel-state-reset\\n'; else printf 'cancel-state-stale\\n'; fi; printf 'cancel-reset\\n'",
                },
                15_000,
                `${modeId}:cancel-reset-tool`,
              );
              const resetAfterCancel = resetOutcome.initial.status === "fulfilled"
                ? resetOutcome.initial.value
                : undefined;
              const resetSummary = persistentResultSummary(resetAfterCancel);
            const cancelProcessAfterReset = windowsProcessSnapshot();
            const cancelRowsAfterReset = processTreeRows(cancelProcessAfterReset, cancelRootPids);
            const cancelAllObservedRows = [...cancelRowsBefore, ...cancelRowsAfterDelay, ...cancelRowsAfterReset];
            const cancelIdentities = [...new Set(cancelAllObservedRows
              .map((row) => processIdentity(row)).filter((identity) => identity !== null))];
            const cancelRemaining = cancelProcessAfterReset.rows
              .filter((row) => cancelIdentities.includes(processIdentity(row)));
            const cancelResetSettlements = await settleObservedHandleResults(cancelHandlesToSettle, 5_000);
            const cancelHandleQuiesced = boundedManagedSettlementsClean(cancelResetSettlements);
              const staleEnvironmentClean = resetOutcome.timedOut === false
                && resetOutcome.initial.status === "fulfilled"
                && resetSummary.parsedExitCode === 0
              && resetSummary.isError !== true
              && resetSummary.error === null
              && resetSummary.output.includes("cancel-state-reset")
              && resetSummary.output.includes("cancel-reset")
              && !resetSummary.output.includes("cancel-state-stale");
            const cancelProcessOk = !cancelProcessRequired || (
              cancelProcessAtReady.available
              && cancelProcessAfterDelay.available
              && cancelProcessAfterReset.available
              && cancelIdentities.length > 0
              && cancelRemaining.length === 0
              && cancelHostAlive(cancelProcessAtReady)
              && cancelHostAlive(cancelProcessAfterReset)
            );
            const cancelOk = !cancelTimedOut
              && cancelStarted
              && cancelController.signal.aborted
              && cancelObserverReady
              && cancelReleaseAt !== null
              && abortContract
              && cancelLeakCreated === false
              && cancelHandleQuiesced
              && cancelProcessOk
              && staleEnvironmentClean;
            cancelEvidence = {
              cancelReady,
              cancelStarted,
              releaseBarrierReleased: cancelReleaseAt !== null,
              cancelReleaseAt,
              cancelAbortAt,
              observerReady: cancelObserverReady,
              readyTextAtBarrier: sanitize(cancelReadyTextAtBarrier, [[workspace, "<workspace>"]]),
              abortSignalAborted: cancelController.signal.aborted,
              abortSignalReasonName,
              abortSignalReasonCode,
              abortContract,
              typedAbort,
              emptyOutputAbortContract,
              cancelTimedOut,
              cancelError: cancelError ?? null,
              cancelResult: cancelResult === undefined ? null : cancelSummary,
              cancelLeakCreated,
              nativeWindowsPids: cancelNativeWindowsPids,
              reset: resetSummary,
                resetTool: {
                  initial: resetOutcome.initial,
                  afterAbort: resetOutcome.afterAbort,
                  timedOut: resetOutcome.timedOut,
                  signalAborted: resetOutcome.controller.signal.aborted,
                },
              staleEnvironmentClean,
              cancelHandleSettlements: cancelResetSettlements,
              cancelHandlesToSettleCount: cancelHandlesToSettle.length,
              cancelHandleQuiesced,
              cancelNewHandleCount: cancelNewHandleEvents.length,
              cancelHandleBatch: {
                existingCount: cancelExistingHandleEvents.length,
                finalCount: cancelHandleEventsAfter.length,
                existing: nativeHandleEventEvidence(cancelExistingHandleEvents),
                new: nativeHandleEventEvidence(cancelNewHandleEvents),
              },
              cancelExistingHandleObserved,
              cancelExistingIdentityObserved,
              cancelExistingManagedHandles: cancelExistingHandleCapabilities,
              cancelExistingTerminalSnapshots,
              publicSessionAtBarrier: cancelPublicSessionAtBarrier,
              cancelProcess: {
                required: cancelProcessRequired,
                hostAliveBefore: cancelHostAlive(cancelProcessAtReady),
                hostAliveAfterDelay: cancelHostAlive(cancelProcessAfterReset),
                availableBefore: cancelProcessAtReady.available,
                availableAfterDelay: cancelProcessAfterReset.available,
                observationErrors: [cancelProcessBefore, cancelProcessAtReady, cancelProcessAfterDelay, cancelProcessAfterReset]
                  .map((snapshot) => snapshot.observationError)
                  .filter(Boolean),
                ownedIdentityCount: cancelIdentities.length,
                atReadyRows: sanitizeProcessRows(cancelRowsBefore, [[workspace, "<workspace>"]]),
                afterResetRows: sanitizeProcessRows(cancelRowsAfterReset, [[workspace, "<workspace>"]]),
                remaining: sanitizeProcessRows(cancelRemaining, [[workspace, "<workspace>"]]),
              },
              cancelOk,
            };
            addCheck(evidence, `${modeId}:cancel-reset`, cancelOk ? "PASS" : "FAIL",
              cancelOk ? "bounded cancellation settled and the next persistent call reset cleanly" : "bounded cancellation/reset did not settle cleanly",
              cancelEvidence);
            appendCheckDiagnostic({ type: "end", id: `${modeId}:cancel-reset`, modeId, status: cancelOk ? "PASS" : "FAIL" });
          } catch (error) {
            cancelEvidence = { error: sanitize(error), observationError: sanitize(error), cancelOk: false };
            addCheck(evidence, `${modeId}:cancel-reset`, "FAIL", "cancellation/reset probe threw", cancelEvidence);
            appendCheckDiagnostic({ type: "end", id: `${modeId}:cancel-reset`, modeId, status: "FAIL", error: sanitize(error) });
          }
          for (const path of [cancelReadyPath, cancelLeakPath, cancelDiagnosticPath, cancelReleasePath]) {
            if (path !== undefined) rmSync(path, { force: true });
          }
          let crossAgentEvidence;
          let crossHandle;
          try {
            crossHandle = await agentService.create({
              sessionId: `desktop-new-mode-cross-${modeId}-${process.pid}`,
              meta: { cwd: workspace, agentPreset: modeId },
              agentOptions: { provider: "desktop-new-mode-probe", model: "desktop-new-mode-probe" },
              setup: async (agentCtx) => { await presets.mount(agentCtx, modeId); },
            });
            agents.push(crossHandle);
            if (modeId === "bash-git-bash" && typeof permissions.set === "function") {
              await permissions.set(crossHandle.agent.session, "danger-full-access");
            }
            const crossTools = presets.serviceFor(crossHandle.agent, "tools") ?? crossHandle.agent.ctx.get("tools");
            const ownerASet = await executeOwnedTool(modeTools, "bash", handle.agent, {
              command: "export DSH_NEW_MODE_CROSS=owner-a; printf 'cross-a-set\\n'",
            });
            const ownerBRead = await executeOwnedTool(crossTools, "bash", crossHandle.agent, {
              command: "if [ \"${DSH_NEW_MODE_CROSS-}\" = owner-a ]; then printf 'cross-leaked\\n'; else printf 'cross-b-isolated\\n'; fi",
            });
            const ownerBSet = await executeOwnedTool(crossTools, "bash", crossHandle.agent, {
              command: "export DSH_NEW_MODE_CROSS=owner-b; printf 'cross-b-set\\n'",
            });
            const ownerARead = await executeOwnedTool(modeTools, "bash", handle.agent, {
              command: "if [ \"${DSH_NEW_MODE_CROSS-}\" = owner-a ]; then printf 'cross-a-retained\\n'; else printf 'cross-a-lost\\n'; fi",
            });
            const aSetSummary = persistentResultSummary(ownerASet);
            const bReadSummary = persistentResultSummary(ownerBRead);
            const bSetSummary = persistentResultSummary(ownerBSet);
            const aReadSummary = persistentResultSummary(ownerARead);
            const crossOk = resultSucceeded(aSetSummary, "cross-a-set")
              && resultSucceeded(bReadSummary, "cross-b-isolated")
              && !bReadSummary.output.includes("cross-leaked")
              && resultSucceeded(bSetSummary, "cross-b-set")
              && resultSucceeded(aReadSummary, "cross-a-retained");
            crossAgentEvidence = {
              ownerASet: aSetSummary,
              ownerBRead: bReadSummary,
              ownerBSet: bSetSummary,
              ownerARead: aReadSummary,
              crossOk,
            };
              const crossDisposed = await disposeOwnedHandleBounded(crossHandle, `${modeId}:cross-agent-dispose`);
              if (crossDisposed.status !== "fulfilled") {
                throw new Error(JSON.stringify(crossDisposed.error));
              }
            const crossIndex = agents.indexOf(crossHandle);
            if (crossIndex >= 0) agents.splice(crossIndex, 1);
            crossHandle = undefined;
            addCheck(evidence, `${modeId}:cross-agent-isolation`, crossOk ? "PASS" : "FAIL",
              crossOk ? "two mode Agents kept independent persistent state" : "mode Agent state leaked across owners",
              crossAgentEvidence);
          } catch (error) {
            if (crossHandle !== undefined) {
              try { await disposeOwnedHandleBounded(crossHandle, `${modeId}:cross-agent-error-dispose`); } catch {}
              const crossIndex = agents.indexOf(crossHandle);
              if (crossIndex >= 0) agents.splice(crossIndex, 1);
            }
            crossAgentEvidence = { error: sanitize(error), crossOk: false };
            addCheck(evidence, `${modeId}:cross-agent-isolation`, "FAIL", "cross-Agent isolation probe threw", crossAgentEvidence);
          }
          }
          // The returned persistent-tool output is the authoritative proof of
          // shell reuse: the second command observed an export from the first.
          // rc.2's isolated terminal service may report no public snapshot once
          // a command has settled, so that optional observer is recorded rather
          // than turned into a false failure.
          const lifecycleOk = observerInstalled && positiveSpawnDelta > 0
            && firstResultSummary.parsedExitCode === 0
            && secondResultSummary.parsedExitCode === 0
            && firstResultSummary.isError !== true
            && secondResultSummary.isError !== true
            && firstResultSummary.error === null
            && secondResultSummary.error === null
            && firstResultSummary.timedOut !== true
            && secondResultSummary.timedOut !== true
            && firstResultSummary.aborted !== true
            && secondResultSummary.aborted !== true
            && output.includes("new-mode-owner-a")
            && output.includes("new-mode-owner-a-persisted")
            && (modeId !== "bash-wsl" || publicSessionObserved);
          addCheck(evidence, `${modeId}:native-lifecycle`, lifecycleOk ? "PASS" : "FAIL",
            lifecycleOk ? "persistent mode preserves owner state across serial calls and owns a live terminal" : "persistent mode did not preserve owner state or publish an owned terminal", {
              permissionBefore,
              permissionAfter,
              output: sanitize(output),
              firstResult: firstResultSummary,
              secondResult: secondResultSummary,
              terminalBackendsBefore,
              terminalActivity,
              terminalSnapshots,
              publicSessionObserved,
              publicSessionObservation,
              positiveSpawnDelta,
              observerInstalled,
              observerInstallErrors,
              nativeSpawns: nativeSpawns.map((entry) => ({
                ...entry,
                argv: entry.argv?.map((value) => sanitize(value, [[workspace, "<workspace>"]])),
                cwd: typeof entry.cwd === "string" ? sanitize(entry.cwd, [[workspace, "<workspace>"]]) : null,
              })),
              nativeHandleCapabilities,
            });
          const hadActivity = terminalActivity;
          const snapshotsBeforeDispose = terminalSnapshots;
            const ownerDisposeHandleEventsBefore = nativeHandleEvents.slice();
            let cleanupObservationError;
            const handleDisposed = await disposeOwnedHandleBounded(handle, `${modeId}:owner-dispose`);
            if (handleDisposed.status !== "fulfilled") {
              cleanupObservationError = JSON.stringify(handleDisposed.error);
            }
          const disposedIndex = agents.indexOf(handle);
          if (disposedIndex >= 0) agents.splice(disposedIndex, 1);
          let afterActivity;
          let snapshotsAfterDispose;
          let nativeHandleSettlements;
            let ownerDisposeBatchStability;
            let ownerDisposeHandleEvents;
            let ownerDisposeHandleEventsLate;
            let ownerDisposeHandleResults;
            let ownerDisposeHandleCapabilities;
              let ownerDisposeHandleEventCountAfterSettlement;
              let ownerDisposeHandleEventCountAfterIdentity;
              let ownerDisposeLateSettlementPasses = 0;
              let ownerDisposePostSettlementStability;
          try {
              ownerDisposeBatchStability = await waitForNativeHandleBatchQuiescence(
                nativeHandleEvents,
                ownerDisposeHandleEventsBefore.length,
              );
              ownerDisposeHandleEvents = nativeHandleEvents.slice();
              ownerDisposeHandleEventsLate = ownerDisposeHandleEvents.slice(
                ownerDisposeHandleEventsBefore.length,
              );
              ownerDisposeHandleResults = ownerDisposeHandleEvents.map((event) => event.result);
              ownerDisposeHandleCapabilities = ownerDisposeHandleEvents.map((event) => event.capability);
              nativeHandleSettlements = await settleObservedHandleResults(ownerDisposeHandleResults, 5_000);
                let settledEventCount = ownerDisposeHandleEvents.length;
                // A quiet observer window is only a snapshot.  A handle may publish
                // its public result while the first batch is being settled, so give
                // late observations a bounded second chance and keep the final
                // event count explicit in the evidence.
                for (let pass = 0; pass < 2; pass += 1) {
                  const lateEvents = nativeHandleEvents.slice(settledEventCount);
                  if (lateEvents.length > 0) {
                    ownerDisposeLateSettlementPasses += 1;
                    const lateSettlements = await settleObservedHandleResults(
                      lateEvents.map((event) => event.result),
                      5_000,
                    );
                    nativeHandleSettlements = [...nativeHandleSettlements, ...lateSettlements];
                    settledEventCount = nativeHandleEvents.length;
                  }
                  ownerDisposePostSettlementStability = await waitForNativeHandleBatchQuiescence(
                    nativeHandleEvents,
                    ownerDisposeHandleEventsBefore.length,
                  );
                  const observedCount = ownerDisposePostSettlementStability.finalCount;
                  if (observedCount === settledEventCount) break;
                  if (observedCount < settledEventCount) {
                    cleanupObservationError = "native handle observation count decreased during final quiescence";
                    break;
                  }
                }
                ownerDisposeHandleEvents = nativeHandleEvents.slice();
                ownerDisposeHandleEventsLate = ownerDisposeHandleEvents.slice(
                  ownerDisposeHandleEventsBefore.length,
                );
                ownerDisposeHandleResults = ownerDisposeHandleEvents.map((event) => event.result);
                ownerDisposeHandleCapabilities = ownerDisposeHandleEvents.map((event) => event.capability);
                ownerDisposeHandleEventCountAfterSettlement = nativeHandleEvents.length;
                if (ownerDisposeHandleEventCountAfterSettlement !== settledEventCount) {
                  cleanupObservationError ??= "native handle observations continued after the bounded settlement window";
                }
          } catch (error) {
            cleanupObservationError = sanitize(error);
          }
          try {
            afterActivity = modeTerminals?.hasOwnerActivity?.(handle.agent) === true;
            snapshotsAfterDispose = modeTerminals?.list?.(handle.agent)?.map((row) => ({
              sessionId: row.sessionId ?? row.id ?? null,
              type: row.type ?? row.backendType ?? null,
              status: row.status ?? null,
              pid: row.pid ?? row.processId ?? null,
            })) ?? [];
          } catch (error) {
            cleanupObservationError = sanitize(error);
            snapshotsAfterDispose = undefined;
          }
          let processAfterOwnerDispose;
          let processAfterOwnerDisposeRows = [];
          if (Array.isArray(processLedgerEvidence?.naturalOwnedIdentities)) {
            const deadline = Date.now() + 2_000;
            do {
              processAfterOwnerDispose = windowsProcessSnapshot();
              processAfterOwnerDisposeRows = processAfterOwnerDispose.rows
                .filter((row) => processLedgerEvidence.naturalOwnedIdentities.includes(processIdentity(row)));
              if (processAfterOwnerDisposeRows.length === 0) break;
              await new Promise((resolveResult) => setTimeout(resolveResult, 50));
            } while (Date.now() < deadline);
          }
            ownerDisposeHandleEventCountAfterIdentity = nativeHandleEvents.length;
            if (ownerDisposeHandleEventCountAfterSettlement !== undefined
              && ownerDisposeHandleEventCountAfterIdentity !== ownerDisposeHandleEventCountAfterSettlement) {
              cleanupObservationError ??= "native handle observations changed after process identity cleanup observation";
            }
          const processCleanupOk = minimalEnabled || modeId !== "bash-git-bash"
            || (processLedgerEvidence?.available === true
              && processLedgerEvidence?.observationErrors?.length === 0
              && processLedgerEvidence?.delayedMarkerCreated === false
              && processAfterOwnerDispose?.available === true
              && processAfterOwnerDisposeRows.length === 0);
            const ownerDisposeHandleCount = ownerDisposeHandleEvents?.length ?? 0;
            const nativeHandlesSettled = Array.isArray(nativeHandleSettlements)
              && ownerDisposeBatchStability?.quiescent === true
              && ownerDisposePostSettlementStability?.quiescent === true
              && nativeHandleSettlements.length === ownerDisposeHandleCount
              && ownerDisposeHandleEventCountAfterSettlement === ownerDisposeHandleCount
              && ownerDisposeHandleEventCountAfterIdentity === ownerDisposeHandleCount
            && nativeHandleSettlements.every((entry) => entry.status === "fulfilled");
            const nativeHandleApiOk = Array.isArray(ownerDisposeHandleCapabilities)
              && ownerDisposeHandleCapabilities.length === ownerDisposeHandleCount
              && ownerDisposeHandleCapabilities.length > 0
              && ownerDisposeHandleCapabilities.every((capability) => capability.hasDone
              && capability.hasWaitForExit
              && capability.hasTerminate
              && capability.resolveError === undefined);
          const cleanupOk = cleanupObservationError === undefined
            && nativeHandlesSettled
            && nativeHandleApiOk
            && processCleanupOk
            && afterActivity === false
            && Array.isArray(snapshotsAfterDispose)
            && snapshotsAfterDispose.length === 0;
          if (modeId === "bash-git-bash") {
            const helperCapabilityOk = nativePtyEvidence?.helperSpawnObserved === true
              && nativeHandleApiOk
              && nativeHandlesSettled
              && afterActivity === false
              && Array.isArray(snapshotsAfterDispose)
              && snapshotsAfterDispose.length === 0;
            addCheck(evidence, `${modeId}:helper-job-quiescence`, helperCapabilityOk ? "PASS" : "FAIL",
              helperCapabilityOk
                ? "broker helper/native ConPTY handles reported done and waitForExit after owner disposal with zero owned terminal activity"
                : "broker helper/native ConPTY cleanup did not prove public handle settlement and zero owned terminal activity",
              {
                nativePtyEvidence: nativePtyEvidence ?? null,
                nativeHandleCapabilities: ownerDisposeHandleCapabilities,
                nativeHandleSettlements: nativeHandleSettlements?.map((entry) => ({
                  status: entry.status,
                  value: entry.status === "fulfilled" ? {
                    done: entry.value?.done ?? null,
                    waitForExit: entry.value?.waitForExit ?? null,
                  } : undefined,
                  reason: entry.status === "rejected" ? sanitize(entry.reason) : undefined,
                })),
                nativeHandlesSettled,
                nativeHandleApiOk,
                nativeHandleBatch: {
                    semantics: "observer events; not a physical-process count; each settled handle is checked by done/waitForExit",
                  capturedBeforeDispose: ownerDisposeHandleEventsBefore.length,
                  capturedAfterQuiescence: ownerDisposeHandleCount,
                  lateCount: ownerDisposeHandleEventsLate?.length ?? null,
                    lateSettlementPasses: ownerDisposeLateSettlementPasses,
                    finalCountAfterSettlement: ownerDisposeHandleEventCountAfterSettlement ?? null,
                    finalCountAfterIdentity: ownerDisposeHandleEventCountAfterIdentity ?? null,
                  stability: ownerDisposeBatchStability ?? null,
                    postSettlementStability: ownerDisposePostSettlementStability ?? null,
                  events: nativeHandleEventEvidence(ownerDisposeHandleEvents),
                },
                afterActivity: afterActivity ?? null,
                snapshotsAfterDispose: snapshotsAfterDispose ?? null,
                processCleanupOk,
                processObservationErrors: [
                  ...(processLedgerEvidence?.observationErrors ?? []),
                  processAfterOwnerDispose?.observationError,
                ].filter(Boolean),
                processAfterOwnerDisposeRows: sanitizeProcessRows(processAfterOwnerDisposeRows, [[workspace, "<workspace>"]]),
              });
          }
          addCheck(evidence, `${modeId}:owner-dispose`, cleanupOk ? "PASS" : "FAIL",
            cleanupOk ? "owned mode Agent disposal left no terminal activity or owned session" : "owned mode Agent disposal cleanup could not prove zero terminal activity/sessions", {
              hadActivityBeforeDispose: hadActivity,
              snapshotsBeforeDispose,
              afterActivity: afterActivity ?? null,
              snapshotsAfterDispose: snapshotsAfterDispose ?? null,
                nativeHandleCount: ownerDisposeHandleCount,
              nativeHandlesSettled,
              nativeHandleApiOk,
                nativeHandleCapabilities: ownerDisposeHandleCapabilities,
              nativeHandleSettlements: nativeHandleSettlements?.map((entry) => ({
                status: entry.status,
                value: entry.status === "fulfilled" ? {
                  done: entry.value?.done ?? null,
                  waitForExit: entry.value?.waitForExit ?? null,
                } : undefined,
                reason: entry.status === "rejected" ? sanitize(entry.reason) : undefined,
              })),
              processCleanupOk,
              processObservationErrors: [
                ...(processLedgerEvidence?.observationErrors ?? []),
                processAfterOwnerDispose?.observationError,
              ].filter(Boolean),
              processAfterOwnerDisposeRows: sanitizeProcessRows(processAfterOwnerDisposeRows, [[workspace, "<workspace>"]]),
              cleanupObservationError: cleanupObservationError ?? null,
                nativeHandleBatch: {
                semantics: "observer events; not a physical-process count; each settled handle is checked by done/waitForExit",
                  capturedBeforeDispose: ownerDisposeHandleEventsBefore.length,
                  capturedAfterQuiescence: ownerDisposeHandleCount,
                  lateCount: ownerDisposeHandleEventsLate?.length ?? null,
                lateSettlementPasses: ownerDisposeLateSettlementPasses,
                finalCountAfterSettlement: ownerDisposeHandleEventCountAfterSettlement ?? null,
                finalCountAfterIdentity: ownerDisposeHandleEventCountAfterIdentity ?? null,
                  stability: ownerDisposeBatchStability ?? null,
                postSettlementStability: ownerDisposePostSettlementStability ?? null,
                  events: nativeHandleEventEvidence(ownerDisposeHandleEvents),
                },
            });
        }
      } finally {
        for (const observer of nativeStdoutAllObservers) {
          try { observer.restore(); } catch {}
        }
        const observerErrorsAfterRestore = observerErrorsFromAttempts(nativeStdoutObserverAttempts);
        if (observerErrorsAfterRestore.length > 0 && backgroundEvidenceRecord) {
          backgroundEvidenceRecord.backgroundOk = false;
          backgroundEvidenceRecord.observerErrorsAfterRestore = observerErrorsAfterRestore;
          backgroundEvidenceRecord.baseline = {
            ...(backgroundEvidenceRecord.baseline ?? {}),
            rawObserverErrors: observerErrorsAfterRestore,
          };
          if (backgroundEvidenceRecord.rawStdoutTrace) {
            backgroundEvidenceRecord.rawStdoutTrace = {
              ...backgroundEvidenceRecord.rawStdoutTrace,
              observerAttempts: nativeStdoutObserverAttempts.map(stdoutObserverAttemptSnapshot),
              snapshots: nativeStdoutObservers.map((observer) => observer.snapshot()),
              discoverySnapshots: nativeStdoutDiscoveryObservers.map((observer) => observer.snapshot()),
              observerErrorsAfterRestore,
            };
          }
          if (backgroundCheckRecord) {
            backgroundCheckRecord.status = "FAIL";
            backgroundCheckRecord.detail = "public stdout observer query/install/restore errors were observed";
            backgroundCheckRecord.evidence = backgroundEvidenceRecord;
          }
          appendCheckDiagnostic({
            type: "check-finalize",
            id: `${modeId}:background-process-cleanup`,
            modeId,
            status: "FAIL",
            detail: "public stdout observer query/install/restore errors were observed",
            evidence: { observerErrorsAfterRestore },
          });
        }
        for (const { service, methodName, original } of originalSpawnMethods) {
          try { if (service[methodName] !== original) service[methodName] = original; } catch {}
        }
      }
    }

    // Create the retained WSL Agent only after both mode lifecycle checks.  A
    // live persistent shell intentionally prevents the host from switching a
    // session to danger-full-access, so holding it earlier would make the Git
    // Bash explicit-permission check impossible rather than meaningful.
      if (pluginFiber?.dispose && !minimalEnabled && !diagnosticAdvanced) {
      try {
        const agentService = ctx.get("agents");
        retainedHandle = await agentService.create({
          sessionId: `desktop-new-mode-retained-${process.pid}`,
          meta: { cwd: workspace, agentPreset: "bash-wsl" },
          agentOptions: { provider: "desktop-new-mode-probe", model: "desktop-new-mode-probe" },
          setup: async (agentCtx) => { await presets.mount(agentCtx, "bash-wsl"); },
        });
        retainedAgent = retainedHandle.agent;
        agents.push(retainedHandle);
        const retainedTools = presets.serviceFor(retainedAgent, "tools") ?? retainedAgent.ctx.get("tools");
        await executeOwnedTool(retainedTools, "bash", retainedAgent, { command: "export DSH_NEW_MODE_OWNER=owner-a; printf 'retained-before-unload\\n'" });
        addCheck(evidence, "retained-agent-setup", presets.composedPreset(retainedAgent.ctx) === "bash-wsl" ? "PASS" : "FAIL",
          presets.composedPreset(retainedAgent.ctx) === "bash-wsl" ? "owned WSL Agent is live for retained-revision unload evidence" : "retained WSL Agent did not mount its selected mode", { composedPreset: presets.composedPreset(retainedAgent.ctx) });
      } catch (error) {
        addCheck(evidence, "retained-agent-setup", "FAIL", "could not create the owned WSL Agent needed for retained-revision evidence", { error: sanitize(error) });
      }
    }
    const compositionView = (agentCtx = undefined) => {
      if (typeof presets.inspectCompositions === "function") {
        return { apiAvailable: true, rows: presets.inspectCompositions(agentCtx) };
      }
      // Desktop rc.2 does not export the later inventory helper.  Its
      // official composedPreset(owner) read is still a direct retained-revision
      // witness; use it and label the missing global inspector explicitly.
      return {
        apiAvailable: false,
        rows: agentCtx === undefined
          ? []
          : [{ id: presets.composedPreset(agentCtx), directOwnerWitness: true }],
      };
    };
    if (retainedAgent && retainedHandle && pluginFiber?.dispose) {
      const retainedBeforeView = compositionView(retainedAgent.ctx);
      const globalBeforeView = compositionView();
      const retainedBefore = retainedBeforeView.rows;
      const globalBefore = globalBeforeView.rows;
      let retainedOutput = "";
      const retainedTools = presets.serviceFor(retainedAgent, "tools") ?? retainedAgent.ctx.get("tools");
      const rootBashBeforeUnload = toolFingerprint(tools, "bash");
      const retainedBashBeforeUnload = toolFingerprint(retainedTools, "bash", retainedAgent);
      let unloadError;
      let bundleReloadAttempted = false;
      let bundleReloadDiagnostics;
      let bundleSelection;
      try {
        if (typeof boot.loadProfileDirectory !== "function"
          || typeof boot.readProfilePatches !== "function"
          || typeof boot.reconcileProfilePatches !== "function") {
          throw new Error("official profile layer reload API is unavailable");
        }
        // Retire the installed bundle in the isolated profile and ask the
        // official app-boot reconciler to remove the complete bundle layer.
        // This is intentionally stronger than disposing only the core plugin
        // fiber: the sibling persistent/one-shot/prompt rows own resources too.
        bundleSelection = retireInstalledBundle(profileDir);
        const reloadedProfile = boot.loadProfileDirectory("dsh", profileDir, installAnchor);
        const reloadedPatches = boot.readProfilePatches("dsh", profileContext, reloadedProfile);
        bundleReloadDiagnostics = await boot.reconcileProfilePatches(ctx, reloadedPatches, "desktop-new-mode-probe");
        bundleReloadAttempted = true;
      } catch (error) {
        unloadError = sanitize(error);
      }
      // The retained call is deliberately after the complete bundle-layer
      // retirement: this proves an already-mounted Agent keeps its old
      // revision, rather than merely proving that the command worked before
      // unload.
      try {
        const result = await executeOwnedTool(retainedTools, "bash", retainedAgent, { command: "if [ \"${DSH_NEW_MODE_OWNER-}\" = owner-a ]; then printf 'retained-after-unload\\n'; fi" });
        retainedOutput = textOf(result);
      } catch (error) { retainedOutput = sanitize(error); }
      const rosterAfterUnload = await presets.remoteExportList();
      const listAfterUnload = await presets.list();
      const rootNamesAfterUnload = schemaNames(tools);
      let backendsAfterUnload = [];
      try { backendsAfterUnload = typeof terminals.listBackends === "function" ? terminals.listBackends() : []; } catch {}
      const rootBashAfterUnload = toolFingerprint(tools, "bash");
      let standardAfterReloadHandle;
      let standardBashAfterReload;
      let standardToolNamesAfterReload = [];
      let standardComposedPresetAfterReload = null;
      try {
        const agentService = ctx.get("agents");
        if (bundleReloadAttempted && agentService?.create && typeof presets.mount === "function") {
          standardAfterReloadHandle = await agentService.create({
            sessionId: `desktop-new-mode-standard-after-reload-${process.pid}`,
            meta: { cwd: workspace, agentPreset: "standard" },
            agentOptions: { provider: "desktop-new-mode-probe", model: "desktop-new-mode-probe" },
            setup: async (agentCtx) => { await presets.mount(agentCtx, "standard"); },
          });
          agents.push(standardAfterReloadHandle);
          const standardToolsAfterReload = presets.serviceFor(standardAfterReloadHandle.agent, "tools")
            ?? standardAfterReloadHandle.agent.ctx.get("tools");
          standardBashAfterReload = toolFingerprint(standardToolsAfterReload, "bash", standardAfterReloadHandle.agent);
          standardToolNamesAfterReload = schemaNames(standardToolsAfterReload, standardAfterReloadHandle.agent);
          standardComposedPresetAfterReload = presets.composedPreset(standardAfterReloadHandle.agent.ctx);
        }
      } catch (error) {
        standardBashAfterReload = { error: sanitize(error) };
      }
      let globalPromptAfterUnload;
      let globalPromptModeSections = [];
      try {
        globalPromptAfterUnload = typeof prompts.assemble === "function" ? await prompts.assemble({}) : undefined;
        globalPromptModeSections = globalPromptAfterUnload?.sections?.filter((entry) => entry.name === PROMPT_SECTION) ?? [];
      } catch (error) {
        globalPromptAfterUnload = { error: sanitize(error) };
        globalPromptModeSections = [{ error: sanitize(error) }];
      }
      const retainedAfterView = compositionView(retainedAgent.ctx);
      const globalAfterView = compositionView();
      const retainedAfter = retainedAfterView.rows;
      const globalAfter = globalAfterView.rows;
      const retainedDefinition = !rosterAfterUnload.presets.some((row) => EXPECTED_MODE_IDS.includes(row.id))
        && !listAfterUnload.some((row) => EXPECTED_MODE_IDS.includes(row.id));
      const retainedComposition = retainedAfter.some((row) => row.id === "bash-wsl") && retainedOutput.includes("retained-after-unload");
      const stockBashRestored = standardBashAfterReload?.executeSha256 !== null
        && standardBashAfterReload?.executeSha256 !== undefined
        && rootBashAfterUnload.executeSha256 === standardBashAfterReload.executeSha256
        && rootBashAfterUnload.executeSha256 !== retainedBashBeforeUnload.executeSha256;
      const pluginBashRemovedOrStockRestored = !rootBashAfterUnload.exists || stockBashRestored;
      const standardScopePreserved = standardComposedPresetAfterReload === "standard"
        && standardToolNamesAfterReload.includes("pwsh")
        && !standardToolNamesAfterReload.includes("wsl_bash")
        && !standardToolNamesAfterReload.includes("git_bash");
      const rootClean = bundleReloadAttempted
        && !rootNamesAfterUnload.includes("wsl_bash")
        && !rootNamesAfterUnload.includes("git_bash")
        && !backendsAfterUnload.includes("wsl")
        && !backendsAfterUnload.includes("git-bash")
        && globalPromptModeSections.length === 0
        && pluginBashRemovedOrStockRestored
        && standardScopePreserved;
      addCheck(evidence, "plugin-unload-retained-revision", unloadError === undefined && retainedDefinition && retainedComposition ? "PASS" : "FAIL",
        unloadError === undefined && retainedDefinition && retainedComposition
          ? "bundle-layer removal retires new selection while the live Agent keeps its exact old mode revision"
          : "bundle-layer removal did not preserve the owned Agent revision or did not retire the roster", {
          unloadError: unloadError ?? null,
          bundleReloadAttempted,
          bundleSelection,
          bundleReloadDiagnostics: bundleReloadDiagnostics ?? null,
          rosterAfterUnload: rosterAfterUnload.presets,
          retainedBefore,
          globalBefore,
          retainedAfter,
          globalAfter,
          inspectionApiAvailable: retainedAfterView.apiAvailable,
          retainedOutput: sanitize(retainedOutput),
        });
      addCheck(evidence, "plugin-unload-root-cleanup", unloadError === undefined && rootClean ? "PASS" : "FAIL",
        unloadError === undefined && rootClean ? "complete bundle unload removed plugin root tools, prompt, and terminal backends while preserving stock Bash" : "complete bundle unload left plugin-owned root tools, prompt, terminal backend, or an unverified persistent Bash definition", {
          bundleReloadAttempted,
          rootToolNamesBefore: schemaNames(tools),
          rootToolNamesAfter: rootNamesAfterUnload,
          terminalBackendsAfter: backendsAfterUnload,
          rootBashBeforeUnload,
          retainedBashBeforeUnload,
          rootBashAfterUnload,
          standardBashAfterReload,
          stockBashRestored,
          pluginBashRemovedOrStockRestored,
          standardToolNamesAfterReload,
          standardComposedPresetAfterReload,
          standardScopePreserved,
          globalPromptModeSections,
          globalPromptAfterUnload: globalPromptAfterUnload?.error ? globalPromptAfterUnload : { sectionNames: globalPromptAfterUnload?.sections?.map((entry) => entry.name) ?? [] },
        });
      const liveModePrompt = typeof prompts.assemble === "function" ? await prompts.assemble({ agent: retainedAgent, scope: retainedAgent }) : undefined;
      const retainedPromptSection = liveModePrompt?.sections?.find((entry) => entry.name === PROMPT_SECTION);
      addCheck(evidence, "plugin-unload-retained-prompt", retainedPromptSection?.interpolate === false ? "PASS" : "FAIL",
        retainedPromptSection?.interpolate === false ? "retained mode scope keeps its literal mode prompt until the Agent is released" : "retained mode scope lost or interpolated its prompt unexpectedly", {
          sectionPresent: retainedPromptSection !== undefined,
          interpolate: retainedPromptSection?.interpolate ?? null,
        });
      const retainedTerminals = presets.serviceFor(retainedAgent, "terminals") ?? retainedAgent.ctx.get("terminals");
      let retainedActivityBeforeDispose = false;
      let retainedSnapshotsBeforeDispose = [];
      let retainedCleanupObservationError;
      try {
        retainedActivityBeforeDispose = retainedTerminals?.hasOwnerActivity?.(retainedAgent) === true;
        retainedSnapshotsBeforeDispose = retainedTerminals?.list?.(retainedAgent)?.map((row) => ({
          sessionId: row.sessionId ?? row.id ?? null,
          type: row.type ?? row.backendType ?? null,
          status: row.status ?? null,
          pid: row.pid ?? row.processId ?? null,
        })) ?? [];
      } catch (error) {
        retainedCleanupObservationError = sanitize(error);
      }
        const retainedDisposed = await disposeOwnedHandleBounded(retainedHandle, "retained-agent-dispose");
        if (retainedDisposed.status !== "fulfilled") {
          retainedCleanupObservationError ??= JSON.stringify(retainedDisposed.error);
          addCheck(evidence, "retained-agent-dispose", "FAIL", "retained Agent disposal did not settle within the test deadline", { error: retainedDisposed.error });
        }
      const retainedIndex = agents.indexOf(retainedHandle);
      if (retainedIndex >= 0) agents.splice(retainedIndex, 1);
      let retainedActivityAfterDispose;
      let retainedSnapshotsAfterDispose;
      try {
        retainedActivityAfterDispose = retainedTerminals?.hasOwnerActivity?.(retainedAgent) === true;
        retainedSnapshotsAfterDispose = retainedTerminals?.list?.(retainedAgent)?.map((row) => ({
          sessionId: row.sessionId ?? row.id ?? null,
          type: row.type ?? row.backendType ?? null,
          status: row.status ?? null,
          pid: row.pid ?? row.processId ?? null,
        })) ?? [];
      } catch (error) {
        retainedCleanupObservationError = retainedCleanupObservationError ?? sanitize(error);
      }
      const afterReleaseView = compositionView(retainedAgent.ctx);
      const afterRelease = afterReleaseView.rows;
      const released = !afterRelease.some((row) => EXPECTED_MODE_IDS.includes(row.id));
      const terminalReleased = retainedCleanupObservationError === undefined && retainedActivityAfterDispose === false && Array.isArray(retainedSnapshotsAfterDispose) && retainedSnapshotsAfterDispose.length === 0;
      addCheck(evidence, "retained-revision-release", released && terminalReleased ? "PASS" : "FAIL",
        released && terminalReleased ? "after the owned Agent was released no native mode revision or terminal activity remained" : "a native mode revision or terminal activity remained after all owned Agents were released", {
          retainedActivityBeforeDispose,
          retainedSnapshotsBeforeDispose,
          retainedActivityAfterDispose: retainedActivityAfterDispose ?? null,
          retainedSnapshotsAfterDispose: retainedSnapshotsAfterDispose ?? null,
          retainedCleanupObservationError: retainedCleanupObservationError ?? null,
          compositionsAfterRelease: afterRelease,
          inspectionApiAvailable: afterReleaseView.apiAvailable,
        });
    } else if (!minimalEnabled && !diagnosticAdvanced) {
      addCheck(evidence, "plugin-unload-retained-revision", "FAIL", "no retained WSL Agent/plugin fiber was available for the required unload semantics");
    }
    const finalDefault = presets.defaultId;
    const finalStandard = await presets.readDocument("standard");
    const finalStandardParsed = standard.yaml.load(finalStandard.content, { schema: standard.include.entryListSchema });
    addCheck(evidence, "stock-default-after-unload", finalDefault === initialDefault && sha256Bytes(JSON.stringify(finalStandardParsed)) === initialStandardHash && (await presets.resolve("standard")).id === "standard" ? "PASS" : "FAIL",
      finalDefault === initialDefault ? "selected default and Standard declaration remain unchanged after mode unload" : "selected default or Standard declaration changed after mode unload", {
        defaultBefore: initialDefault,
        defaultAfter: finalDefault,
        standardBefore: initialStandardHash,
        standardAfter: sha256Bytes(JSON.stringify(finalStandardParsed)),
      });
    evidence.status = checks.some((check) => check.status === "FAIL") ? "FAIL" : checks.some((check) => check.status === "SKIP") ? "SKIP" : "PASS";
  } catch (error) {
    addCheck(evidence, "enabled-child-startup", "FAIL", "real Desktop enabled child failed", { error: sanitize(error) });
    evidence.status = "FAIL";
  } finally {
    for (const handle of agents.toReversed()) {
        const disposed = await disposeOwnedHandleBounded(handle, "enabled-child-agent-dispose");
        if (disposed.status !== "fulfilled") {
          addCheck(evidence, "enabled-child-agent-dispose", "FAIL", "owned Agent disposal did not settle within the test deadline", { error: disposed.error });
          evidence.status = "FAIL";
        }
    }
      const shutdownResult = await shutdownBounded(shutdown, "enabled-child-shutdown");
      if (shutdownResult.status !== "fulfilled") {
        addCheck(evidence, "enabled-child-shutdown", "FAIL", "Desktop child shutdown did not settle within the test deadline", { error: shutdownResult.error });
        evidence.status = "FAIL";
      }
  }
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  process.stdout.write(`NEW_MODES_CHILD ${JSON.stringify({ status: evidence.status, checks: checks.length })}\n`);
}

async function disabledChildMain(argv) {
  const [runtimeDir, profileDir, pnpm, nodeBin, evidencePath, workspace, diagnosticPath] = argv;
  configureCheckDiagnostics(diagnosticPath, [
    [runtimeDir, "<runtime>"],
    [profileDir, "<profile>"],
    [workspace, "<workspace>"],
  ]);
  const checks = [];
  const evidence = { schemaVersion: 1, phase: "disabled", runtime: "installed Desktop app.asar/dsh", checks };
  let shutdown;
  try {
    const { boot, dsh, systemPrompt } = await loadChildRuntime(runtimeDir);
    const installAnchor = join(runtimeDir, "node_modules", "@deepseek-ai", "dsh", "package.json");
    const standard = await readOfficialStandard(installAnchor);
    const profile = boot.loadProfileDirectory("dsh", profileDir, installAnchor);
    const started = await dsh.runProfile({
      environment: boot.loadLayeredEnv("dsh"),
      profile: "desktop",
      resolvedProfile: { profile, installAnchor },
      patchFiles: [],
      args: ["--no-open", "--port", String(await reserveLocalPort())],
      packageManager: {
        command: process.execPath,
        args: ["--expose-internals", pnpm],
        env: { ELECTRON_RUN_AS_NODE: "1", DSH_DESKTOP_NODE_EXECUTABLE: process.execPath, DSH_CLIENT_VERSION: EXPECTED_DESKTOP_VERSION, DSH_TELEMETRY_DISABLED: "1", PATH: `${dirname(nodeBin)}${delimiter}${process.env.PATH ?? ""}` },
      },
    });
    shutdown = started.shutdown;
    const { ctx } = started;
    const presets = ctx.get("agentPresets");
    const tools = ctx.get("tools");
    const terminals = ctx.get("terminals");
    const promptService = ctx.get("systemPrompt");
    const roster = await presets.remoteExportList();
    const names = schemaNames(tools);
    const backends = typeof terminals?.listBackends === "function" ? terminals.listBackends() : [];
    const pluginModeAbsent = !roster.presets.some((row) => EXPECTED_MODE_IDS.includes(row.id));
    const pluginToolsAbsent = !names.includes("wsl_bash") && !names.includes("git_bash");
    const pluginBackendsAbsent = !backends.includes("wsl") && !backends.includes("git-bash");
    addCheck(evidence, "disabled-roster", pluginModeAbsent ? "PASS" : "FAIL", pluginModeAbsent ? "disabled profile exposes no native mode definitions" : "native mode definitions remained after plugin disable", { roster: roster.presets });
    addCheck(evidence, "disabled-tools-and-backends", pluginToolsAbsent && pluginBackendsAbsent ? "PASS" : "FAIL", pluginToolsAbsent && pluginBackendsAbsent ? "plugin one-shot tools and terminal backends are absent" : "plugin tool/backend remained after disable", { toolNames: names, terminalBackends: backends });
    const agentService = ctx.get("agents");
    let standardAgent;
    if (agentService?.create === undefined || typeof presets?.mount !== "function") {
      addCheck(evidence, "disabled-standard-agent-capability", "FAIL", "disabled profile could not create and mount an official standard Agent; absence is not a PASS", {
        agentsCreate: typeof agentService?.create === "function",
        presetsMount: typeof presets?.mount === "function",
      });
    } else {
      const handle = await agentService.create({
        sessionId: `desktop-disabled-standard-${process.pid}`,
        meta: { cwd: workspace, agentPreset: "standard" },
        agentOptions: { provider: "desktop-new-mode-probe", model: "desktop-new-mode-probe" },
        setup: async (agentCtx) => { await presets.mount(agentCtx, "standard"); },
      });
      if (handle?.agent === undefined || typeof handle.dispose !== "function") {
        addCheck(evidence, "disabled-standard-agent-capability", "FAIL", "official standard Agent factory returned no disposable owned handle");
      } else {
        standardAgent = handle;
        addCheck(evidence, "disabled-standard-agent-capability", "PASS", "disabled profile created and mounted an official standard Agent");
        const standardTools = presets.serviceFor(handle.agent, "tools") ?? handle.agent.ctx.get("tools");
        const standardNames = schemaNames(standardTools, handle.agent);
        const standardPrompt = typeof promptService?.assemble === "function" ? await promptService.assemble({ agent: handle.agent, scope: handle.agent }) : undefined;
        const promptAbsent = standardPrompt?.sections?.every((entry) => entry.name !== PROMPT_SECTION) && !String(typeof systemPrompt.renderPrompt === "function" ? systemPrompt.renderPrompt(standardPrompt) : "").includes(PLUGIN_ROW_NAME);
        const standardHasPwsh = flattenRows(standard.plugins).some((row) => row.name === "@deepseek-ai/dsh-tool-pwsh");
        addCheck(evidence, "disabled-standard-preserved", standardHasPwsh && promptAbsent ? "PASS" : "FAIL", standardHasPwsh && promptAbsent ? "official standard remains declared with pwsh and without the plugin prompt" : "disabled standard lost the official pwsh row or retained the plugin prompt", { standardToolNames: standardNames, promptAbsent, standardRows: flattenRows(standard.plugins).map((row) => row.name) });
      }
    }
    if (standardAgent) {
        const standardDisposed = await disposeOwnedHandleBounded(standardAgent, "disabled-standard-agent-dispose");
        if (standardDisposed.status !== "fulfilled") {
          addCheck(evidence, "disabled-standard-agent-dispose", "FAIL", "disabled standard Agent disposal did not settle within the test deadline", { error: standardDisposed.error });
          evidence.status = "FAIL";
        }
    }
    evidence.status = checks.some((check) => check.status === "FAIL") ? "FAIL" : checks.some((check) => check.status === "SKIP") ? "SKIP" : "PASS";
  } catch (error) {
    addCheck(evidence, "disabled-child-startup", "FAIL", "real Desktop disabled child failed", { error: sanitize(error) });
    evidence.status = "FAIL";
  } finally {
      const shutdownResult = await shutdownBounded(shutdown, "disabled-child-shutdown");
      if (shutdownResult.status !== "fulfilled") {
        addCheck(evidence, "disabled-child-shutdown", "FAIL", "Desktop child shutdown did not settle within the test deadline", { error: shutdownResult.error });
        evidence.status = "FAIL";
      }
  }
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  process.stdout.write(`NEW_MODES_CHILD ${JSON.stringify({ status: evidence.status, checks: checks.length })}\n`);
}

function preservePartialDiagnostics(tempRoot, logs, labels) {
  const destination = join(RUN_ROOT, `new-modes-desktop-partial-${Date.now()}`);
  mkdirSync(destination, { recursive: true });
  const names = [
    "pnpm.stdout.log",
    "pnpm.stderr.log",
    ...labels.flatMap((label) => [
      `${label}.stdout.log`,
      `${label}.stderr.log`,
      `${label}.progress.jsonl`,
    ]),
  ];
  const copied = [];
  const missing = [];
  for (const name of names) {
    const source = join(logs, name);
    if (!existsSync(source)) {
      missing.push(name);
      continue;
    }
    const text = readFileSync(source, "utf8");
    const replacements = [[tempRoot, "<test-root>"], [logs, "<logs>"]];
    const sanitizedText = text
      .split(/\r?\n/)
      .map((line) => sanitize(line, replacements))
      .join("\n");
    writeFileSync(join(destination, name), sanitizedText);
    copied.push(name);
  }
  return {
    root: relative(ROOT, destination).replaceAll("\\", "/"),
    copied,
    missing,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    target: `Desktop ${EXPECTED_DESKTOP_VERSION} / plugin ${EXPECTED_PLUGIN_VERSION} native modes`,
    probeIdentity: {
      sourcePath: "dev/测试/桌面/new-modes-desktop-artifact.mjs",
      sourceSha256: sha256(fileURLToPath(import.meta.url)),
    },
    checks: [],
    phases: [],
    phaseFilter: options.phase ?? null,
    scope: options.scope ?? null,
    onlyCheck: options.only ?? null,
    cleanup: {},
  };
  let tempRoot;
  let asar;
  const protectedBefore = protectedProfileSnapshot();
  try {
    if (process.platform !== "win32") {
      addCheck(report, "desktop-capability", "SKIP", "actual Desktop runtime requires Windows Node");
      return report;
    }
    const paths = desktopPaths();
    if (!paths || !existsSync(paths.executable) || !existsSync(paths.asar)) {
      addCheck(report, "desktop-capability", "SKIP", "installed DeepSeek Harness executable/app.asar is unavailable");
      return report;
    }
    if (!existsSync(paths.node) || !existsSync(paths.pnpm)) {
      addCheck(report, "desktop-runtime-launcher", "SKIP", "bundled Desktop Node or pnpm runtime is unavailable");
      return report;
    }
    asar = openAsar(paths.asar);
    const appManifest = asar.readJson("package.json");
    const dshManifest = asar.readJson("dsh/package.json");
    const descriptor = asar.readJson("dsh/desktop-runtime.json");
    const versionOk = appManifest.version === EXPECTED_DESKTOP_VERSION && dshManifest.version === EXPECTED_DESKTOP_VERSION && descriptor.release?.version === EXPECTED_DESKTOP_VERSION && descriptor.platform === "win32" && descriptor.arch === "x64";
    addCheck(report, "desktop-runtime-version", versionOk ? "PASS" : "FAIL", versionOk ? "installed app.asar is the expected Desktop rc.2 runtime" : "installed Desktop runtime version/platform metadata mismatched", { appVersion: appManifest.version, dshVersion: dshManifest.version, descriptorVersion: descriptor.release?.version ?? null, platform: descriptor.platform ?? null, arch: descriptor.arch ?? null });
    const actualAsarSha256 = sha256(paths.asar);
    const actualExeSha256 = sha256(paths.executable);
    addCheck(report, "desktop-runtime-hashes", actualAsarSha256 === EXPECTED_ASAR_SHA256 && actualExeSha256 === EXPECTED_EXE_SHA256 ? "PASS" : "FAIL", actualAsarSha256 === EXPECTED_ASAR_SHA256 && actualExeSha256 === EXPECTED_EXE_SHA256 ? "installed Desktop ASAR/executable hashes match the frozen rc.2 fixture" : "installed Desktop ASAR/executable hash differs from the frozen fixture", { appAsarSha256: actualAsarSha256, executableSha256: actualExeSha256 });
    if (typeof options.tgz !== "string") {
      addCheck(report, "new-tgz-input", "SKIP", "--tgz was not supplied; no package/profile load was attempted");
      return report;
    }
    const tgz = resolve(options.tgz);
    if (!existsSync(tgz) || extname(tgz).toLowerCase() !== ".tgz") throw new Error("--tgz must point to an existing .tgz");
    const packageAudit = inspectTarball(tgz);
    addCheck(report, "tgz-content-dependency-path-audit", packageAudit.status, packageAudit.status === "PASS" ? "new TGZ contains only release files, expected host peers/dependency and current dist bytes" : "new TGZ failed content/dependency/private-path/hash/release-file audit", packageAudit);
    if (packageAudit.sha256 === OLD_CANONICAL_TGZ_SHA256 || resolve(tgz) === resolve(join(ROOT, "dsh-plugin-bash-wsl-0.2.0.tgz"))) {
      addCheck(report, "new-tgz-independence", "FAIL", "the new mode probe must not consume or overwrite the old canonical 0.2.0 TGZ", { sha256: packageAudit.sha256, path: relative(ROOT, tgz) });
      return report;
    }
    mkdirSync(RUN_ROOT, { recursive: true });
    tempRoot = mkdtempSync(join(RUN_ROOT, "new-modes-desktop-"));
    if (!isInside(realpathSync(RUN_ROOT), tempRoot)) throw new Error("new mode temporary root escaped 测试/运行产物");
    const dshHome = join(tempRoot, "dsh-home");
    const profile = join(dshHome, "profiles", "desktop");
    const workspace = join(tempRoot, "workspace 中文 space");
    const logs = join(tempRoot, "logs");
    const npmrc = join(tempRoot, "npmrc");
    mkdirSync(profile, { recursive: true });
    mkdirSync(workspace, { recursive: true });
    mkdirSync(logs, { recursive: true });
    writeFileSync(npmrc, "# test-owned isolated npm config; no credentials\n");
    writeProfile(profile, tgz, true, TEST_PERSISTENT_TIMEOUT_MS);
    const profileBeforeInstall = profileFilesSnapshot(profile);
    const install = await runOwnedProcess(paths.node, [
      paths.pnpm,
      "install",
      "--no-frozen-lockfile",
      "--ignore-scripts",
      "--store-dir",
      join(tempRoot, "pnpm-store"),
      `--config.cacheDir=${join(tempRoot, "pnpm-cache")}`,
      "--config.auto-install-peers=false",
    ], {
      cwd: profile,
      env: { DSH_HOME: dshHome, COREPACK_ENABLE_PROJECT_SPEC: "0", NPM_CONFIG_USERCONFIG: npmrc, npm_config_userconfig: npmrc, NPM_CONFIG_OFFLINE: "true", npm_config_offline: "true", NPM_CONFIG_AUDIT: "false", npm_config_audit: "false", NPM_CONFIG_FUND: "false", npm_config_fund: "false", TEMP: logs, TMP: logs, TMPDIR: logs },
      stdoutPath: join(logs, "pnpm.stdout.log"),
      stderrPath: join(logs, "pnpm.stderr.log"),
      timeoutMs: INSTALL_TIMEOUT_MS,
    });
    const installedManifestPath = join(profile, "node_modules", PLUGIN_ROW_NAME, "package.json");
    const installedOk = install.code === 0
      && install.signal === null
      && install.error === undefined
      && install.timedOut === false
      && install.closeObserved
      && install.reaped
      && existsSync(installedManifestPath)
      && readJsonFile(installedManifestPath).version === EXPECTED_PLUGIN_VERSION;
    const installedDist = installedDistIdentity(profile, packageAudit);
    addCheck(report, "desktop-profile-installed-dist-identity", installedOk && installedDist.match ? "PASS" : "FAIL",
      installedOk && installedDist.match
        ? "installed profile dist bytes match the current source dist and candidate TGZ"
        : "installed profile dist bytes do not match the current source dist/candidate TGZ",
      installedDist);
    addCheck(report, "desktop-profile-offline-install", installedOk ? "PASS" : "FAIL", installedOk ? "new TGZ installed into an isolated Desktop profile with bundled pnpm and a test-owned store/cache" : "isolated Desktop profile install failed or installed the wrong plugin", { exitCode: install.code, signal: install.signal ?? null, timedOut: install.timedOut, closeObserved: install.closeObserved, reaped: install.reaped, error: install.error ?? null, stdout: sanitize(install.stdout, [[tempRoot, "<test-root>"]]), stderr: sanitize(install.stderr, [[tempRoot, "<test-root>"]]) });
    if (!installedOk) return report;
    const phases = [
      ["disabled-before", false, "disabled"],
      ["enabled-retained", true, "enabled"],
      ["disabled-after", false, "disabled"],
    ].filter(([label]) => options.phase === undefined || label === options.phase);
    for (const [label, enabled, childMode] of phases) {
        writeProfile(profile, tgz, enabled, enabled ? TEST_PERSISTENT_TIMEOUT_MS : undefined);
      const evidencePath = join(tempRoot, `${label}.json`);
      const childScript = fileURLToPath(import.meta.url);
      // Only the installed Electron executable has the ASAR module loader. A
      // system Node child would report app.asar/dsh as ERR_MODULE_NOT_FOUND and
      // would not be evidence from the real Desktop runtime.
      const childArgs = childMode === "enabled"
        ? ["--expose-internals", childScript, "--enabled-child", paths.runtimeDir, profile, paths.pnpm, paths.node, evidencePath, workspace, join(logs, `${label}.progress.jsonl`), "workspace-write", options.scope ?? "", options.only ?? ""]
        : ["--expose-internals", childScript, "--disabled-child", paths.runtimeDir, profile, paths.pnpm, paths.node, evidencePath, workspace, join(logs, `${label}.progress.jsonl`)];
      const phaseTimeoutMs = childMode === "enabled"
        ? 600_000
        : CHILD_TIMEOUT_MS;
      const result = await runOwnedProcess(paths.executable, childArgs, {
        cwd: workspace,
        env: { ELECTRON_RUN_AS_NODE: "1", ELECTRON_NO_ATTACH_CONSOLE: "1", DSH_HOME: dshHome, DSH_DESKTOP_PROBE: "1", DSH_CLIENT_VERSION: EXPECTED_DESKTOP_VERSION, DSH_TELEMETRY_DISABLED: "1", DSH_PRODUCT_ANALYTICS_OTLP_URL: "http://127.0.0.1:1/v1/logs", NPM_CONFIG_USERCONFIG: npmrc, npm_config_userconfig: npmrc, NPM_CONFIG_OFFLINE: "true", npm_config_offline: "true", NPM_CONFIG_AUDIT: "false", npm_config_audit: "false", NPM_CONFIG_FUND: "false", npm_config_fund: "false", TEMP: logs, TMP: logs, TMPDIR: logs },
        stdoutPath: join(logs, `${label}.stdout.log`),
        stderrPath: join(logs, `${label}.stderr.log`),
        // Focused lifecycle diagnostics get a whole-phase budget large enough
        // to include the real 10s tool deadline plus the complete marker
        // window and owner cleanup. Per-command/settlement deadlines remain
        // in the installed profile and helper code.
        timeoutMs: phaseTimeoutMs,
      });
      const childEvidence = existsSync(evidencePath) ? readJsonFile(evidencePath) : undefined;
      const phaseStatus = childEvidence?.status ?? "FAIL";
      report.phases.push({ label, enabled, childMode, phaseTimeoutMs, status: phaseStatus, child: { exitCode: result.code, signal: result.signal, timedOut: result.timedOut, closeObserved: result.closeObserved, reaped: result.reaped, error: result.error ?? null }, evidence: childEvidence ?? null, logs: { stdout: relative(ROOT, join(logs, `${label}.stdout.log`)), stderr: relative(ROOT, join(logs, `${label}.stderr.log`)) } });
      const phaseLifecycleClean = result.code === 0
        && result.signal === null
        && result.error === undefined
        && result.timedOut === false
        && result.closeObserved
        && result.reaped;
      addCheck(report, `${label}:desktop-child`, phaseStatus === "PASS" && phaseLifecycleClean ? "PASS" : phaseStatus === "SKIP" ? "SKIP" : "FAIL", phaseStatus === "PASS" && phaseLifecycleClean ? "real Desktop child completed the requested profile phase" : `real Desktop child phase reported ${phaseStatus} or had an unclean lifecycle`, { childExitCode: result.code, signal: result.signal ?? null, timedOut: result.timedOut, closeObserved: result.closeObserved, reaped: result.reaped, error: result.error ?? null, childStatus: phaseStatus });
    }
    const profileAfter = profileFilesSnapshot(profile);
    const profileRevisionApplicable = options.phase === undefined;
    addCheck(report, "owned-profile-revision-scope", profileRevisionApplicable
      ? (profileBeforeInstall["package.json"]?.sha256 !== profileAfter["package.json"]?.sha256 ? "PASS" : "FAIL")
      : "SKIP",
      profileRevisionApplicable
        ? "profile bundle revisions were changed only in the owned temporary profile"
        : "phase-filtered diagnostic omitted the complete profile revision cycle",
      { before: profileBeforeInstall, after: profileAfter, temporaryRoot: relative(ROOT, tempRoot), applicable: profileRevisionApplicable });
    report.package = { path: relative(ROOT, tgz), ...packageAudit };
    report.status = report.checks.some((check) => check.status === "FAIL") ? "FAIL" : report.checks.some((check) => check.status === "SKIP") ? "SKIP" : "PASS";
  } catch (error) {
    addCheck(report, "new-modes-probe-uncaught", "FAIL", "new mode Desktop artifact probe threw", { error: sanitize(error) });
    report.status = "FAIL";
  } finally {
    if (asar) asar.close();
    const protectedAfter = protectedProfileSnapshot();
    const protectedUnchanged = JSON.stringify(protectedBefore) === JSON.stringify(protectedAfter);
    addCheck(report, "protected-stock-default-profile", protectedUnchanged ? "PASS" : "FAIL", protectedUnchanged ? "real web/desktop profile metadata remained unchanged" : "real web/desktop profile metadata changed during the isolated probe", { before: protectedBefore, after: protectedAfter });
    if (tempRoot) {
      try {
        report.partialDiagnostics = preservePartialDiagnostics(
          tempRoot,
          join(tempRoot, "logs"),
          report.phases.map((phase) => phase.label),
        );
      } catch (error) {
        report.partialDiagnostics = { error: sanitize(error) };
        addCheck(report, "partial-diagnostics", "FAIL", "owned Desktop phase diagnostics could not be preserved before temporary-root cleanup", { error: sanitize(error) });
      }
    }
    if (tempRoot && !options.keep) {
      try { rmSync(tempRoot, { recursive: true, force: true }); report.cleanup.temporaryRootRemoved = true; }
      catch (error) { report.cleanup.temporaryRootRemoved = false; addCheck(report, "cleanup", "FAIL", "owned temporary profile could not be removed", { error: sanitize(error) }); }
    } else if (tempRoot) {
      report.cleanup.temporaryRootRemoved = false;
      report.cleanup.retainedForDebug = true;
    }
  }
  return report;
}

async function run() {
  if (process.argv[2] === "--enabled-child") {
    await enabledChildMain(process.argv.slice(3));
    return;
  }
  if (process.argv[2] === "--disabled-child") {
    await disabledChildMain(process.argv.slice(3));
    return;
  }
  let report;
  try { report = await main(); }
  catch (error) {
    report = { schemaVersion: 1, target: "Desktop native modes", checks: [{ id: "uncaught", status: "FAIL", detail: sanitize(error) }], phases: [], cleanup: {} };
  }
  mkdirSync(RUN_ROOT, { recursive: true });
  const evidencePath = join(RUN_ROOT, `new-modes-desktop-evidence-${nowTag()}.json`);
  writeFileSync(evidencePath, `${JSON.stringify(report, null, 2)}\n`);
  const passed = report.checks.filter((check) => check.status === "PASS").length;
  const skipped = report.checks.filter((check) => check.status === "SKIP").length;
  const failed = report.checks.filter((check) => check.status === "FAIL").length;
  console.log(`New native modes Desktop probe: ${passed} passed, ${skipped} skipped, ${failed} failed`);
  console.log(`Evidence: ${relative(ROOT, evidencePath).replaceAll("\\", "/")}`);
  process.exitCode = failed > 0 || skipped > 0 ? 1 : 0;
}

await run();
