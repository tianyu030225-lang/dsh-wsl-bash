#!/usr/bin/env node

/**
 * Desktop 0.2.0 acceptance probe.
 *
 * The parent process uses the installed Desktop Electron executable and the
 * real app.asar runtime.  The child process starts the same Desktop profile
 * loader used by dsh-desktop-host, then inspects and calls the mounted tools in
 * the live Cordis context.  No CLI executable, source snapshot, model, or
 * network service is used as a substitute for the Desktop runtime.
 *
 * Usage from a Windows Node host:
 *   node dev/测试/桌面/desktop-context-probe.mjs --tgz <absolute-tgz>
 *   node dev/测试/桌面/desktop-context-probe.mjs --desktop-runtime-negative --tgz <preserved-old-tgz>
 *
 * All temporary profile/workspace data is created below 测试/运行产物 and is
 * removed in the parent finally block.  The final JSON evidence file contains
 * only sanitized metadata and assertion summaries.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import {
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
const EXPECTED_DESKTOP_VERSION = "0.2.0-rc.2";
const EXPECTED_PLUGIN_VERSION = "0.2.0";
const EXPECTED_TOOLS = ["bash", "wsl_bash", "git_bash"];
const DESKTOP_PEER_PACKAGES = {
  "@deepseek-ai/cordis": new Set(["4.0.4", "4.0.5-alpha.1"]),
  "@deepseek-ai/dsh": new Set(["0.2.0-rc.2", "0.2.1-alpha.1"]),
  "@deepseek-ai/dsh-agent": new Set(["0.2.0-rc.2", "0.2.1-alpha.1"]),
  "@deepseek-ai/dsh-app-boot": new Set(["0.2.0-rc.2", "0.2.1-alpha.1"]),
  "@deepseek-ai/dsh-sandbox": new Set(["0.2.0-rc.2", "0.2.1-alpha.1"]),
  "@deepseek-ai/dsh-sandbox-policy": new Set(["0.2.0-rc.2", "0.2.1-alpha.1"]),
  "@deepseek-ai/dsh-subprocess": new Set(["0.2.0-rc.2", "0.2.1-alpha.1"]),
  "@deepseek-ai/dsh-system-prompt": new Set(["0.2.0-rc.2", "0.2.1-alpha.1"]),
  "@deepseek-ai/dsh-terminal": new Set(["0.2.0-rc.2", "0.2.1-alpha.1"]),
  "@deepseek-ai/dsh-tool-bash-persistent": new Set(["0.2.0-rc.2", "0.2.1-alpha.1"]),
  "@deepseek-ai/dsh-tools": new Set(["0.2.0-rc.2", "0.2.1-alpha.1"]),
  "@deepseek-ai/dsh-user-approval": new Set(["0.2.0-rc.2", "0.2.1-alpha.1"]),
};
const PROMPT_SECTION = "dsh-plugin-bash-wsl:usage";
const MAX_LOG_CHARS = 8 * 1024;
const CHILD_TIMEOUT_MS = 180_000;
const TEST_PERSISTENT_TIMEOUT_MS = 10_000;

async function reserveLocalPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : undefined;
  await new Promise((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  });
  if (!Number.isInteger(port) || port <= 0) throw new Error("could not reserve an isolated Desktop localhost port");
  return port;
}

function nowTag() {
  return new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
}

function parseArgs(argv) {
  const options = { tgz: undefined, keep: false, phase: undefined, suite: undefined, noRemoteAnswerer: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--tgz") {
      options.tgz = argv[++index];
    } else if (argument === "--phase") {
      options.phase = argv[++index];
      if (!["present", "present-read-only", "present-full-access", "absent", "reloaded", "integration"].includes(options.phase)) {
        throw new Error(`unknown Desktop probe phase: ${options.phase}`);
      }
    } else if (argument === "--suite") {
      options.suite = argv[++index];
      if (!["security", "integration", "output-cap", "git-workdir"].includes(options.suite)) {
        throw new Error(`unknown Desktop probe shared suite: ${options.suite}`);
      }
    } else if (argument === "--keep") {
      options.keep = true;
    } else if (argument === "--no-answerer") {
      options.noRemoteAnswerer = true;
    } else if (argument !== "") {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  return options;
}

function addCheck(report, id, status, detail, evidence = undefined) {
  const check = { id, status, detail };
  if (evidence !== undefined) check.evidence = evidence;
  const checks = Array.isArray(report) ? report : report.checks;
  if (!Array.isArray(checks)) throw new Error("desktop probe check target is not a check list");
  checks.push(check);
  console.log(`${status.padEnd(5)} ${id} — ${detail}`);
  return check;
}

function sanitize(text, replacements = []) {
  let value = String(text ?? "");
  for (const [from, to] of replacements) {
    if (from) value = value.split(from).join(to);
  }
  // The real Desktop host prints a loopback web URL with a short-lived
  // session token during startup. Evidence must prove the host started
  // without retaining that bearer-like value in test artifacts.
  value = value.replace(/([?&]token=)[^\s&#]+/gi, "$1<redacted>");
  value = value.replace(/(authorization\s*:\s*bearer\s+)[^\s]+/gi, "$1<redacted>");
  return value.replace(/[\r\n]+/g, " ").slice(-MAX_LOG_CHARS);
}

function isInside(parent, child) {
  const parentPath = resolve(parent);
  const childPath = resolve(child);
  const prefix = parentPath.endsWith("\\") || parentPath.endsWith("/")
    ? parentPath
    : `${parentPath}${childPath.includes("\\") ? "\\" : "/"}`;
  return childPath === parentPath || childPath.startsWith(prefix);
}

function assertTempRoot(root) {
  mkdirSync(RUN_ROOT, { recursive: true });
  const runReal = realpathSync(RUN_ROOT);
  const candidate = resolve(root);
  if (!isInside(runReal, candidate)) {
    throw new Error(`temporary root escaped 测试/运行产物: ${candidate}`);
  }
}

function sha256(path) {
  const hash = createHash("sha256");
  const fd = openSync(path, "r");
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

function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

function probeIdentityFromHashes({
  sourceProbeIndexSha256,
  installedProbeIndexSha256,
  sourceProbeObserverSha256,
  installedProbeObserverSha256,
}) {
  const isSha256 = (value) => typeof value === "string"
    && /^[0-9a-f]{64}$/i.test(value);
  const probeIndexHashesMatch = isSha256(sourceProbeIndexSha256)
    && isSha256(installedProbeIndexSha256)
    && sourceProbeIndexSha256 === installedProbeIndexSha256;
  const probeObserverRequired = true;
  const probeObserverHashesMatch = isSha256(sourceProbeObserverSha256)
    && isSha256(installedProbeObserverSha256)
    && sourceProbeObserverSha256 === installedProbeObserverSha256;
  return {
    sourceProbeIndexSha256,
    installedProbeIndexSha256,
    probeIndexHashesMatch,
    probeObserverRequired,
    probeSourceObserverSha256: sourceProbeObserverSha256,
    probeInstalledObserverSha256: installedProbeObserverSha256,
    probeObserverHashesMatch,
  };
}

function protectedProfileSnapshot() {
  const localAppData = process.env.LOCALAPPDATA;
  const userProfile = process.env.USERPROFILE
    ?? (localAppData === undefined ? undefined : dirname(dirname(localAppData)));
  if (userProfile === undefined) return {};
  const dshRoot = join(userProfile, ".dsh");
  const candidates = [
    ["web/package.json", join(dshRoot, "profiles", "web", "package.json")],
    ["web/pnpm-lock.yaml", join(dshRoot, "profiles", "web", "pnpm-lock.yaml")],
    ["web/cordis.patch.yml", join(dshRoot, "profiles", "web", "cordis.patch.yml")],
    ["web/plugin/package.json", join(dshRoot, "profiles", "web", "node_modules", "dsh-plugin-bash-wsl", "package.json")],
    ["desktop/package.json", join(dshRoot, "profiles", "desktop", "package.json")],
    ["desktop/pnpm-lock.yaml", join(dshRoot, "profiles", "desktop", "pnpm-lock.yaml")],
    ["desktop/cordis.patch.yml", join(dshRoot, "profiles", "desktop", "cordis.patch.yml")],
    ["desktop/plugin/package.json", join(dshRoot, "profiles", "desktop", "node_modules", "dsh-plugin-bash-wsl", "package.json")],
    ["root/old-plugin-0.1.0.tgz", join(ROOT, "dsh-plugin-bash-wsl-0.1.0.tgz")],
  ];
  return Object.fromEntries(candidates
    .filter(([, path]) => existsSync(path) && statSync(path).isFile())
    .map(([label, path]) => [label, { sha256: sha256(path), bytes: statSync(path).size }]));
}

/** Minimal read-only ASAR reader for package metadata and the runtime digest. */
function openAsar(path) {
  const fd = openSync(path, "r");
  const prefix = Buffer.alloc(16);
  readSync(fd, prefix, 0, prefix.length, 0);
  // ASAR stores a four-byte pickle prefix followed by a four-byte total
  // header size. The JSON tree starts at the end of that pickle header; using
  // the boundary field keeps this reader correct when the JSON/pickle padding
  // differs between Electron builds.
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
    const parts = pathName.split("/").filter(Boolean);
    let current = tree;
    for (const part of parts) {
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
      const target = String(value.link);
      const parent = pathName.includes("/") ? `${pathName.slice(0, pathName.lastIndexOf("/"))}/` : "";
      const targetPath = target.startsWith("/") ? target.slice(1) : `${parent}${target}`;
      return resolvedEntry(targetPath, seen);
    }
    return value;
  }

  function read(pathName) {
    const value = resolvedEntry(pathName);
    if (value === undefined || value.files !== undefined) {
      throw new Error(`ASAR file is missing: ${pathName}`);
    }
    if (!Number.isSafeInteger(value.size) || !Number.isSafeInteger(Number(value.offset ?? 0))) {
      throw new Error(`ASAR entry is not a regular file: ${pathName}`);
    }
    const content = Buffer.alloc(value.size);
    readSync(fd, content, 0, value.size, dataStart + Number(value.offset ?? 0));
    return content;
  }

  return {
    read,
    readJson(pathName) {
      return JSON.parse(read(pathName).toString("utf8"));
    },
    close() {
      closeSync(fd);
    },
  };
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
    // The installed Desktop keeps its Windows Node binary in the primary
    // runtime dependency tree. `runtime/bin/node` is only a shell shim and
    // has no `.exe` sibling on the current rc.2 installation.
    node: join(
      resources,
      "runtime",
      "primary-runtime",
      "dependencies",
      "node",
      "bin",
      "node.exe",
    ),
    pnpm: join(resources, "runtime", "pnpm", "bin", "pnpm.mjs"),
  };
}

function jsonFile(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function tgzPackageManifest(path) {
  try {
    const tar = gunzipSync(readFileSync(path));
    let offset = 0;
    while (offset + 512 <= tar.length) {
      const header = tar.subarray(offset, offset + 512);
      const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/s, "");
      if (name.length === 0) break;
      const sizeText = header.subarray(124, 136).toString("ascii").replace(/\0.*$/s, "").trim();
      const size = Number.parseInt(sizeText || "0", 8);
      if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > tar.length) return undefined;
      if (name === "package/package.json") return JSON.parse(tar.subarray(offset + 512, offset + 512 + size).toString("utf8"));
      offset += 512 + Math.ceil(size / 512) * 512;
    }
  } catch {}
  return undefined;
}

function extractPackageTgz(tgzPath, targetRoot) {
  const archive = gunzipSync(readFileSync(tgzPath));
  mkdirSync(targetRoot, { recursive: true });
  let offset = 0;
  let extracted = 0;
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    const rawName = header.subarray(0, 100).toString("utf8").replace(/\0.*$/s, "");
    if (rawName.length === 0) break;
    const sizeText = header.subarray(124, 136).toString("ascii").replace(/\0.*$/s, "").trim();
    const size = Number.parseInt(sizeText || "0", 8);
    if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > archive.length) {
      throw new Error(`old TGZ has an invalid tar entry: ${rawName}`);
    }
    const type = String.fromCharCode(header[156] || 0);
    const relativeName = rawName.replace(/^\.\//, "").replace(/^package\//, "");
    if (relativeName.length === 0) {
      offset += 512 + Math.ceil(size / 512) * 512;
      continue;
    }
    const destination = resolve(targetRoot, relativeName);
    if (!isInside(targetRoot, destination)) {
      throw new Error(`old TGZ entry escaped its owned extraction root: ${rawName}`);
    }
    if (type === "5" || rawName.endsWith("/")) {
      mkdirSync(destination, { recursive: true });
    } else if (type === "0" || type === "\0") {
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, archive.subarray(offset + 512, offset + 512 + size));
      extracted += 1;
    } else {
      throw new Error(`old TGZ contains unsupported tar entry type ${type || "0"}: ${rawName}`);
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  if (!existsSync(join(targetRoot, "package.json")) || extracted === 0) {
    throw new Error("old TGZ did not extract a package.json and regular package files");
  }
  return extracted;
}

function packageNames(values) {
  if (!Array.isArray(values)) return [];
  return values.map((value) => {
    if (typeof value === "string") return value;
    if (value === null || typeof value !== "object") return undefined;
    return value.name ?? value.id ?? value.package ?? value.bundle ?? value.key ?? value.packageName;
  }).filter((value) => typeof value === "string");
}

function runtimeProfileSummary(profile) {
  const skippedBundles = Array.isArray(profile?.skippedBundles)
    ? profile.skippedBundles
    : profile?.skippedBundles instanceof Set
      ? [...profile.skippedBundles]
      : [];
  const activeCandidates = [
    profile?.bundles,
    profile?.layers,
    profile?.loadedBundles,
    profile?.activeLayers,
  ].find((value) => Array.isArray(value));
  const activeLayers = packageNames(activeCandidates);
  const layerPackages = Array.isArray(profile?.layers)
    ? profile.layers.map((value) => value?.packageName).filter((value) => typeof value === "string")
    : [];
  const resolvedActiveLayers = activeLayers.length > 0 ? activeLayers : layerPackages;
  const skippedNames = packageNames(skippedBundles);
  const diagnostics = skippedBundles.map((value) => {
    if (typeof value === "string") return value;
    if (value === null || typeof value !== "object") return String(value ?? "");
    return value.reason ?? value.diagnostic ?? value.message ?? value.error ?? JSON.stringify(value);
  }).filter(Boolean).join(" ");
  const layerDetails = Array.isArray(profile?.layers)
    ? profile.layers.map((value) => {
      if (typeof value === "string") return { value };
      if (value === null || typeof value !== "object") return { value: String(value ?? "") };
      const scalarValues = Object.fromEntries(Object.entries(value)
        .filter(([, item]) => item === null || ["string", "number", "boolean"].includes(typeof item))
        .slice(0, 16));
      return { keys: Object.keys(value).sort(), scalarValues };
    })
    : [];
  return {
    activeLayers: resolvedActiveLayers,
    skippedBundles: skippedNames,
    diagnostic: diagnostics,
    profileKeys: profile !== null && typeof profile === "object" ? Object.keys(profile).sort() : [],
    layerDetails,
  };
}

function isolatedEnvironment(overrides = {}) {
  const filtered = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !/^(?:(?:DSH_|DEEPSEEK_|OPENAI_|ANTHROPIC_|AWS_|GITHUB_).*$|.*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PRIVATE[_-]?KEY))$/i.test(name),
  ));
  // process.env is passed as a sentinel by the launcher when it wants only
  // the filtered baseline. Never re-add that unfiltered object. Explicit
  // test-owned overrides are safe to add after the baseline is scrubbed.
  return overrides === process.env ? filtered : { ...filtered, ...overrides };
}

function packageSpec(profile, tgz) {
  const relativePath = relative(profile, tgz).replaceAll("\\", "/");
  const normalized = relativePath.startsWith(".") ? relativePath : `./${relativePath}`;
  return `file:${normalized}`;
}

function writeProfile(profile, tgz, enabled, probePackage, probeEnabled = false, noRemoteAnswerer = false, probeSuite = undefined) {
  const manifest = {
    name: "dsh-desktop-0.2-probe",
    private: true,
    dependencies: {
      "dsh-plugin-bash-wsl": packageSpec(profile, tgz),
      ...(probePackage === undefined ? {} : { "dsh-cli-probe": packageSpec(profile, probePackage) }),
    },
    dsh: {
      profile: {
        bundles: [
          "@deepseek-ai/dsh-base",
          "@deepseek-ai/dsh-web-app",
          ...(enabled ? ["dsh-plugin-bash-wsl"] : []),
          ...(probeEnabled ? ["dsh-cli-probe"] : []),
        ],
      },
    },
  };
  writeFileSync(join(profile, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(profile, "cordis.yml"), "[]\n");
  const profilePatches = [];
  if (probeEnabled) {
    profilePatches.push([
      "# Test-only isolated profile override; production package and store are untouched.",
      "- id: bash-wsl-persistent-tool",
      "  config:",
      "    backendType: wsl",
      `    timeoutMs: ${TEST_PERSISTENT_TIMEOUT_MS}`,
    ].join("\n"));
  }
  if (probeSuite === "output-cap") {
    profilePatches.push([
      "# Test-only low-cap override; production plugin patch and package store are untouched.",
      "- id: bash-wsl-backend-and-tools",
      "  config:",
      "    backendType: wsl",
      "    oneShotMaxOutputBytes: 4",
      "    oneShotMaxSpillBytes: 8",
    ].join("\n"));
  }
  if (noRemoteAnswerer) {
    profilePatches.push([
      "- id: api-remotes",
      "  name: '@deepseek-ai/dsh-api-remotes'",
      "  disabled: true",
    ].join("\n"));
  }
  writeFileSync(join(profile, "cordis.patch.yml"), profilePatches.length > 0
    ? `${profilePatches.join("\n")}\n`
    : "[]\n");
  writeFileSync(join(profile, "pnpm-workspace.yaml"), [
    "packages:",
    "  - .",
    "",
    "nodeLinker: hoisted",
    "autoInstallPeers: false",
    "",
  ].join("\n"));
}

function runCommand(executable, args, options = {}) {
  return new Promise((resolveResult) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: isolatedEnvironment(options.env ?? {}),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => { stdout = `${stdout}${chunk}`.slice(-MAX_LOG_CHARS); });
    child.stderr?.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-MAX_LOG_CHARS); });
      let timedOut = false;
      let pendingClose;
      const timer = setTimeout(async () => {
        timedOut = true;
        if (process.platform !== "win32") {
          try { child.kill("SIGTERM"); } catch {}
        }
        const close = await waitForChildClose(child, 15_000);
        const closeObserved = pendingClose !== undefined || close.observed;
        const aliveAfter = processAlive(child.pid);
        resolveResult({
          code: pendingClose?.code ?? close.code ?? null,
          signal: pendingClose?.signal ?? close.signal ?? "timeout",
          stdout,
          stderr,
          timedOut: true,
          cleanup: {
            attempted: false,
            closeObserved,
            aliveAfter,
            reaped: closeObserved && !aliveAfter,
            reason: process.platform === "win32"
              ? "timed-out Windows child identity was not proven; refusing PID-only taskkill"
              : "child received SIGTERM after timeout",
          },
        });
      }, options.timeoutMs ?? CHILD_TIMEOUT_MS);
      child.once("error", (error) => {
        if (timedOut) {
          pendingClose = { error: String(error) };
          return;
        }
        clearTimeout(timer);
        resolveResult({ code: null, signal: null, stdout, stderr, error: String(error), timedOut: false, cleanup: { attempted: false, closeObserved: false, aliveAfter: processAlive(child.pid), reaped: false } });
      });
      child.once("close", (code, signal) => {
        if (timedOut) {
          pendingClose = { code, signal };
          return;
        }
        clearTimeout(timer);
        resolveResult({ code, signal, stdout, stderr, timedOut: false, cleanup: { attempted: false, closeObserved: true, aliveAfter: false, reaped: true } });
    });
  });
}

function processAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function waitForChildClose(child, timeoutMs = 15_000) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({
      observed: true,
      code: child.exitCode,
      signal: child.signalCode,
    });
  }
  return new Promise((resolveResult) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("error", onError);
      child.off("close", onClose);
      resolveResult(result);
    };
    const onError = (error) => finish({
      observed: false,
      error: String(error),
    });
    const onClose = (code, signal) => finish({
      observed: true,
      code,
      signal,
    });
    const timer = setTimeout(() => finish({ observed: false }), timeoutMs);
    child.once("error", onError);
    child.once("close", onClose);
  });
}

async function stopProcessTree(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return {
      attempted: false,
      aliveAfter: false,
      closeObserved: true,
      exitCode: child.exitCode,
      signal: child.signalCode,
      reaped: true,
    };
  }
  if (process.platform !== "win32") {
    try { child.kill("SIGTERM"); } catch {}
  }
  const close = await waitForChildClose(child, 15_000);
  const aliveAfter = processAlive(child.pid);
  return {
    attempted: process.platform !== "win32",
    aliveAfter,
    closeObserved: close.observed,
    closeError: close.error,
    exitCode: close.code ?? null,
    signal: close.signal ?? null,
    reaped: close.observed && !aliveAfter,
    reason: process.platform === "win32"
      ? "timed-out Windows child identity was not proven; refusing PID-only taskkill"
      : "child received SIGTERM after timeout",
  };
}

function capabilitySkip(value) {
  let serialized = "";
  try { serialized = JSON.stringify(value); } catch {}
  const text = [
    String(value ?? ""),
    serialized,
    value?.message,
    value?.error,
    value?.failure?.message,
    value?.stderr?.text,
  ].filter(Boolean).join(" ");
  const capabilityName = /(?:wsl(?:\.exe)?|ubuntu|bwrap|\/usr\/bin\/script|git bash|git\.exe|runtime dependenc)/i;
  // Only a concrete missing-executable/path diagnostic is a capability skip.
  // Policy denial, unsupported mode, or a dependency that is present but
  // failed must remain FAIL and must not be hidden by words like "disabled".
  const unavailable = /(?:\bENOENT\b|not found|not recognized|cannot find|no such file|not installed|could not locate|failed to locate)/i;
  return capabilityName.test(text) && unavailable.test(text);
}

function requiredParameterNames(schema) {
  const parameters = schema?.parameters ?? schema?.inputSchema ?? {};
  const properties = parameters?.properties ?? parameters;
  const required = new Set(Array.isArray(parameters?.required) ? parameters.required : []);
  for (const [name, definition] of Object.entries(properties ?? {})) {
    if (definition?.required === true) required.add(name);
  }
  return [...required].sort();
}

function observeSubprocessSpawns(ctx) {
  const originalGet = ctx?.get;
  if (typeof originalGet !== "function") return { supported: false, delta: () => null, restore() {} };
  let service;
  try {
    service = originalGet.call(ctx, "subprocess");
  } catch {
    return { supported: false, delta: () => null, restore() {} };
  }
  if (service === undefined || typeof service.spawn !== "function") {
    return { supported: false, delta: () => null, restore() {} };
  }
  let count = 0;
  let restored = false;
  const originalSpawn = service.spawn;
  try {
      service.spawn = function observedSubprocessSpawn(...args) {
      count += 1;
        return Reflect.apply(originalSpawn, this, args);
    };
  } catch {
    return { supported: false, delta: () => null, restore() {} };
  }
  return {
    supported: true,
    delta: () => count,
    restore() {
      if (restored) return;
      restored = true;
      try {
        if (service.spawn !== originalSpawn) service.spawn = originalSpawn;
      } catch {}
    },
  };
}

async function executeTool(toolService, name, args, workspace, checks, options = {}) {
  const tool = toolService.get(name);
  if (tool === undefined || typeof tool.execute !== "function") {
    addCheck(checks, `tool-execute:${name}`, "FAIL", "registered tool has no executable definition");
    return;
  }
  const controller = new AbortController();
  const spawnObservation = options.observeSubprocess === true
    ? observeSubprocessSpawns(options.ctx)
    : undefined;
  let spawnDelta = null;
  let observationSupported = options.observeSubprocess !== true;
  try {
    const result = await tool.execute(args, {
      ...(options.agent === undefined ? {} : { agent: options.agent }),
      callId: `desktop-probe-${name}`,
      signal: controller.signal,
    });
    spawnObservation?.restore();
    spawnDelta = spawnObservation?.delta() ?? null;
    observationSupported = options.observeSubprocess !== true || spawnObservation?.supported === true;
    const output = result?.stdout?.text ?? "";
    if (options.expectedRestrictedDenial === true
      && result?.sandbox?.denied === true
      && result?.failure?.kind === "sandbox-denied") {
      const observedZeroSpawns = observationSupported && spawnDelta === 0;
      addCheck(checks, `tool-execute:${name}`, observedZeroSpawns ? "PASS" : "FAIL", observedZeroSpawns
        ? "real Desktop policy rejected Git Bash before process creation under restricted mode"
        : "Git Bash was denied but the test could not prove zero subprocess spawns", {
        denied: true,
        noExitCode: result.exitCode === null,
        failureKind: result.failure.kind,
        subprocessSpawnDelta: spawnDelta,
      });
      return;
    }
    const ok = result?.exitCode === 0 && result?.timedOut === false && result?.aborted === false
      && observationSupported && (options.observeSubprocess !== true || (typeof spawnDelta === "number" && spawnDelta > 0));
    if (ok && output.includes("desktop-probe:中文 空格")) {
      addCheck(checks, `tool-execute:${name}`, "PASS", "offline local command completed in the Chinese/space workspace", {
        exitCode: result.exitCode,
        stdoutMarker: true,
        sandboxMode: result.sandbox?.mode ?? "unknown",
        truncated: Boolean(result.stdout?.truncated || result.stderr?.truncated),
        observationSupported,
        subprocessSpawnDelta: spawnDelta,
      });
    } else if (options.expectedRestrictedDenial === true
      && /git_bash .*?(?:unavailable|restricted).*?(?:no process|sandbox)/i.test(String(result?.failure?.message ?? result?.stderr?.text ?? result))) {
      const observedZeroSpawns = observationSupported && spawnDelta === 0;
      addCheck(checks, `tool-execute:${name}`, observedZeroSpawns ? "PASS" : "FAIL", observedZeroSpawns
        ? "real Desktop policy rejected Git Bash before process creation under restricted mode"
        : "Git Bash was denied but the test could not prove zero subprocess spawns", {
        denied: true,
        failure: sanitize(result?.failure?.message ?? result?.stderr?.text),
        observationSupported,
        subprocessSpawnDelta: spawnDelta,
      });
    } else if (capabilitySkip(result)) {
      addCheck(checks, `tool-execute:${name}`, "SKIP", "host capability for the real local shell is unavailable", {
        exitCode: result?.exitCode ?? null,
        failure: sanitize(result?.failure?.message ?? result?.stderr?.text),
      });
    } else {
      addCheck(checks, `tool-execute:${name}`, "FAIL", "offline local command returned an unexpected result", {
        exitCode: result?.exitCode ?? null,
        timedOut: result?.timedOut ?? null,
        aborted: result?.aborted ?? null,
        stdoutMarker: output.includes("desktop-probe:中文 空格"),
        failure: sanitize(result?.failure?.message ?? result?.stderr?.text),
        observationSupported,
        subprocessSpawnDelta: spawnDelta,
      });
    }
  } catch (error) {
    spawnObservation?.restore();
    spawnDelta = spawnObservation?.delta() ?? null;
    if (options.expectedRestrictedDenial === true
      && /git_bash .*?(?:unavailable|restricted).*?(?:no process|sandbox)/i.test(String(error))) {
      const observedZeroSpawns = observationSupported && spawnDelta === 0;
      addCheck(checks, `tool-execute:${name}`, observedZeroSpawns ? "PASS" : "FAIL", observedZeroSpawns
        ? "real Desktop policy rejected Git Bash before process creation under restricted mode"
        : "Git Bash was denied but the test could not prove zero subprocess spawns", {
        denied: true,
        failure: sanitize(error),
        observationSupported,
        subprocessSpawnDelta: spawnDelta,
      });
      return;
    }
    if (capabilitySkip(error)) {
      addCheck(checks, `tool-execute:${name}`, "SKIP", "real local shell capability is unavailable", {
        error: sanitize(error),
        observationSupported,
      });
    } else {
      addCheck(checks, `tool-execute:${name}`, "FAIL", "real context tool invocation threw", {
        error: sanitize(error),
        observationSupported,
        subprocessSpawnDelta: spawnDelta,
      });
    }
  }
}

async function checkPersistentOwnership(toolService, workspace, checks, owners = []) {
  const tool = toolService.get("bash");
  if (tool === undefined || typeof tool.execute !== "function") {
    addCheck(checks, "desktop-context:persistent-owner-isolation", "FAIL", "registered bash tool has no executable definition");
    return;
  }
  if (owners.length < 2) {
    addCheck(checks, "desktop-context:persistent-owner-isolation", "SKIP", "the isolated Desktop profile has fewer than two registered agent owners; no synthetic unregistered owners were used", {
      registeredOwners: owners.length,
    });
    return;
  }
  const [agentA, agentB] = owners;
  const call = async (agent, callId, command) => tool.execute(
    { command },
    {
      agent,
      callId,
      signal: new AbortController().signal,
    },
  );
  try {
    const firstA = await call(
      agentA,
      "desktop-probe-bash-owner-a-1",
      "export DSH_DESKTOP_OWNER_MARKER=agent-a; printf 'owner-a-ready\\n'",
    );
    const firstB = await call(
      agentB,
      "desktop-probe-bash-owner-b-1",
      "if [ \"${DSH_DESKTOP_OWNER_MARKER-}\" = agent-a ]; then printf 'owner-leak\\n'; else printf 'owner-b-isolated\\n'; fi",
    );
    const secondA = await call(
      agentA,
      "desktop-probe-bash-owner-a-2",
      "if [ \"${DSH_DESKTOP_OWNER_MARKER-}\" = agent-a ]; then printf 'owner-a-persisted\\n'; else printf 'owner-a-lost\\n'; fi",
    );
    const outputs = [firstA, firstB, secondA].map((value) => String(value ?? ""));
    const passed = outputs[0].includes("owner-a-ready")
      && outputs[1].includes("owner-b-isolated")
      && !outputs[1].includes("owner-leak")
      && outputs[2].includes("owner-a-persisted");
    if (passed) {
      addCheck(checks, "desktop-context:persistent-owner-isolation", "PASS", "two real Desktop agent identities keep separate persistent state while owner A retains its state", {
        ownerA: "persisted",
        ownerB: "isolated",
      });
    } else {
      addCheck(checks, "desktop-context:persistent-owner-isolation", "FAIL", "persistent bash state was not isolated by agent owner", {
        ownerAReady: outputs[0].includes("owner-a-ready"),
        ownerBIsolated: outputs[1].includes("owner-b-isolated") && !outputs[1].includes("owner-leak"),
        ownerAPersisted: outputs[2].includes("owner-a-persisted"),
      });
    }
  } catch (error) {
    if (capabilitySkip(error)) {
      addCheck(checks, "desktop-context:persistent-owner-isolation", "SKIP", "real persistent WSL capability is unavailable", {
        error: sanitize(error),
      });
    } else {
      addCheck(checks, "desktop-context:persistent-owner-isolation", "FAIL", "persistent bash owner isolation invocation threw", {
        error: sanitize(error),
      });
    }
  }
}

async function loadChildRuntime(runtimeDir) {
  const importPackage = (packageName, fileName) => import(pathToFileURL(
    join(runtimeDir, "node_modules", "@deepseek-ai", packageName, "lib", fileName),
  ).href);
  const [boot, dsh, systemPrompt] = await Promise.all([
    importPackage("dsh-app-boot", "index.js"),
    import(pathToFileURL(join(runtimeDir, "node_modules", "@deepseek-ai", "dsh", "lib", "profile-boot.js")).href),
    importPackage("dsh-system-prompt", "index.js"),
  ]);
  return { boot, dsh, systemPrompt };
}

async function runtimeNegativeChildMain(argv) {
  const [runtimeDir, profileDir] = argv;
  const diagnostics = [];
  let summary = {
    activeLayers: [],
    skippedBundles: [],
    diagnostic: "",
    profileKeys: [],
    layerDetails: [],
  };
  let loaderError = null;
  const originalConsole = {
    debug: console.debug,
    info: console.info,
    warn: console.warn,
    error: console.error,
  };
  const capture = (...args) => {
    diagnostics.push(args.map((value) => String(value ?? "")).join(" "));
  };
  console.debug = capture;
  console.info = capture;
  console.warn = capture;
  console.error = capture;
  try {
    if (!runtimeDir || !profileDir) throw new Error("runtime-negative child arguments are incomplete");
    const { boot } = await loadChildRuntime(runtimeDir);
    const installAnchor = join(runtimeDir, "node_modules", "@deepseek-ai", "dsh", "package.json");
    try {
      const profile = boot.loadProfileDirectory("dsh", profileDir, installAnchor);
      summary = runtimeProfileSummary(profile);
    } catch (error) {
      loaderError = sanitize(error);
    }
  } catch (error) {
    loaderError = sanitize(error);
  } finally {
    console.debug = originalConsole.debug;
    console.info = originalConsole.info;
    console.warn = originalConsole.warn;
    console.error = originalConsole.error;
  }
  const diagnostic = [summary.diagnostic, loaderError, ...diagnostics]
    .filter(Boolean)
    .join(" ");
  const pluginSkipped = summary.skippedBundles.includes("dsh-plugin-bash-wsl")
    || /dsh-plugin-bash-wsl/i.test(diagnostic);
  const pluginLayerLoaded = summary.activeLayers.includes("dsh-plugin-bash-wsl");
  const expectedPeerMismatch = /dsh-plugin-bash-wsl[\s\S]*0\.1\.0-rc\.6|0\.1\.0-rc\.6[\s\S]*dsh-plugin-bash-wsl/i.test(diagnostic);
  process.stdout.write(`D14_RUNTIME_NEGATIVE_RESULT ${JSON.stringify({
    contextStarted: false,
    oldToolsPrompt: {
      registered: false,
      reason: "loadProfileDirectory negative stops before runProfile/context mount",
    },
    loaderResult: {
      activeLayers: summary.activeLayers,
      skippedBundles: summary.skippedBundles,
      skippedBundle: pluginSkipped ? "dsh-plugin-bash-wsl" : null,
      pluginLayerLoaded,
      diagnostic,
      expectedPeerMismatch,
      loaderError,
      profileKeys: summary.profileKeys,
      layerDetails: summary.layerDetails,
    },
  })}\n`);
  process.exitCode = 0;
}

async function waitForSharedProbeResult(resultPath, timeoutMs = 150_000) {
  const startedAt = Date.now();
  if (typeof resultPath !== "string" || resultPath.length === 0) {
    return {
      evidence: undefined,
      timeoutMs,
      waitedMs: 0,
      observationError: "DSH_PROBE_RESULT_FILE is missing",
    };
  }
  const deadline = startedAt + timeoutMs;
  let lastReadError;
  while (Date.now() < deadline) {
    if (existsSync(resultPath)) {
      try {
        return {
          evidence: JSON.parse(readFileSync(resultPath, "utf8")),
          timeoutMs,
          waitedMs: Date.now() - startedAt,
          observationError: null,
        };
      } catch (error) {
        lastReadError = sanitize(error);
      }
    }
    await new Promise((resolveResult) => setTimeout(resolveResult, 50));
  }
  return {
    evidence: undefined,
    timeoutMs,
    waitedMs: Date.now() - startedAt,
    observationError: lastReadError ?? "shared probe result deadline exceeded",
  };
}

async function childMain(argv) {
  const [runtimeDir, profileDir, primaryRuntime, pnpm, nodeBin, evidencePath, workspace, expected, permissionMode = "workspace-write"] = argv;
  const checks = [];
  const noRemoteAnswerer = existsSync(join(profileDir ?? "", "cordis.patch.yml"))
    && readFileSync(join(profileDir, "cordis.patch.yml"), "utf8").includes("- id: api-remotes");
  let application;
  let applicationShutdown;
  let restoreSharedProbeOutput;
  const probeAgentHandles = [];
  const sharedProbeSuite = process.env.DSH_PROBE_SUITE;
  const sharedProbe = sharedProbeSuite !== undefined;
  let capturedProbeOutput = "";
  let sharedSecurityEvidence;
  let sharedProbeWait;
  const installSharedProbeOutputCapture = () => {
    const previousStdoutWrite = process.stdout.write.bind(process.stdout);
    const wrappedStdoutWrite = (chunk, encoding, callback) => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString(encoding) : String(chunk);
      capturedProbeOutput = `${capturedProbeOutput}${text}`.slice(-256 * 1024);
      return previousStdoutWrite(chunk, encoding, callback);
    };
    process.stdout.write = wrappedStdoutWrite;
    return () => {
      if (process.stdout.write === wrappedStdoutWrite) process.stdout.write = previousStdoutWrite;
    };
  };
  if (sharedProbe) restoreSharedProbeOutput = installSharedProbeOutputCapture();
  const expectedPlugin = expected === "present";
  const baseEvidence = {
    phase: expectedPlugin ? "plugin-present" : "plugin-absent",
    runtime: "installed Desktop app.asar/dsh",
    expectedPlugin,
    permissionMode,
    checks,
  };
  try {
    if (!runtimeDir || !profileDir || !primaryRuntime || !pnpm || !nodeBin || !evidencePath || !workspace) {
      throw new Error("desktop probe child arguments are incomplete");
    }
    const { boot, dsh, systemPrompt: systemPromptModule } = await loadChildRuntime(runtimeDir);
    const installAnchor = join(runtimeDir, "node_modules", "@deepseek-ai", "dsh", "package.json");
    const peerVersions = {};
    const peerMismatches = [];
    for (const [packageName, allowedVersions] of Object.entries(DESKTOP_PEER_PACKAGES)) {
      const manifestPath = join(runtimeDir, "node_modules", ...packageName.split("/"), "package.json");
      if (!existsSync(manifestPath)) {
        peerVersions[packageName] = null;
        peerMismatches.push(`${packageName}:missing`);
        continue;
      }
      const version = jsonFile(manifestPath).version;
      peerVersions[packageName] = version ?? null;
      if (!allowedVersions.has(version)) peerMismatches.push(`${packageName}:${version ?? "missing-version"}`);
    }
    addCheck(checks, "desktop-runtime:peer-manifests", peerMismatches.length === 0 ? "PASS" : "FAIL", peerMismatches.length === 0
      ? "actual app.asar/dsh peer manifests match the exact rc.2/alpha.1 compatibility matrix"
      : "actual app.asar/dsh peer manifests contain a missing or unsupported version", {
      versions: peerVersions,
      mismatches: peerMismatches,
      source: "installed app.asar/dsh/node_modules package.json manifests",
    });
    const profile = boot.loadProfileDirectory("dsh", profileDir, installAnchor);
    // The user's real Harness may already own the host's usual 19387 port.
    // Keep this probe isolated without terminating or reconfiguring that process.
    const desktopPort = await reserveLocalPort();
    baseEvidence.desktopPort = desktopPort;
    const bootstrapProbeEnv = {
      DSH_CLIENT_VERSION: EXPECTED_DESKTOP_VERSION,
      DSH_TELEMETRY_DISABLED: "1",
      DSH_PRODUCT_ANALYTICS_OTLP_URL: "http://127.0.0.1:1/v1/logs",
      DSH_PERMISSION_MODE: permissionMode,
      ...(process.env.NPM_CONFIG_USERCONFIG === undefined ? {} : {
        NPM_CONFIG_USERCONFIG: process.env.NPM_CONFIG_USERCONFIG,
        npm_config_userconfig: process.env.NPM_CONFIG_USERCONFIG,
        NPM_CONFIG_OFFLINE: "true",
        npm_config_offline: "true",
        NPM_CONFIG_AUDIT: "false",
        npm_config_audit: "false",
        NPM_CONFIG_FUND: "false",
        npm_config_fund: "false",
      }),
      ...(sharedProbe ? {
        DSH_PROBE_SUITE: sharedProbeSuite,
        DSH_PROBE_ROOT: process.env.DSH_PROBE_ROOT,
        DSH_PROBE_WORKSPACE: process.env.DSH_PROBE_WORKSPACE,
        DSH_PROBE_OUTSIDE: process.env.DSH_PROBE_OUTSIDE,
        DSH_PROBE_PLUGIN_PATH: join(profileDir, "node_modules", "dsh-plugin-bash-wsl"),
        DSH_PROBE_PROFILE_MANIFEST: join(profileDir, "package.json"),
        DSH_PROBE_RESULT_FILE: process.env.DSH_PROBE_RESULT_FILE,
      } : {}),
    };
    application = dsh.runProfile({
      // bootstrapProbeEnv is materialized in the child process environment
      // before loadLayeredEnv runs. The returned launch-environment snapshot
      // is immutable-by-closure; mutating it here would be misleading and
      // would not change the actual runtime environment.
      environment: boot.loadLayeredEnv("dsh"),
      profile: "desktop",
      resolvedProfile: { profile, installAnchor },
      patchFiles: [],
      args: ["--no-open", "--port", String(desktopPort)],
      packageManager: {
        command: process.execPath,
        args: ["--expose-internals", pnpm],
        env: {
          ELECTRON_RUN_AS_NODE: "1",
          DSH_DESKTOP_NODE_EXECUTABLE: process.execPath,
          ...bootstrapProbeEnv,
          // Match dsh-desktop-host: PATH receives the support runtime's
          // `bin` directory, not the node executable file itself.
          PATH: `${dirname(nodeBin)}${delimiter}${process.env.PATH ?? ""}`,
        },
      },
    });
    const started = await application;
    applicationShutdown = started.shutdown;
    const { ctx } = started;
    if (noRemoteAnswerer) {
      const loader = ctx.get("loader");
      let entries = [];
      try {
        entries = loader !== undefined && typeof loader.entries === "function"
          ? Array.from(loader.entries())
          : [];
      } catch (error) {
        entries = [{ loaderReadError: sanitize(error) }];
      }
      const entryState = (id) => {
        const entry = entries.find((candidate) => candidate?.options?.id === id);
        if (entry === undefined) return { present: false, disabled: false };
        let disabled = false;
        let readError;
        try { disabled = entry.disabled === true; } catch (error) { readError = sanitize(error); }
        return {
          present: true,
          disabled,
          fiberState: entry.fiber?.state ?? null,
          name: entry.options?.name ?? null,
          ...(readError === undefined ? {} : { readError }),
        };
      };
      const remoteEntry = entryState("api-remotes");
      const disabledRows = { "api-remotes": remoteEntry };
      const runtimeDisabled = remoteEntry.present && remoteEntry.disabled;
      addCheck(checks, "desktop-context:approval-variant-runtime", runtimeDisabled ? "PASS" : "FAIL",
        runtimeDisabled
          ? "live Desktop Loader disabled the Host api-remotes forwarding row in the test-only no-remote-answerer profile"
          : "test-only no-remote-answerer profile did not disable the live Host api-remotes forwarding row",
        {
          disabledRows,
          source: "actual dsh-app-boot Loader entries after runProfile",
        });
    }
    if (sharedProbe) {
      // dsh-desktop-host may replace process.stdout.write while booting the
      // profile. Reinstall the capture after the real context exists so the
      // shared probe's structured result is observed rather than timing out
      // even though it was emitted to the child log.
      restoreSharedProbeOutput?.();
      restoreSharedProbeOutput = installSharedProbeOutputCapture();
      sharedProbeWait = await waitForSharedProbeResult(
        process.env.DSH_PROBE_RESULT_FILE,
        150_000,
      );
      sharedSecurityEvidence = sharedProbeWait.evidence;
    }
    const toolService = ctx.get("tools");
    const promptService = ctx.get("systemPrompt");
    const agentService = ctx.get("agents");
      const agentPresets = ctx.get("agentPresets");
      const permissionPresets = ctx.get("permissionPresets");
    const promptNeedsAgent = expectedPlugin || (promptService !== undefined && typeof promptService.assemble === "function");
      let standardPreset;
      let permissionPresetId;
      if (promptNeedsAgent) {
        try {
          if (agentPresets === undefined || typeof agentPresets.resolve !== "function"
            || typeof agentPresets.mount !== "function"
            || typeof agentPresets.composedPreset !== "function") {
            throw new Error("actual Desktop agentPresets resolve/mount/composedPreset API is unavailable");
          }
          standardPreset = await agentPresets.resolve("standard");
          if (standardPreset?.id !== "standard") {
            throw new Error(`actual Desktop standard preset resolved to ${JSON.stringify(standardPreset?.id ?? null)}`);
          }
          if (permissionPresets === undefined
            || typeof permissionPresets.resolve !== "function"
            || typeof permissionPresets.set !== "function") {
            throw new Error("actual Desktop permissionPresets resolve/set API is unavailable");
          }
          permissionPresetId = permissionPresets.defaultPreset;
          permissionPresets.resolve(permissionPresetId);
          addCheck(checks, "desktop-context:agent-preset-resolution", "PASS",
            "resolved the actual rc.2 standard agent preset and the live default permission preset",
            { agentPreset: standardPreset.id, permissionPreset: permissionPresetId });
        } catch (error) {
          addCheck(checks, "desktop-context:agent-preset-resolution", "FAIL",
            "actual Desktop preset or permission initialization API could not resolve the required standard identities",
            { error: sanitize(error) });
        }
      }
    if (promptNeedsAgent && agentService !== undefined && typeof agentService.create === "function") {
      try {
          if (standardPreset === undefined || permissionPresetId === undefined) {
            throw new Error("standard agent preset or permission preset was not resolved");
          }
        const owners = expectedPlugin ? ["a", "b"] : ["prompt"];
          const presetOwners = [];
        for (const owner of owners) {
          const handle = await agentService.create({
            sessionId: `desktop-probe-${expected}-${owner}-${process.pid}`,
              meta: { cwd: workspace, agentPreset: standardPreset.id },
            agentOptions: {
              provider: "desktop-probe",
              model: "desktop-probe",
            },
              setup: async (agentCtx) => {
                await agentPresets.mount(agentCtx, standardPreset.id);
              },
          });
          if (handle === null || typeof handle !== "object"
            || handle.agent === undefined || typeof handle.dispose !== "function") {
            throw new Error("ctx.agents.create() did not return the official { agent, dispose } handle");
          }
            permissionPresets.set(handle.agent.session, permissionPresetId);
            const mountedPreset = agentPresets.composedPreset(handle.agent.ctx);
            const headerPreset = handle.agent.session.header?.agentPreset ?? null;
            const permissionCurrent = typeof permissionPresets.current === "function"
              ? permissionPresets.current(handle.agent.session)
              : null;
            presetOwners.push({
              owner,
              mountedPreset,
              headerPreset,
              permissionPreset: permissionCurrent,
            });
            if (mountedPreset !== standardPreset.id || headerPreset !== standardPreset.id
              || permissionCurrent !== permissionPresetId) {
              throw new Error(`standard preset/permission audit failed for owner ${owner}`);
            }
          probeAgentHandles.push(handle);
        }
          addCheck(checks, "desktop-context:agent-preset-mount", "PASS",
            "created real owner-scoped agents through rc.2 with standard preset mounting and initialized permissions",
            { agentPreset: standardPreset.id, permissionPreset: permissionPresetId, owners: presetOwners });
        addCheck(checks, "desktop-context:probe-agent-setup", "PASS", expectedPlugin
          ? "created two real owner-scoped agents through the official registry without starting a model request"
          : "created one real owner-scoped agent for post-unload prompt assembly without starting a model request", {
          registeredOwners: probeAgentHandles.length,
        });
      } catch (error) {
          addCheck(checks, "desktop-context:agent-preset-mount", "FAIL",
            "the actual rc.2 standard preset or permission initialization did not remain mounted on the created agent",
            { error: sanitize(error) });
        addCheck(checks, "desktop-context:probe-agent-setup", "FAIL", "the official agent factory could not create the live owner required by prompt/ownership assertions", {
          error: sanitize(error),
        });
      }
    } else if (promptNeedsAgent) {
        addCheck(checks, "desktop-context:agent-preset-mount", "FAIL",
          "the real Desktop context has no agent factory for standard preset mounting");
      addCheck(checks, "desktop-context:probe-agent-setup", "FAIL", "the real Desktop context has no agent factory for prompt/ownership assertions");
    }
    const profileContext = ctx.get("profileContext");
    const anchorOk = profileContext?.installAnchor === installAnchor;
    addCheck(checks, "desktop-context:profile-context-anchor", anchorOk ? "PASS" : "FAIL", anchorOk
      ? "real profileContext.installAnchor identifies the active app.asar DSH manifest"
      : "real profileContext.installAnchor does not identify the active app.asar DSH manifest", {
      anchorRelative: "app.asar/dsh/node_modules/@deepseek-ai/dsh/package.json",
      profileName: profileContext?.name ?? null,
      anchorBasename: profileContext?.installAnchor?.split(/[\\/]/).at(-1) ?? null,
    });
    if (toolService === undefined || typeof toolService.schemas !== "function") {
      addCheck(checks, "desktop-context:tools-service", "FAIL", "real Desktop context has no tools service");
    } else {
      const schemas = toolService.schemas();
      const names = schemas.map((schema) => schema.name);
      const missing = expectedPlugin ? EXPECTED_TOOLS.filter((name) => !names.includes(name)) : EXPECTED_TOOLS.filter((name) => names.includes(name));
      const expectedRequiredParameters = {
        bash: ["command"],
        wsl_bash: ["command", "description"],
        git_bash: ["command", "description"],
      };
      const requiredSchemaNames = Object.fromEntries(EXPECTED_TOOLS.map((name) => {
        const schema = schemas.find((entry) => entry.name === name);
        return [name, requiredParameterNames(schema)];
      }));
      const missingRequiredParameters = expectedPlugin
        ? EXPECTED_TOOLS.flatMap((name) => expectedRequiredParameters[name]
          .filter((requiredName) => !requiredSchemaNames[name].includes(requiredName))
          .map((requiredName) => `${name}.${requiredName}`))
        : [];
      if (missing.length === 0 && missingRequiredParameters.length === 0) {
        addCheck(checks, "desktop-context:tool-registration", "PASS", expectedPlugin
          ? "bash, wsl_bash and git_bash are registered with required command/description parameters in the real Desktop context"
          : "plugin tools are absent after the profile bundle was removed", {
          toolCount: names.length,
          expectedTools: EXPECTED_TOOLS,
          observedExpectedNames: EXPECTED_TOOLS.filter((name) => names.includes(name)),
          requiredParameters: requiredSchemaNames,
        });
      } else {
        addCheck(checks, "desktop-context:tool-registration", "FAIL", expectedPlugin
          ? `missing registered tools/required parameters: ${missing.join(", ") || "none"}; ${missingRequiredParameters.join(", ") || "none"}`
          : `plugin tools remained after unload: ${missing.join(", ")}`, {
          toolCount: names.length,
          observedExpectedNames: EXPECTED_TOOLS.filter((name) => names.includes(name)),
          requiredParameters: requiredSchemaNames,
        });
      }

      if (promptService !== undefined && typeof promptService.assemble === "function") {
        // Prompt assembly requires a real registered agent. A synthetic object
        // can bypass the host's ownership/session contract and is not evidence
        // of the actual Desktop API.
        const liveAgent = probeAgentHandles[0]?.agent;
        if (liveAgent === undefined) {
          addCheck(checks, "desktop-context:system-prompt", "FAIL", "the official agent factory did not return a live owner for prompt assembly");
          if (!expectedPlugin) addCheck(checks, "desktop-context:prompt-tool-schemas", "FAIL", "prompt tool removal could not be assembled with a live owner");
        } else {
          const sentinelDisposers = [];
          try {
            const scopedPromptService = liveAgent.ctx?.get?.("systemPrompt");
            const bashOrder = typeof scopedPromptService?.getSectionOrder === "function"
              ? scopedPromptService.getSectionOrder("TOOL_BASH")
              : undefined;
            if (typeof bashOrder !== "number" || typeof scopedPromptService?.section !== "function") {
              throw new Error("official scoped system prompt section ordering API is unavailable");
            }
            const lowerSentinel = `desktop-probe:prompt-lower-${expected}-${process.pid}`;
            const upperSentinel = `zz-desktop-probe:prompt-upper-${expected}-${process.pid}`;
            sentinelDisposers.push(scopedPromptService.section({
              name: lowerSentinel,
              order: bashOrder + 1,
              text: "desktop-probe prompt lower sentinel",
              interpolate: false,
            }));
            sentinelDisposers.push(scopedPromptService.section({
              name: upperSentinel,
              order: bashOrder + 1,
              text: "desktop-probe prompt upper sentinel",
              interpolate: false,
            }));
            const assembly = await promptService.assemble({ agent: liveAgent, scope: liveAgent });
            const section = assembly.sections.find((entry) => entry.name === PROMPT_SECTION);
            const rendered = systemPromptModule.renderPrompt(assembly);
            const lowerIndex = assembly.sections.findIndex((entry) => entry.name === lowerSentinel);
            const upperIndex = assembly.sections.findIndex((entry) => entry.name === upperSentinel);
            const bashSectionIndex = assembly.sections.findIndex((entry) => entry.name === "tool:bash");
            const pluginSectionIndex = assembly.sections.findIndex((entry) => entry.name === PROMPT_SECTION);
            const orderOk = lowerIndex >= 0 && pluginSectionIndex > lowerIndex && pluginSectionIndex < upperIndex;
            const expectedPluginOrder = bashOrder + 1;
            const schemaNames = assembly.tools.map((schema) => schema.name);
            if (expectedPlugin) {
              const promptOk = section !== undefined
                && section.interpolate === false
                && section.text.includes("bash keeps")
                && section.text.includes("Timeout, cancellation or shell exit resets")
                && rendered.includes("dsh-plugin-bash-wsl")
                && orderOk;
              addCheck(checks, "desktop-context:system-prompt", promptOk ? "PASS" : "FAIL", promptOk
                ? "system prompt section is present, ordered between official TOOL_BASH sentinels, and literal"
                : "system prompt section is missing or violates order/interpolation/content contract", {
                sectionPresent: section !== undefined,
                interpolate: section?.interpolate ?? null,
                bashSectionIndex,
                pluginSectionIndex,
                lowerSentinelIndex: lowerIndex,
                upperSentinelIndex: upperIndex,
                bashOrder,
                lowerSentinelOrder: bashOrder + 1,
                upperSentinelOrder: bashOrder + 1,
                expectedPluginOrder,
                exactOrderByEqualSentinels: true,
                orderOk,
                renderedMarker: rendered.includes("dsh-plugin-bash-wsl"),
              });
              const schemaOk = EXPECTED_TOOLS.every((name) => schemaNames.includes(name));
              addCheck(checks, "desktop-context:prompt-tool-schemas", schemaOk ? "PASS" : "FAIL", schemaOk
                ? "system-prompt assembly exposes all plugin tool schemas"
                : "system-prompt assembly omitted one or more plugin tool schemas", {
                observed: EXPECTED_TOOLS.filter((name) => schemaNames.includes(name)),
              });
            } else {
              const promptAbsent = section === undefined && !rendered.includes("dsh-plugin-bash-wsl");
              addCheck(checks, "desktop-context:system-prompt", promptAbsent ? "PASS" : "FAIL", promptAbsent
                ? "plugin system prompt section is absent after the profile bundle was removed"
                : "plugin system prompt section remained after unload", {
                sectionPresent: section !== undefined,
                renderedMarker: rendered.includes("dsh-plugin-bash-wsl"),
              });
              const schemaAbsent = EXPECTED_TOOLS.filter((name) => schemaNames.includes(name));
              addCheck(checks, "desktop-context:prompt-tool-schemas", schemaAbsent.length === 0 ? "PASS" : "FAIL", schemaAbsent.length === 0
                ? "plugin tool schemas are absent after the profile bundle was removed"
                : "plugin tool schemas remained after unload", {
                observed: schemaAbsent,
              });
            }
          } catch (error) {
            addCheck(checks, "desktop-context:system-prompt", "FAIL", "real system prompt assembly/order assertion threw", {
              error: sanitize(error),
            });
          } finally {
            for (const dispose of sentinelDisposers.toReversed()) {
              try { if (typeof dispose === "function") dispose(); } catch (error) {
                addCheck(checks, "desktop-context:prompt-sentinel-cleanup", "FAIL", "temporary prompt ordering sentinel cleanup failed", {
                  error: sanitize(error),
                });
              }
            }
          }
        }
      } else {
        addCheck(checks, "desktop-context:system-prompt", "FAIL", "real Desktop context has no systemPrompt service");
        if (!expectedPlugin) addCheck(checks, "desktop-context:prompt-tool-schemas", "FAIL", "prompt tool removal could not be checked without the systemPrompt service");
      }

      if (expectedPlugin && sharedProbeSuite === "output-cap") {
        addCheck(checks, "tool-execute:wsl_bash", "SKIP", "dedicated output-cap suite owns the low-cap wsl_bash execution; the normal UTF-8 marker assertion is not applicable at a 4-byte cap");
        addCheck(checks, "tool-execute:git_bash", "SKIP", "dedicated output-cap suite owns the low-cap git_bash execution; the normal UTF-8 marker assertion is not applicable at a 4-byte cap");
      } else if (expectedPlugin) {
        const registeredAgents = probeAgentHandles.map((handle) => handle.agent);
        const commandArgs = {
          command: "printf 'desktop-probe:%s\\n' '中文 空格'",
          description: "offline Desktop acceptance probe",
          workdir: workspace,
          timeoutMs: 30_000,
        };
        await executeTool(toolService, "wsl_bash", commandArgs, workspace, checks, {
          agent: registeredAgents[0],
          observeSubprocess: true,
          ctx,
        });
        await executeTool(toolService, "git_bash", commandArgs, workspace, checks, {
          expectedRestrictedDenial: permissionMode !== "danger-full-access",
          observeSubprocess: permissionMode !== "danger-full-access",
          ctx,
          agent: registeredAgents[0],
        });
        await checkPersistentOwnership(toolService, workspace, checks, registeredAgents);
      }
    }
    if (sharedProbe) {
      if (sharedSecurityEvidence === undefined) {
        addCheck(checks, `desktop-context:shared-${sharedProbeSuite}`, "FAIL", `shared CLI ${sharedProbeSuite} probe did not finish in the real Desktop context`, {
          timeoutMs: sharedProbeWait?.timeoutMs ?? 150_000,
          waitedMs: sharedProbeWait?.waitedMs ?? null,
          resultPath: typeof process.env.DSH_PROBE_RESULT_FILE === "string" ? "<test-root>/shared-result.json" : null,
          observationError: sharedProbeWait?.observationError ?? null,
        });
      } else {
        const securityEvidence = sharedSecurityEvidence;
        const validStatus = ["PASS", "SKIP", "FAIL"].includes(securityEvidence.status);
        const validShape = securityEvidence.schemaVersion === 1
          && securityEvidence.suite === sharedProbeSuite
          && securityEvidence.mode === permissionMode
          && Array.isArray(securityEvidence.checks);
        const aggregateStatus = validStatus && validShape ? securityEvidence.status : "FAIL";
        addCheck(checks, `desktop-context:shared-${sharedProbeSuite}`, aggregateStatus,
          validShape ? `shared CLI ${sharedProbeSuite} probe completed on the live Desktop root context`
            : `shared CLI ${sharedProbeSuite} probe returned malformed structured evidence`, {
            schemaVersion: securityEvidence.schemaVersion ?? null,
            suite: securityEvidence.suite ?? null,
            mode: securityEvidence.mode ?? null,
            status: securityEvidence.status ?? null,
            checkCount: Array.isArray(securityEvidence.checks) ? securityEvidence.checks.length : null,
          });
        for (const check of securityEvidence.checks ?? []) {
          addCheck(checks, `desktop-context:shared-${sharedProbeSuite}:${check.id}`, check.status, check.detail ?? `shared CLI ${sharedProbeSuite} assertion`, check.evidence);
        }
      }
    }
    baseEvidence.status = checks.some((check) => check.status === "FAIL") ? "FAIL" : checks.some((check) => check.status === "SKIP") ? "SKIP" : "PASS";
  } catch (error) {
    baseEvidence.status = "FAIL";
    addCheck(checks, "desktop-context:startup", "FAIL", "real Desktop runtime context failed to load", {
      error: sanitize(error),
    });
  } finally {
    restoreSharedProbeOutput?.();
    for (const handle of probeAgentHandles.toReversed()) {
      try {
        await handle.dispose();
      } catch (error) {
        addCheck(checks, "desktop-context:probe-agent-cleanup", "FAIL", "real probe agent disposal failed", {
          error: sanitize(error),
        });
      }
    }
    try {
      if (applicationShutdown?.shutdown) await applicationShutdown.shutdown(0);
    } catch (error) {
      addCheck(checks, "desktop-context:shutdown", "FAIL", "Desktop context shutdown failed", {
        error: sanitize(error),
      });
    }
    baseEvidence.status = checks.some((check) => check.status === "FAIL")
      ? "FAIL"
      : checks.some((check) => check.status === "SKIP")
        ? "SKIP"
        : "PASS";
    try {
      writeFileSync(evidencePath, `${JSON.stringify(baseEvidence, null, 2)}\n`);
    } catch (error) {
      console.error(`desktop probe could not write evidence: ${String(error)}`);
      process.exitCode = 1;
      return;
    }
  }
  process.exitCode = baseEvidence.status === "PASS" ? 0 : 1;
}

async function spawnDesktopChild(paths, profile, dshHome, workspace, expected, evidencePath, logRoot, phaseLabel = expected, permissionMode = "workspace-write", probeSuite = undefined, probeRoot = undefined, outside = undefined) {
  const script = fileURLToPath(import.meta.url);
  const isolatedNpmrc = probeRoot === undefined ? undefined : join(probeRoot, "npmrc");
  const child = spawn(paths.executable, [
    "--expose-internals",
    script,
    "--desktop-probe-child",
    paths.runtimeDir,
    profile,
    paths.primaryRuntime,
    paths.pnpm,
    paths.node,
    evidencePath,
    workspace,
    expected,
    permissionMode,
  ], {
    // dsh-base derives the immutable sandbox workspace root from
    // `process.cwd()`. Start the host in the owned workspace so the tool call
    // below exercises the intended workspace boundary rather than the profile
    // metadata directory.
    cwd: workspace,
      env: isolatedEnvironment({
        DSH_HOME: dshHome,
        DSH_DESKTOP_PROBE: "1",
        DSH_TELEMETRY_DISABLED: "1",
        DSH_CLIENT_VERSION: EXPECTED_DESKTOP_VERSION,
        // Keep the telemetry row's required endpoint local even when the
        // host resolves its layered env before packageManager.env is used.
        DSH_PRODUCT_ANALYTICS_OTLP_URL: "http://127.0.0.1:1/v1/logs",
        DSH_PERMISSION_MODE: permissionMode,
        ...(probeSuite === undefined ? {} : {
          DSH_PROBE_SUITE: probeSuite,
          DSH_PROBE_ROOT: probeRoot,
          DSH_PROBE_WORKSPACE: workspace,
          DSH_PROBE_OUTSIDE: outside,
          DSH_PROBE_PLUGIN_PATH: join(profile, "node_modules", "dsh-plugin-bash-wsl"),
          DSH_PROBE_PROFILE_MANIFEST: join(profile, "package.json"),
          DSH_PROBE_RESULT_FILE: join(probeRoot, `${phaseLabel}-shared-result.json`),
        }),
      ELECTRON_RUN_AS_NODE: "1",
      ELECTRON_NO_ATTACH_CONSOLE: "1",
      ...(isolatedNpmrc === undefined ? {} : {
        NPM_CONFIG_USERCONFIG: isolatedNpmrc,
        npm_config_userconfig: isolatedNpmrc,
        NPM_CONFIG_UPDATE_NOTIFIER: "false",
        npm_config_update_notifier: "false",
      }),
      TEMP: logRoot,
      TMP: logRoot,
      TMPDIR: logRoot,
    }),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    shell: false,
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk) => { stdout = `${stdout}${chunk}`.slice(-MAX_LOG_CHARS); });
  child.stderr?.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-MAX_LOG_CHARS); });
  const close = await new Promise((resolveResult) => {
    let settled = false;
    let timedOut = false;
    let kill;
    let pendingClose;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("error", onError);
      child.off("close", onClose);
      resolveResult(result);
    };
    const onError = (error) => {
      if (timedOut && kill === undefined) {
        pendingClose = { error: String(error) };
        return;
      }
      finish({ code: null, signal: null, error: String(error), timedOut, kill });
    };
    const onClose = (code, signal) => {
      if (timedOut && kill === undefined) {
        pendingClose = { code, signal };
        return;
      }
      finish({
        code,
        signal,
        timedOut,
        kill: kill ?? { attempted: false, aliveAfter: false, closeObserved: true, reaped: true },
      });
    };
    const timer = setTimeout(async () => {
      timedOut = true;
      kill = await stopProcessTree(child);
      finish({
        code: pendingClose?.code ?? kill.exitCode ?? null,
        signal: pendingClose?.signal ?? kill.signal ?? "timeout",
        error: pendingClose?.error,
        timedOut: true,
        kill,
      });
    }, CHILD_TIMEOUT_MS);
    child.once("error", onError);
    child.once("close", onClose);
  });
  const evidence = existsSync(evidencePath) ? jsonFile(evidencePath) : undefined;
  writeFileSync(join(logRoot, `${phaseLabel}.stdout.log`), stdout);
  writeFileSync(join(logRoot, `${phaseLabel}.stderr.log`), stderr);
  return {
    expected,
    phaseLabel,
    permissionMode,
    pid: child.pid,
    close,
    evidence,
    stdout: sanitize(stdout),
    stderr: sanitize(stderr),
  };
}

async function runtimeNegativeMain(argv) {
  const tgzArgumentIndex = argv.indexOf("--tgz");
  const oldTgz = tgzArgumentIndex >= 0 ? argv[tgzArgumentIndex + 1] : join(ROOT, "dsh-plugin-bash-wsl-0.1.0.tgz");
  const evidencePath = join(RUN_ROOT, `d14-runtime-negative-loader-${nowTag()}-${process.pid}.json`);
  const evidence = {
    schemaVersion: 2,
    target: `Desktop ${EXPECTED_DESKTOP_VERSION} / preserved plugin 0.1.0`,
    scope: "actual rc.2 loader and runProfile/Host compatibility negative; independent from pnpm offline installation",
    host: {
      desktopVersion: null,
      executable: null,
      executableSha256: null,
      appAsar: null,
      appAsarSha256: null,
      loader: "actual @deepseek-ai/dsh-app-boot.loadProfileDirectory from app.asar",
    },
    fixture: {
      name: "dsh-plugin-bash-wsl",
      version: "0.1.0",
      path: oldTgz,
      tgzSha256: null,
      dshPeerRange: null,
      installation: "preserved old TGZ bytes extracted into an owned test profile; no registry or dependency install",
    },
    loaderResult: null,
    runtimeContext: {
      started: false,
      reason: "negative stops after loadProfileDirectory; runProfile is not called",
      fullAuditStatus: "SKIP",
      fullAuditReason: "not attempted",
    },
    oldToolsPrompt: {
      registered: false,
      reason: "plugin bundle is expected to be omitted before a Cordis context is mounted",
    },
    child: null,
    hostChild: null,
    hostEvidence: null,
    hostRegistrationAudit: null,
    ownedTemp: {
      root: null,
      containmentChecked: false,
      rootRemoved: false,
    },
    status: "SKIP",
    loaderStatus: "SKIP",
    fullD14Status: "SKIP",
    acceptanceId: "D-14 old-version runtime rejection",
    qualification: "",
    fullD14Qualification: "",
  };
  evidence.evidencePath = evidencePath;
  let tempRoot;
  try {
    if (process.platform !== "win32") {
      evidence.qualification = "SKIP: actual Windows Desktop Electron is required; WSL/Linux is not a Desktop target";
      return evidence;
    }
    const paths = desktopPaths();
    evidence.host.executable = paths?.executable ?? null;
    evidence.host.appAsar = paths?.asar ?? null;
    if (!paths || !existsSync(paths.executable) || !existsSync(paths.asar)) {
      evidence.qualification = "SKIP: installed Desktop executable or app.asar is unavailable";
      return evidence;
    }
    if (!existsSync(oldTgz)) {
      evidence.qualification = "SKIP: preserved 0.1.0 TGZ fixture is unavailable";
      return evidence;
    }
    const fixtureManifest = tgzPackageManifest(oldTgz);
    evidence.fixture.tgzSha256 = sha256(oldTgz);
    evidence.fixture.dshPeerRange = fixtureManifest?.peerDependencies?.["@deepseek-ai/dsh"] ?? null;
    if (fixtureManifest?.name !== "dsh-plugin-bash-wsl" || fixtureManifest.version !== "0.1.0") {
      evidence.status = "FAIL";
      evidence.qualification = "FAIL: preserved old TGZ identity does not match dsh-plugin-bash-wsl@0.1.0";
      return evidence;
    }
    let asar;
    try {
      asar = openAsar(paths.asar);
      evidence.host.desktopVersion = asar.readJson("dsh/node_modules/@deepseek-ai/dsh/package.json").version ?? null;
    } finally {
      asar?.close();
    }
    evidence.host.executableSha256 = sha256(paths.executable);
    evidence.host.appAsarSha256 = sha256(paths.asar);
    tempRoot = mkdtempSync(join(RUN_ROOT, "d14-runtime-negative-"));
    assertTempRoot(tempRoot);
    evidence.ownedTemp.root = tempRoot;
    evidence.ownedTemp.containmentChecked = true;
    const profile = join(tempRoot, "profile");
    const workspace = join(tempRoot, "workspace");
    const dshHome = join(tempRoot, "dsh-home");
    const isolatedNpmrc = join(tempRoot, "npmrc");
    mkdirSync(profile, { recursive: true });
    mkdirSync(workspace, { recursive: true });
    mkdirSync(join(dshHome, "profiles"), { recursive: true });
    writeFileSync(isolatedNpmrc, "offline=true\naudit=false\nfund=false\nupdate-notifier=false\n");
    const pluginDirectory = join(profile, "node_modules", "dsh-plugin-bash-wsl");
    extractPackageTgz(oldTgz, pluginDirectory);
    writeFileSync(join(profile, "package.json"), `${JSON.stringify({
      name: "dsh-desktop-runtime-negative",
      private: true,
      dependencies: { "dsh-plugin-bash-wsl": "file:./node_modules/dsh-plugin-bash-wsl" },
      dsh: {
        profile: {
          bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-plugin-bash-wsl"],
        },
      },
    }, null, 2)}\n`);
    writeFileSync(join(profile, "cordis.yml"), "[]\n");
    writeFileSync(join(profile, "cordis.patch.yml"), "[]\n");
    writeFileSync(join(profile, "pnpm-workspace.yaml"), "packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n");
    const child = await runCommand(paths.executable, [
      "--expose-internals",
      fileURLToPath(import.meta.url),
      "--desktop-runtime-negative-child",
      paths.runtimeDir,
      profile,
    ], {
      cwd: workspace,
      timeoutMs: 60_000,
      env: {
        DSH_HOME: dshHome,
        DSH_DESKTOP_PROBE: "1",
        DSH_CLIENT_VERSION: EXPECTED_DESKTOP_VERSION,
        DSH_TELEMETRY_DISABLED: "1",
        DSH_PRODUCT_ANALYTICS_OTLP_URL: "http://127.0.0.1:1/v1/logs",
        NPM_CONFIG_USERCONFIG: isolatedNpmrc,
        npm_config_userconfig: isolatedNpmrc,
        NPM_CONFIG_OFFLINE: "true",
        npm_config_offline: "true",
        ELECTRON_RUN_AS_NODE: "1",
        ELECTRON_NO_ATTACH_CONSOLE: "1",
        TEMP: tempRoot,
        TMP: tempRoot,
        TMPDIR: tempRoot,
      },
    });
    evidence.child = {
      exitCode: child.code ?? null,
      timedOut: child.timedOut === true,
      closeObserved: child.cleanup?.closeObserved === true,
      reaped: child.cleanup?.reaped === true,
      aliveAfter: child.cleanup?.aliveAfter === true,
      error: child.error ?? null,
    };
    const marker = [...`${child.stdout ?? ""}\n${child.stderr ?? ""}`.matchAll(/D14_RUNTIME_NEGATIVE_RESULT\s+(\{[^\n]+\})/g)].at(-1)?.[1];
    if (marker !== undefined) {
      try {
        const parsed = JSON.parse(marker);
        evidence.loaderResult = parsed.loaderResult ?? null;
        evidence.runtimeContext.started = parsed.contextStarted === true;
        evidence.runtimeContext.reason = parsed.contextStarted === true
          ? "child reported a started context"
          : evidence.runtimeContext.reason;
        evidence.oldToolsPrompt = parsed.oldToolsPrompt ?? evidence.oldToolsPrompt;
      } catch (error) {
        evidence.loaderResult = { parseError: sanitize(error) };
      }
    }
    const diagnostic = String(evidence.loaderResult?.diagnostic ?? "");
    const childClean = evidence.child.exitCode === 0
      && evidence.child.timedOut === false
      && evidence.child.closeObserved === true
      && evidence.child.reaped === true
      && evidence.child.error === null;
    const explicitPeerRejection = evidence.loaderResult?.pluginLayerLoaded === false
      && evidence.loaderResult?.skippedBundle === "dsh-plugin-bash-wsl"
      && evidence.loaderResult?.expectedPeerMismatch === true
      && /0\.1\.0-rc\.6/.test(diagnostic)
      && /incompatib|incompatible|peerDependencies|exact-version exemption/i.test(diagnostic);
    const contextNotStarted = evidence.runtimeContext.started === false;
    const oldToolsPromptAbsent = evidence.oldToolsPrompt.registered === false;
    const loaderPassed = childClean && explicitPeerRejection && contextNotStarted && oldToolsPromptAbsent;
    evidence.loaderStatus = loaderPassed ? "PASS" : "FAIL";
    if (loaderPassed) {
      evidence.status = "PASS";
      evidence.qualification = "PASS: actual rc.2 loader explicitly rejected the preserved rc.6-peer plugin and omitted its layer before context mount";
    } else {
      evidence.status = "FAIL";
      evidence.qualification = `FAIL: structured runtime rejection incomplete (child=${childClean ? "clean" : "unclean"}, peerRejection=${explicitPeerRejection}, contextNotStarted=${contextNotStarted}, oldToolsPromptAbsent=${oldToolsPromptAbsent})`;
    }
    if (loaderPassed) {
      const hostEvidencePath = join(tempRoot, "host-context-negative.json");
      const hostChild = await runCommand(paths.executable, [
        "--expose-internals",
        fileURLToPath(import.meta.url),
        "--desktop-probe-child",
        paths.runtimeDir,
        profile,
        paths.primaryRuntime,
        paths.pnpm,
        paths.node,
        hostEvidencePath,
        workspace,
        "absent",
        "workspace-write",
      ], {
        cwd: workspace,
        timeoutMs: 180_000,
        env: {
          DSH_HOME: dshHome,
          DSH_DESKTOP_PROBE: "1",
          DSH_CLIENT_VERSION: EXPECTED_DESKTOP_VERSION,
          DSH_TELEMETRY_DISABLED: "1",
          DSH_PRODUCT_ANALYTICS_OTLP_URL: "http://127.0.0.1:1/v1/logs",
          NPM_CONFIG_USERCONFIG: isolatedNpmrc,
          npm_config_userconfig: isolatedNpmrc,
          NPM_CONFIG_OFFLINE: "true",
          npm_config_offline: "true",
          ELECTRON_RUN_AS_NODE: "1",
          ELECTRON_NO_ATTACH_CONSOLE: "1",
          TEMP: tempRoot,
          TMP: tempRoot,
          TMPDIR: tempRoot,
        },
      });
      evidence.hostChild = {
        exitCode: hostChild.code ?? null,
        timedOut: hostChild.timedOut === true,
        closeObserved: hostChild.cleanup?.closeObserved === true,
        reaped: hostChild.cleanup?.reaped === true,
        aliveAfter: hostChild.cleanup?.aliveAfter === true,
        error: hostChild.error ?? null,
      };
      if (existsSync(hostEvidencePath)) {
        try {
          evidence.hostEvidence = jsonFile(hostEvidencePath);
        } catch (error) {
          evidence.hostEvidence = { parseError: sanitize(error) };
        }
      }
      const hostChecks = Array.isArray(evidence.hostEvidence?.checks)
        ? evidence.hostEvidence.checks
        : [];
      const hostCheck = (id) => hostChecks.find((check) => check?.id === id);
      const hostToolCheck = hostCheck("desktop-context:tool-registration");
      const hostPromptCheck = hostCheck("desktop-context:system-prompt");
      const hostSchemaCheck = hostCheck("desktop-context:prompt-tool-schemas");
      const hostAnchorCheck = hostCheck("desktop-context:profile-context-anchor");
      const contextStarted = hostEvidencePath !== undefined
        && (hostToolCheck !== undefined || hostPromptCheck !== undefined || hostAnchorCheck !== undefined);
      const hostToolAbsent = hostToolCheck?.status === "PASS"
        && Array.isArray(hostToolCheck.evidence?.observedExpectedNames)
        && hostToolCheck.evidence.observedExpectedNames.length === 0;
      const hostPromptAbsent = hostPromptCheck?.status === "PASS"
        && hostPromptCheck.evidence?.sectionPresent === false
        && hostPromptCheck.evidence?.renderedMarker === false;
      const hostSchemaAbsent = hostSchemaCheck?.status === "PASS"
        && Array.isArray(hostSchemaCheck.evidence?.observed)
        && hostSchemaCheck.evidence.observed.length === 0;
      evidence.runtimeContext.started = contextStarted;
      evidence.runtimeContext.reason = contextStarted
        ? "actual rc.2 runProfile mounted the isolated host context"
        : "actual rc.2 runProfile did not produce a structured context audit";
      evidence.hostRegistrationAudit = {
        status: hostToolAbsent && hostPromptAbsent && hostSchemaAbsent ? "PASS" : "FAIL",
        toolRegistration: hostToolCheck ?? null,
        systemPrompt: hostPromptCheck ?? null,
        promptToolSchemas: hostSchemaCheck ?? null,
        profileContextAnchor: hostAnchorCheck ?? null,
      };
      const hostChildClean = evidence.hostChild.exitCode === 0
        && evidence.hostChild.timedOut === false
        && evidence.hostChild.closeObserved === true
        && evidence.hostChild.reaped === true
        && evidence.hostChild.error === null;
      const hostContextPassed = hostChildClean
        && evidence.hostEvidence?.status === "PASS"
        && hostToolAbsent
        && hostPromptAbsent
        && hostSchemaAbsent;
      if (hostContextPassed) {
        evidence.runtimeContext.fullAuditStatus = "PASS";
        evidence.runtimeContext.fullAuditReason = "actual rc.2 runProfile context registered no old plugin tools or prompt schemas";
        evidence.fullD14Status = "PASS";
        evidence.fullD14Qualification = "PASS: actual rc.2 Host context mounted the old fixture profile without registering old wsl_bash/git_bash tools or plugin prompt";
      } else if (!contextStarted) {
        evidence.runtimeContext.fullAuditStatus = "SKIP";
        evidence.runtimeContext.fullAuditReason = `Host context prerequisite/audit unavailable (child=${hostChildClean ? "clean" : "unclean"}, evidence=${evidence.hostEvidence === null ? "missing" : "present"})`;
        evidence.fullD14Status = "SKIP";
        evidence.fullD14Qualification = `SKIP: actual rc.2 Host context did not reach a structured negative registration audit (child=${hostChildClean ? "clean" : "unclean"})`;
      } else {
        evidence.runtimeContext.fullAuditStatus = "FAIL";
        evidence.runtimeContext.fullAuditReason = "actual rc.2 Host context started but old plugin tool/prompt absence audit failed";
        evidence.fullD14Status = "FAIL";
        evidence.fullD14Qualification = "FAIL: actual rc.2 Host context started but old plugin registration/prompt absence was not proven";
      }
    } else {
      evidence.fullD14Status = "FAIL";
      evidence.fullD14Qualification = "FAIL: loader compatibility rejection was not established, so full runtime audit was not attempted";
    }
  } catch (error) {
    evidence.status = "FAIL";
    evidence.qualification = `FAIL: runtime-negative probe threw: ${sanitize(error)}`;
  } finally {
    if (tempRoot !== undefined) {
      try {
        rmSync(tempRoot, { recursive: true, force: true });
        evidence.ownedTemp.rootRemoved = true;
      } catch (error) {
        evidence.ownedTemp.rootRemoved = false;
        evidence.status = "FAIL";
        evidence.qualification = `FAIL: owned runtime-negative temp cleanup failed: ${sanitize(error)}`;
      }
    }
    writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  }
  return evidence;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    target: "Desktop 0.2.0-rc.2 / plugin 0.2.0",
    checks: [],
    phases: [],
    cleanup: {},
    diagnostics: {
      oldVersionPnpmCache: [],
    },
    approvalVariant: {
      mode: options.noRemoteAnswerer ? "no-remote-answerer" : "default-remote-answerer",
      rowIds: ["api-remotes"],
      disabled: options.noRemoteAnswerer,
      source: "actual dsh-api-remotes host row",
    },
  };
  let tempRoot;
  let paths;
  let asar;
  let protectedBefore;
  try {
    if (process.platform !== "win32") {
      addCheck(report, "desktop-host-capability", "SKIP", "the real Desktop Electron host requires Windows Node; this process is not win32");
      return report;
    }
    paths = desktopPaths();
    if (paths === undefined || !existsSync(paths.executable) || !existsSync(paths.asar)) {
      addCheck(report, "desktop-host-capability", "SKIP", "installed DeepSeek Harness executable or app.asar was not found");
      return report;
    }
    if (!existsSync(paths.node) || !existsSync(paths.pnpm)) {
      addCheck(report, "desktop-runtime-launcher", "SKIP", "Desktop bundled runtime node.exe or pnpm.mjs is missing");
      return report;
    }
    asar = openAsar(paths.asar);
    const appManifest = asar.readJson("package.json");
    const dshManifest = asar.readJson("dsh/package.json");
    const runtimeDescriptor = asar.readJson("dsh/desktop-runtime.json");
    const appVersionOk = appManifest.version === EXPECTED_DESKTOP_VERSION;
    const dshVersionOk = dshManifest.name === "@deepseek-ai/dsh-desktop-runtime" && dshManifest.version === EXPECTED_DESKTOP_VERSION;
    const descriptorOk = runtimeDescriptor.release?.version === EXPECTED_DESKTOP_VERSION
      && runtimeDescriptor.platform === "win32"
      && runtimeDescriptor.arch === "x64";
    addCheck(report, "desktop-runtime:version", appVersionOk && dshVersionOk && descriptorOk ? "PASS" : "FAIL", appVersionOk && dshVersionOk && descriptorOk
      ? "actual app.asar and desktop-runtime descriptor are 0.2.0-rc.2"
      : "actual installed Desktop runtime version or platform metadata does not match the target", {
      appVersion: appManifest.version,
      runtimeVersion: dshManifest.version,
      descriptorVersion: runtimeDescriptor.release?.version ?? null,
      platform: runtimeDescriptor.platform ?? null,
      arch: runtimeDescriptor.arch ?? null,
    });
    const desktopHostEntryPath = "dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js";
    let desktopHostEntry;
    try {
      desktopHostEntry = asar.read(desktopHostEntryPath).toString("utf8");
    } catch (error) {
      addCheck(report, "desktop-runtime:host-entry", "FAIL", "actual app.asar does not expose the dsh-desktop-host entry", {
        entryPath: desktopHostEntryPath,
        error: sanitize(error),
      });
    }
    if (desktopHostEntry !== undefined) {
      const loaderCall = desktopHostEntry.includes("loadProfileDirectory");
      const runProfileCall = desktopHostEntry.includes("runProfile");
      addCheck(report, "desktop-runtime:host-entry", loaderCall && runProfileCall ? "PASS" : "FAIL", loaderCall && runProfileCall
        ? "actual app.asar dsh-desktop-host contains the profile loader/runProfile entry used by the child probe"
        : "actual app.asar dsh-desktop-host entry did not contain the expected loader/runProfile calls", {
        entryPath: desktopHostEntryPath,
        hostEntrySha256: sha256Bytes(desktopHostEntry),
        loadProfileDirectory: loaderCall,
        runProfile: runProfileCall,
      });
    }
    addCheck(report, "desktop-runtime:hash", "PASS", "captured SHA-256 for the actual installed app.asar", {
      appAsarSha256: sha256(paths.asar),
      appAsarBytes: statSync(paths.asar).size,
      executableSha256: sha256(paths.executable),
    });
    protectedBefore = protectedProfileSnapshot();

    if (!options.tgz) {
      addCheck(report, "desktop-profile-input", "SKIP", "--tgz was not supplied; package installation and real plugin loading were not attempted");
      return report;
    }
    const tgz = resolve(options.tgz);
    if (!existsSync(tgz) || extname(tgz).toLowerCase() !== ".tgz") {
      addCheck(report, "desktop-profile-input", "FAIL", "--tgz must point to an existing .tgz file");
      return report;
    }
    report.package = {
      pluginVersion: EXPECTED_PLUGIN_VERSION,
      tgzSha256: sha256(tgz),
      tgzBytes: statSync(tgz).size,
    };
    mkdirSync(RUN_ROOT, { recursive: true });
    tempRoot = mkdtempSync(join(RUN_ROOT, "desktop-probe-"));
    assertTempRoot(tempRoot);
    const dshHome = join(tempRoot, "dsh-home");
    const profile = join(dshHome, "profiles", "desktop");
    const workspace = join(tempRoot, "workspace 中文 space");
    const outside = join(tempRoot, "outside fixture 中文 space");
    const logRoot = join(tempRoot, "logs");
    const isolatedNpmrc = join(tempRoot, "npmrc");
    const probePackage = join(ROOT, "dev", "测试", "CLI", "probe-package");
    mkdirSync(profile, { recursive: true });
    mkdirSync(workspace, { recursive: true });
    mkdirSync(outside, { recursive: true });
    mkdirSync(logRoot, { recursive: true });
    writeFileSync(isolatedNpmrc, "# isolated Desktop probe; no credentials or registry overrides\n");
    writeProfile(profile, tgz, true, probePackage, false, options.noRemoteAnswerer);
    if (options.noRemoteAnswerer) {
      addCheck(report, "desktop-context:approval-variant", "PASS", "test-only profile requests the actual Host api-remotes forwarding row disabled; live Loader state is checked after startup, while approval service remains loaded for rejection auditing", {
        rowIds: ["api-remotes"],
        patch: "- id: api-remotes\\n  name: '@deepseek-ai/dsh-api-remotes'\\n  disabled: true",
        source: "actual dsh-api-remotes host row in the rc.2 composition",
      });
    }

    const install = await runCommand(paths.node, [
      paths.pnpm,
      "install",
      "--offline",
      "--no-frozen-lockfile",
      "--ignore-scripts",
      "--config.auto-install-peers=false",
    ], {
      cwd: profile,
      env: {
        DSH_HOME: dshHome,
        COREPACK_ENABLE_PROJECT_SPEC: "0",
        NPM_CONFIG_USERCONFIG: isolatedNpmrc,
        npm_config_userconfig: isolatedNpmrc,
        NPM_CONFIG_UPDATE_NOTIFIER: "false",
        npm_config_update_notifier: "false",
        TEMP: logRoot,
        TMP: logRoot,
        TMPDIR: logRoot,
      },
      timeoutMs: 180_000,
    });
    const installLifecycleOk = Number.isInteger(install.code)
      && install.error === undefined
      && install.timedOut === false
      && install.cleanup?.closeObserved === true
      && install.cleanup?.reaped === true
      && install.cleanup?.aliveAfter === false;
    if (!installLifecycleOk || install.code !== 0) {
      addCheck(report, "desktop-profile:offline-install", "FAIL", "bundled Desktop pnpm could not install the local TGZ without legacy-peer-deps", {
        code: install.code,
        timedOut: install.timedOut,
        error: install.error ?? null,
        closeObserved: install.cleanup?.closeObserved ?? false,
        reaped: install.cleanup?.reaped ?? false,
        aliveAfter: install.cleanup?.aliveAfter ?? null,
        stderr: sanitize(install.stderr, [[tempRoot, "<test-root>"]]),
      });
      return report;
    }
    const installedPackage = join(profile, "node_modules", "dsh-plugin-bash-wsl", "package.json");
    const installedOk = existsSync(installedPackage) && jsonFile(installedPackage).version === EXPECTED_PLUGIN_VERSION;
    addCheck(report, "desktop-profile:offline-install", installedOk ? "PASS" : "FAIL", installedOk
      ? "local TGZ is installed in the isolated desktop profile"
      : "isolated profile did not contain dsh-plugin-bash-wsl@0.2.0 after install", {
      packagePath: "profiles/desktop/node_modules/dsh-plugin-bash-wsl/package.json",
      installer: "bundled Desktop pnpm --offline (no legacy-peer-deps)",
      closeObserved: install.cleanup?.closeObserved ?? false,
      reaped: install.cleanup?.reaped ?? false,
      });
      if (!installedOk) return report;

      const sourceProbeIndex = join(probePackage, "index.mjs");
      const installedProbeIndex = join(profile, "node_modules", "dsh-cli-probe", "index.mjs");
      const sourceProbeObserver = join(probePackage, "windows-process-observer.mjs");
      const installedProbeObserver = join(
        profile,
        "node_modules",
        "dsh-cli-probe",
        "windows-process-observer.mjs",
      );
      const sourceProbeIndexSha256 = existsSync(sourceProbeIndex) ? sha256(sourceProbeIndex) : null;
      const installedProbeIndexSha256 = existsSync(installedProbeIndex) ? sha256(installedProbeIndex) : null;
      const sourceProbeObserverSha256 = existsSync(sourceProbeObserver)
        ? sha256(sourceProbeObserver) : null;
      const installedProbeObserverSha256 = existsSync(installedProbeObserver)
        ? sha256(installedProbeObserver) : null;
      report.probeIdentity = {
        ...probeIdentityFromHashes({
          sourceProbeIndexSha256,
          installedProbeIndexSha256,
          sourceProbeObserverSha256,
          installedProbeObserverSha256,
        }),
        source: "dev/测试/CLI/probe-package/index.mjs",
        installed: "profiles/desktop/node_modules/dsh-cli-probe/index.mjs",
        observerSource: "dev/测试/CLI/probe-package/windows-process-observer.mjs",
        observerInstalled: "profiles/desktop/node_modules/dsh-cli-probe/windows-process-observer.mjs",
      };
      const probeIdentityOk = report.probeIdentity.probeIndexHashesMatch
        && report.probeIdentity.probeObserverRequired
        && report.probeIdentity.probeObserverHashesMatch;
      addCheck(report, "desktop-profile:probe-identity", probeIdentityOk ? "PASS" : "FAIL",
        probeIdentityOk
          ? "Desktop probe index and required windows-process-observer source/installed bytes match"
          : "Desktop probe index or required windows-process-observer source/installed bytes are missing or mismatched",
        report.probeIdentity);
      if (!probeIdentityOk) {
        report.status = "FAIL";
        return report;
      }

      const negativeRoot = join(tempRoot, "negative");
      mkdirSync(negativeRoot, { recursive: true });
      const runNegativeInstall = async (id, dependencyTgz, expectedVersion = undefined) => {
        const negativeHome = join(negativeRoot, id, "dsh-home");
        const negativeProfile = join(negativeHome, "profiles", id);
        const negativeWorkspace = join(negativeRoot, id, "workspace");
        const negativeTemp = join(negativeRoot, id, "temp");
        const negativeNpmrc = join(negativeRoot, id, "npmrc");
        mkdirSync(negativeProfile, { recursive: true });
        mkdirSync(negativeWorkspace, { recursive: true });
        mkdirSync(negativeTemp, { recursive: true });
        writeFileSync(negativeNpmrc, "# isolated Desktop negative probe; no credentials or registry overrides\n");
        writeProfile(negativeProfile, dependencyTgz, true, probePackage, false);
        const result = await runCommand(paths.node, [
          paths.pnpm,
          "install",
          "--offline",
          "--no-frozen-lockfile",
          "--ignore-scripts",
          "--config.auto-install-peers=false",
        ], {
          cwd: negativeProfile,
          env: {
            DSH_HOME: negativeHome,
            COREPACK_ENABLE_PROJECT_SPEC: "0",
            NPM_CONFIG_USERCONFIG: negativeNpmrc,
            npm_config_userconfig: negativeNpmrc,
            NPM_CONFIG_UPDATE_NOTIFIER: "false",
            npm_config_update_notifier: "false",
            TEMP: negativeTemp,
            TMP: negativeTemp,
            TMPDIR: negativeTemp,
          },
          timeoutMs: 180_000,
        });
        const installedPath = join(negativeProfile, "node_modules", "dsh-plugin-bash-wsl", "package.json");
        const installedManifest = existsSync(installedPath) ? jsonFile(installedPath) : undefined;
        const installedVersion = installedManifest?.version;
        const fixtureManifest = tgzPackageManifest(dependencyTgz);
        const fixturePeerRange = fixtureManifest?.peerDependencies?.["@deepseek-ai/dsh"] ?? null;
        const dependencyExists = existsSync(dependencyTgz);
        const inputClass = expectedVersion === undefined
          ? (dependencyExists ? "malformed-tgz" : "missing-tgz")
          : "old-version-tgz";
        const diagnostic = sanitize(`${result.stdout}\n${result.stderr}\n${result.error ?? ""}`, [
          [negativeRoot, "<test-root>"],
          [tempRoot, "<test-root>"],
        ]);
        const offlineCacheBlocked = inputClass === "old-version-tgz"
          && /(?:ERR_PNPM_NO_OFFLINE_TARBALL|offline[^\n]*(?:store|tarball|download))/i.test(diagnostic);
        const diagnosticMatched = inputClass === "missing-tgz"
          ? /(?:\bENOENT\b|no such file|not found|cannot find|ERR_PNPM_(?:NO_MATCHING_VERSION|META_FETCH_FAIL))/i.test(diagnostic)
          : inputClass === "malformed-tgz"
            ? /(?:ERR_PNPM_(?:TARBALL_INTEGRITY|BAD_TARBALL)|integrity|invalid|malformed|not a gzip|archive|unexpected end)/i.test(diagnostic)
            : !offlineCacheBlocked
              && /(?:ERR_PNPM_PEER_DEP_ISSUES|unmet peer|conflicting peer|peer[^\n]*(?:incompatible|mismatch)|@deepseek-ai\/dsh[^\n]*(?:requires|incompatible|mismatch))/i.test(diagnostic);
        const processProof = Number.isInteger(result.code)
          && result.error === undefined
          && result.timedOut === false
          && result.cleanup?.closeObserved === true
          && result.cleanup?.reaped === true
          && result.cleanup?.aliveAfter === false;
        const targetNotAccepted = installedVersion !== EXPECTED_PLUGIN_VERSION;
        const expectedOldPeer = "0.1.0-rc.6";
        const oldPeerRange = installedManifest?.peerDependencies?.["@deepseek-ai/dsh"] ?? null;
        const fixtureIdentity = inputClass === "missing-tgz"
          ? !dependencyExists && fixtureManifest === undefined
          : inputClass === "malformed-tgz"
            ? dependencyExists && fixtureManifest === undefined
            : fixtureManifest?.name === "dsh-plugin-bash-wsl"
              && fixtureManifest.version === expectedVersion;
        const oldFixtureIdentity = expectedVersion === undefined
          || (fixtureIdentity && (installedVersion === undefined
            || (installedVersion === expectedVersion && oldPeerRange === expectedOldPeer)));
        const oldHostCompatibilityMismatch = expectedVersion === undefined
          || (fixturePeerRange === expectedOldPeer && fixturePeerRange !== EXPECTED_DESKTOP_VERSION);
        const explicitRejection = expectedVersion === undefined
          && result.code !== 0
          && targetNotAccepted
          && fixtureIdentity
          && diagnosticMatched;
        const explicitOldFixture = expectedVersion !== undefined
          && fixtureIdentity
          && oldHostCompatibilityMismatch
          && result.code !== 0
          && targetNotAccepted
          && diagnosticMatched;
        const oldAcceptedWithoutRejection = expectedVersion !== undefined
          && processProof
          && result.code === 0
          && oldFixtureIdentity
          && oldHostCompatibilityMismatch;
        const oldCompatibilityUnavailable = expectedVersion !== undefined
          && processProof
          && result.code !== 0
          && fixtureIdentity
          && targetNotAccepted
          && offlineCacheBlocked;
        const negativePassed = processProof && (explicitRejection || explicitOldFixture);
        const negativeStatus = negativePassed
          ? "PASS"
          : oldAcceptedWithoutRejection || oldCompatibilityUnavailable
            ? "SKIP"
            : "FAIL";
          const negativeEvidence = {
            inputClass,
            dependencyExists,
            diagnostic,
            diagnosticMatched,
            exitCode: result.code,
            timedOut: result.timedOut,
            error: result.error ?? null,
            installedVersion: installedVersion ?? null,
            expectedFixtureVersion: expectedVersion ?? null,
            hostVersion: EXPECTED_DESKTOP_VERSION,
            fixtureName: fixtureManifest?.name ?? null,
            fixtureManifestVersion: fixtureManifest?.version ?? null,
            fixturePeerRange,
            fixtureIdentity,
            oldPeerRange,
            expectedOldPeer,
            targetNotAccepted,
            oldFixtureIdentity,
            oldHostCompatibilityMismatch,
            explicitRejection,
            explicitOldFixture,
            oldAcceptedWithoutRejection,
            offlineCacheBlocked,
            oldCompatibilityUnavailable,
            processProof,
            cleanup: result.cleanup ?? null,
          };
          if (expectedVersion !== undefined) {
            // The bundled pnpm --offline path is only a historical/cache
            // diagnostic.  It cannot prove (or veto) rc.2 compatibility: the
            // required old-version rejection is exercised separately by the
            // actual rc.2 loader + Host runtime-negative probe.
            report.diagnostics.oldVersionPnpmCache.push({
              id: `desktop-negative:${id}`,
              status: "SKIP",
              rawClassification: negativeStatus,
              detail: oldCompatibilityUnavailable
                ? "ordinary old-version pnpm offline dependency/cache failure; retained as diagnostic-only SKIP"
                : oldAcceptedWithoutRejection
                  ? "ordinary old-version pnpm path did not exercise actual rc.2 compatibility rejection; retained as diagnostic-only SKIP"
                  : negativePassed
                    ? "ordinary old-version pnpm path produced a rejection, but is not the required actual-host D-14 proof; retained as diagnostic-only SKIP"
                    : "ordinary old-version pnpm path lacked a qualification-safe result; retained as diagnostic-only SKIP",
              evidence: negativeEvidence,
            });
            return;
          }
          addCheck(report, `desktop-negative:${id}`, negativeStatus, negativePassed
            ? `isolated Desktop pnpm explicitly rejected the ${inputClass} with a clean nonzero exit and matching diagnostic`
            : "negative package input lacked the expected typed rejection/fixture identity or clean child lifecycle",
            negativeEvidence);
      };
      await runNegativeInstall("missing-tgz", join(negativeRoot, "missing-dsh-plugin-bash-wsl.tgz"));
      const malformedTgz = join(negativeRoot, "malformed.tgz");
      writeFileSync(malformedTgz, "not a gzip archive\n");
      await runNegativeInstall("malformed-tgz", malformedTgz);
      const oldTgz = join(ROOT, "dsh-plugin-bash-wsl-0.1.0.tgz");
      if (existsSync(oldTgz)) {
        await runNegativeInstall("old-version-tgz", oldTgz, "0.1.0");
      }

      for (const [phaseLabel, enabled, permissionMode, probeSuite] of [
      ["present", true, "workspace-write", "security"],
      ["present-read-only", true, "read-only", "security"],
      ["present-full-access", true, "danger-full-access", "security"],
      ["absent", false, "workspace-write", undefined],
      ["reloaded", true, "workspace-write", undefined],
    ].filter(([label]) => options.phase === undefined || options.phase === label)) {
        const selectedProbeSuite = options.suite ?? probeSuite;
        writeProfile(profile, tgz, enabled, probePackage, selectedProbeSuite !== undefined, options.noRemoteAnswerer, selectedProbeSuite);
      const expected = enabled ? "present" : "absent";
      const evidencePath = join(tempRoot, `${phaseLabel}.json`);
      const phase = await spawnDesktopChild(paths, profile, dshHome, workspace, expected, evidencePath, logRoot, phaseLabel, permissionMode, selectedProbeSuite, tempRoot, outside);
      phase.label = phaseLabel;
      phase.expectedEnabled = enabled;
      phase.permissionMode = permissionMode;
      report.phases.push(phase);
      if (phase.evidence?.checks) {
        for (const check of phase.evidence.checks) {
          addCheck(report, `${phaseLabel}:${check.id}`, check.status, check.detail, check.evidence);
        }
      } else {
        addCheck(report, `${phaseLabel}:child-start`, "FAIL", "Desktop child produced no structured evidence", {
          exitCode: phase.close.code ?? null,
          stderr: phase.stderr,
        });
      }
      if (phase.close.timedOut || phase.close.kill?.aliveAfter || phase.close.kill?.reaped === false) {
        addCheck(report, `${phaseLabel}:process-cleanup`, "FAIL", "Desktop child required termination and remained alive after cleanup", phase.close.kill);
      } else {
        addCheck(report, `${phaseLabel}:process-cleanup`, "PASS", "Desktop child exited and no forced process-tree cleanup remained", {
          exitCode: phase.close.code ?? null,
          signal: phase.close.signal ?? null,
          closeObserved: phase.close.kill?.closeObserved ?? true,
          reaped: phase.close.kill?.reaped ?? true,
        });
      }
    }
    // Run the same official integration probe inside the real rc.2 context on
    // the isolated workspace. This is separate from the three-mode security
    // child phases so CLI-02/10/12 persistent lifecycle evidence is not
    // mistaken for a CLI-only result.
    if (options.phase !== undefined && options.phase !== "integration") return report;
    writeProfile(profile, tgz, true, probePackage, true, options.noRemoteAnswerer);
    const integrationEvidencePath = join(tempRoot, "integration.json");
    const integrationPhase = await spawnDesktopChild(paths, profile, dshHome, workspace, "present", integrationEvidencePath, logRoot, "integration", "workspace-write", "integration", tempRoot, outside);
    report.integration = integrationPhase;
    if (integrationPhase.evidence?.checks) {
      for (const check of integrationPhase.evidence.checks) {
        addCheck(report, `desktop-integration:${check.id}`, check.status, check.detail, check.evidence);
      }
    } else {
      addCheck(report, "desktop-integration:child-start", "FAIL", "Desktop integration child produced no structured evidence", {
        exitCode: integrationPhase.close.code ?? null,
        stderr: integrationPhase.stderr,
      });
    }
    if (integrationPhase.close.timedOut || integrationPhase.close.kill?.aliveAfter || integrationPhase.close.kill?.reaped === false) {
      addCheck(report, "desktop-integration:process-cleanup", "FAIL", "Desktop integration child required termination and remained alive after cleanup", integrationPhase.close.kill);
    } else {
      addCheck(report, "desktop-integration:process-cleanup", "PASS", "Desktop integration child exited and no forced process-tree cleanup remained", {
        exitCode: integrationPhase.close.code ?? null,
        signal: integrationPhase.close.signal ?? null,
        closeObserved: integrationPhase.close.kill?.closeObserved ?? true,
        reaped: integrationPhase.close.kill?.reaped ?? true,
      });
    }
  } finally {
    if (asar) asar.close();
    if (tempRoot && !options.keep) {
      try {
        rmSync(tempRoot, { recursive: true, force: true });
        report.cleanup.temporaryRootRemoved = true;
      } catch (error) {
        report.cleanup.temporaryRootRemoved = false;
        addCheck(report, "cleanup:temporary-root", "FAIL", "could not remove the isolated test root", { error: sanitize(error) });
      }
    } else if (tempRoot) {
      report.cleanup.temporaryRootRemoved = false;
      report.cleanup.retainedForDebug = true;
    }
    if (protectedBefore !== undefined) {
      const protectedAfter = protectedProfileSnapshot();
      const unchanged = JSON.stringify(protectedBefore) === JSON.stringify(protectedAfter);
      addCheck(report, "desktop-protected-profile-integrity", unchanged ? "PASS" : "FAIL", unchanged
        ? "real web/desktop profile metadata and preserved old TGZ hashes are unchanged"
        : "real web/desktop profile metadata or preserved old TGZ hashes changed", {
        before: protectedBefore,
        after: protectedAfter,
      });
    }
  }
  report.status = report.checks.some((check) => check.status === "FAIL")
    ? "FAIL"
    : report.checks.some((check) => check.status === "SKIP")
      ? "SKIP"
      : "PASS";
  return report;
}

async function run() {
  if (process.argv[2] === "--desktop-runtime-negative-child") {
    await runtimeNegativeChildMain(process.argv.slice(3));
    return;
  }
  if (process.argv[2] === "--desktop-runtime-negative") {
    let evidence;
    try {
      evidence = await runtimeNegativeMain(process.argv.slice(3));
    } catch (error) {
      evidence = {
        schemaVersion: 2,
        target: `Desktop ${EXPECTED_DESKTOP_VERSION} / preserved plugin 0.1.0`,
        status: "FAIL",
        qualification: `FAIL: uncaught runtime-negative error: ${sanitize(error)}`,
      };
    }
    // Keep the structured result available even when the host capability is
    // missing; callers must treat SKIP as blocking rather than as PASS.
    console.log(`D14 runtime-negative: ${evidence?.status ?? "FAIL"}`);
    console.log(`Qualification: ${evidence?.qualification ?? "missing evidence"}`);
    console.log(`Evidence: ${relative(ROOT, evidence?.evidencePath ?? "").replaceAll("\\", "/")}`);
    process.exitCode = evidence?.status === "PASS" ? 0 : 1;
    return;
  }
  if (process.argv[2] === "--desktop-probe-child") {
    await childMain(process.argv.slice(3));
    return;
  }
  let report;
  try {
    report = await main();
  } catch (error) {
    report = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      target: "Desktop 0.2.0-rc.2 / plugin 0.2.0",
      checks: [{ id: "desktop-probe:uncaught", status: "FAIL", detail: sanitize(error) }],
      phases: [],
      cleanup: {},
    };
  }
  mkdirSync(RUN_ROOT, { recursive: true });
  const evidencePath = join(RUN_ROOT, `desktop-evidence-${nowTag()}.json`);
  writeFileSync(evidencePath, `${JSON.stringify(report, null, 2)}\n`);
  const failed = report.checks.filter((check) => check.status === "FAIL").length;
  const skipped = report.checks.filter((check) => check.status === "SKIP").length;
  const passed = report.checks.filter((check) => check.status === "PASS").length;
  console.log(`\nDesktop probe: ${passed} passed, ${skipped} skipped, ${failed} failed`);
  console.log(`Evidence: ${relative(ROOT, evidencePath).replaceAll("\\", "/")}`);
  process.exitCode = failed > 0 || skipped > 0 ? 1 : 0;
}

await run();
