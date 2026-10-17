import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";

export const PROJECT_ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
export const RUN_ROOT = join(PROJECT_ROOT, "测试", "运行产物");

function resolveWindowsUserProfile() {
  const fromEnvironment = [
    process.env.DSH_WINDOWS_USERPROFILE,
    process.env.USERPROFILE,
  ].find((value) => typeof value === "string" && /^[A-Za-z]:[\\/]/.test(value));
  if (fromEnvironment !== undefined) return fromEnvironment.replaceAll("/", "\\");
  try {
    const value = execFileSync("cmd.exe", ["/d", "/c", "echo %USERPROFILE%"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    if (/^[A-Za-z]:[\\/]/.test(value)) return value.replaceAll("/", "\\");
  } catch {}
  return undefined;
}

const WINDOWS_USER_PROFILE = resolveWindowsUserProfile();
export const WINDOWS_CLI_PACKAGE_DEFAULT = WINDOWS_USER_PROFILE === undefined
  ? ""
  : `${WINDOWS_USER_PROFILE}\\AppData\\Roaming\\npm\\node_modules\\@deepseek-ai\\dsh\\package.json`;
export const WINDOWS_CLI_ENTRY_DEFAULT = WINDOWS_USER_PROFILE === undefined
  ? ""
  : `${WINDOWS_USER_PROFILE}\\AppData\\Roaming\\npm\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js`;
export const WINDOWS_NODE_DEFAULT = "node.exe";
export const EXPECTED_CLI_VERSION = "0.2.1-rc.2";
export const EXPECTED_PLUGIN_VERSION = "0.2.1";
export const MAX_CHILD_OUTPUT_BYTES = 2 * 1024 * 1024;
// Test-only override applied inside each isolated profile.  Production plugin
// files and the source patch remain untouched; this makes the persistent-shell
// timeout/reset lifecycle bounded enough for the real CLI probe.
export const TEST_PERSISTENT_TIMEOUT_MS = 10_000;

export function sanitizeDiagnostic(value) {
  return String(value)
    .replaceAll(PROJECT_ROOT, "<project-root>")
    .replace(/([A-Za-z]:[\\/]Users[\\/])[^\\/\r\n]+/g, "$1<user>")
    .replace(/([\\/]mnt[\\/]\w[\\/]Users[\\/])[^\\/\r\n]+/g, "$1<user>");
}

export class SkipError extends Error {
  constructor(message) {
    super(message);
    this.name = "SkipError";
  }
}

export function toWindowsPath(value) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("a non-empty path is required");
  }
  // The orchestrator normally runs as Linux Node and uses wslpath. When a
  // caller invokes this harness with Windows Node through WSL, environment
  // variables may still contain the WSL form (/mnt/c/...). Normalize that
  // explicit mount spelling before using win32 path resolution; otherwise the
  // Windows process would look under C:\\mnt\\c instead of the real file.
  const wslMount = /^\/mnt\/([A-Za-z])(?:\/(.*))?$/s.exec(value);
  if (wslMount?.[1] !== undefined) {
    const tail = wslMount[2] ?? "";
    return `${wslMount[1].toUpperCase()}:\\${tail.replaceAll("/", "\\")}`;
  }
  if (process.platform === "win32") return resolve(value);
  if (/^[A-Za-z]:[\\/]/.test(value)) return value.replaceAll("/", "\\");
  try {
    return execFileSync("wslpath", ["-w", value], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    throw new SkipError(`wslpath is unavailable; cannot address the Windows CLI: ${error}`);
  }
}

export function toLocalPath(value) {
  if (process.platform === "win32") {
    const wslMount = /^\/mnt\/([A-Za-z])(?:\/(.*))?$/s.exec(value);
    if (wslMount?.[1] !== undefined) {
      const tail = wslMount[2] ?? "";
      return `${wslMount[1].toUpperCase()}:\\${tail.replaceAll("/", "\\")}`;
    }
    return value;
  }
  const match = /^([A-Za-z]):[\\/](.*)$/s.exec(value);
  if (match?.[1] !== undefined && match[2] !== undefined) {
    return `/mnt/${match[1].toLowerCase()}/${match[2].replaceAll("\\", "/")}`;
  }
  return value;
}

export function toWslPath(value) {
  if (process.platform !== "win32") {
    try {
      return execFileSync("wslpath", ["-a", value], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    } catch {
      const match = /^([A-Za-z]):[\\/](.*)$/s.exec(value);
      if (match?.[1] !== undefined && match[2] !== undefined) {
        return `/mnt/${match[1].toLowerCase()}/${match[2].replaceAll("\\", "/")}`;
      }
    }
  }
  const match = /^([A-Za-z]):[\\/](.*)$/s.exec(value);
  if (match?.[1] === undefined || match[2] === undefined) {
    throw new Error(`cannot map Windows path to WSL: ${JSON.stringify(value)}`);
  }
  return `/mnt/${match[1].toLowerCase()}/${match[2].replaceAll("\\", "/")}`;
}

export function assertOwnedPath(root, candidate) {
  const parent = resolve(root);
  const child = resolve(candidate);
  const rel = relative(parent, child);
  if (rel === "" || rel === ".." || rel.startsWith(`..${win32.sep}`) || rel.startsWith("../") || win32.isAbsolute(rel)) {
    throw new Error(`test path escaped 测试/运行产物: ${child}`);
  }
  return child;
}

export function createOwnedTestRoot(label) {
  mkdirSync(RUN_ROOT, { recursive: true });
  const root = mkdtempSync(join(RUN_ROOT, `${label}-`));
  const workspace = join(root, "workspace 中文 space");
  const outside = join(root, "outside fixture 中文 space");
  const logs = join(root, "logs");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(outside, { recursive: true });
  mkdirSync(logs, { recursive: true });
  const result = {
    root,
    workspace,
    outside,
    logs,
    marker: join(outside, "interop-marker.txt"),
    windowsRoot: toWindowsPath(root),
    windowsWorkspace: toWindowsPath(workspace),
    windowsOutside: toWindowsPath(outside),
    windowsMarker: toWindowsPath(join(outside, "interop-marker.txt")),
    wslWorkspace: toWslPath(toWindowsPath(workspace)),
    wslOutside: toWslPath(toWindowsPath(outside)),
    wslMarker: toWslPath(toWindowsPath(join(outside, "interop-marker.txt"))),
  };
  return result;
}

export function cleanupOwnedTestRoot(root) {
  const runRoot = realpathSync(RUN_ROOT);
  const target = realpathSync(root);
  const rel = relative(runRoot, target);
  if (rel === "" || rel === ".." || rel.startsWith("..\\") || rel.startsWith("../") || win32.isAbsolute(rel)) {
    throw new Error(`refusing to remove a path outside 测试/运行产物: ${target}`);
  }
  try {
    rmSync(target, {
      recursive: true,
      force: true,
      // Windows may release the WSL interop handle just after the managed child
      // exits. Retry only this containment-checked test root; never broaden the
      // target or turn cleanup into a best-effort pass.
      maxRetries: 5,
      retryDelay: 200,
    });
  } catch (error) {
    // Preserve the containment-checked target for diagnosis. Do not fall back
    // to cross-shell recursive deletion or to an interpolated command string.
    throw error;
  }
}

function executableForWindowsNode() {
  if (process.platform === "win32") return process.execPath;
  return process.env.DSH_WINDOWS_NODE ?? WINDOWS_NODE_DEFAULT;
}

function localCliPackage() {
  const value = process.env.DSH_WINDOWS_CLI_PACKAGE ?? WINDOWS_CLI_PACKAGE_DEFAULT;
  if (value.length === 0) {
    throw new SkipError("Windows CLI path is unknown; set DSH_WINDOWS_CLI_PACKAGE");
  }
  return toLocalPath(value);
}

export function assertWindowsCliAvailable() {
  const executable = executableForWindowsNode();
  if (process.platform === "win32") {
    if (!existsSync(executable)) throw new SkipError("Windows Node is missing");
  } else {
    try {
      execFileSync(executable, ["-e", "process.stdout.write(process.platform)"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      throw new SkipError(`Windows Node interop is unavailable: ${error}`);
    }
  }
  const packagePath = localCliPackage();
  const entryWindowsPath = process.env.DSH_WINDOWS_CLI_ENTRY ?? WINDOWS_CLI_ENTRY_DEFAULT;
  if (entryWindowsPath.length === 0) {
    throw new SkipError("Windows CLI entry path is unknown; set DSH_WINDOWS_CLI_ENTRY");
  }
  const entryPath = toLocalPath(entryWindowsPath);
  if (!existsSync(packagePath) || !existsSync(entryPath)) {
    throw new SkipError("Windows CLI 0.2.1-rc.2 package or entry was not found");
  }
  const manifest = JSON.parse(readFileSync(packagePath, "utf8"));
  if (manifest.name !== "@deepseek-ai/dsh") {
    throw new Error(`unexpected CLI package at ${packagePath}: ${manifest.name}`);
  }
  if (manifest.version !== EXPECTED_CLI_VERSION) {
    throw new Error(`expected CLI ${EXPECTED_CLI_VERSION}, found ${manifest.version}`);
  }
  return { executable, packagePath, entryPath: entryWindowsPath, manifest };
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function sha256Directory(root) {
  const files = [];
  const visit = (directory, prefix = "") => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const relativePath = join(prefix, entry.name);
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) visit(absolutePath, relativePath);
      else if (entry.isFile()) files.push(relativePath);
    }
  };
  visit(root);
  const digest = createHash("sha256");
  for (const relativePath of files.sort()) {
    digest.update(relativePath.replaceAll("\\", "/"));
    digest.update("\0");
    digest.update(readFileSync(join(root, relativePath)));
  }
  return digest.digest("hex");
}

function windowsNodeVersion(executable) {
  try {
    return execFileSync(executable, ["-p", "process.version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    return undefined;
  }
}

export function decodeWindowsCommandOutput(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value ?? "");
  if (bytes.length === 0) {
    return { text: "", encoding: "utf8", utf16Detected: false, hadBom: false, byteLength: 0 };
  }
  const isLeBom = bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe;
  const isBeBom = bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff;
  const sampleLength = Math.min(bytes.length, 512);
  let oddZeroes = 0;
  let evenZeroes = 0;
  for (let index = 0; index < sampleLength; index += 1) {
    if (bytes[index] !== 0) continue;
    if (index % 2 === 0) evenZeroes += 1;
    else oddZeroes += 1;
  }
  const pairCount = Math.floor(sampleLength / 2);
  const likelyLe = !isBeBom && (isLeBom
    || (oddZeroes >= 2 && oddZeroes >= Math.max(2, Math.floor(pairCount * 0.2)) && oddZeroes > evenZeroes * 2));
  const likelyBe = isBeBom || (!isLeBom
    && evenZeroes >= 2 && evenZeroes >= Math.max(2, Math.floor(pairCount * 0.2)) && evenZeroes > oddZeroes * 2);
  let text;
  let encoding = "utf8";
  let hadBom = false;
  if (likelyLe) {
    encoding = "utf16le";
    hadBom = isLeBom;
    text = bytes.subarray(isLeBom ? 2 : 0).toString("utf16le");
  } else if (likelyBe) {
    encoding = "utf16be";
    hadBom = isBeBom;
    const payload = bytes.subarray(isBeBom ? 2 : 0);
    const swapped = Buffer.from(payload);
    for (let index = 0; index + 1 < swapped.length; index += 2) {
      const first = swapped[index];
      swapped[index] = swapped[index + 1];
      swapped[index + 1] = first;
    }
    text = swapped.toString("utf16le");
  } else {
    text = bytes.toString("utf8");
  }
  return { text, encoding, utf16Detected: likelyLe || likelyBe, hadBom, byteLength: bytes.length };
}

function wslHostVersion() {
  try {
    const raw = execFileSync(process.platform === "win32" ? "wsl.exe" : "wsl.exe", ["--version"], {
      encoding: "buffer",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const decoded = decodeWindowsCommandOutput(raw);
    return {
      text: decoded.text.trim().slice(-2000),
      encoding: decoded.encoding,
      utf16Detected: decoded.utf16Detected,
      hadBom: decoded.hadBom,
      byteLength: decoded.byteLength,
    };
  } catch {
    return undefined;
  }
}

function appendBounded(current, chunk, limit) {
  const text = `${current}${chunk}`;
  if (Buffer.byteLength(text, "utf8") <= limit) return { text, truncated: false };
  const bytes = Buffer.from(text, "utf8");
  return { text: bytes.subarray(bytes.length - limit).toString("utf8"), truncated: true };
}

export function runWindowsDsh({
  home,
  workspace,
  processCwd = workspace,
  args,
  env = {},
  timeoutMs = 180_000,
}) {
  const host = assertWindowsCliAvailable();
  const testRoot = dirname(home);
  const testTemp = join(testRoot, "temp");
  const testAppData = join(testRoot, "appdata");
  const testNpmConfig = join(testRoot, "npmrc");
  mkdirSync(testTemp, { recursive: true });
  mkdirSync(testAppData, { recursive: true });
  mkdirSync(join(testAppData, "local"), { recursive: true });
  writeFileSync(testNpmConfig, "# isolated CLI validation; no credentials\\n");
  // Start the real Windows CLI with only host execution variables and an
  // owned test home. In particular, do not inherit account, provider, model,
  // credential, or unrelated DSH_* settings from the interactive process.
  const inherited = process.env;
  const allowedHostKeys = [
    "PATH", "Path", "PATHEXT", "SystemRoot", "WINDIR", "windir",
    "ComSpec", "COMSPEC", "ProgramFiles", "ProgramFiles(x86)",
    "ProgramData", "CommonProgramFiles", "CommonProgramFiles(x86)",
    "SystemDrive", "SYSTEMDRIVE", "OS", "PROCESSOR_ARCHITECTURE",
    "PROCESSOR_IDENTIFIER", "NUMBER_OF_PROCESSORS", "LANG", "LC_ALL",
    // Retain Windows package-manager/cache locations, but override npm's
    // user config below so credentials are never read from the real profile.
    "APPDATA", "LOCALAPPDATA", "USERPROFILE", "HOME",
  ];
  const cleanEnvironment = Object.fromEntries(
    allowedHostKeys
      .filter((key) => typeof inherited[key] === "string")
      .map((key) => [key, inherited[key]])
      .concat([
        ["DSH_HOME", toWindowsPath(home)],
        ["DSH_TELEMETRY_DISABLED", "1"],
        ["DSH_TELEMETRY_MODE", "DISABLED"],
        ["NO_COLOR", "1"],
        ["CI", "1"],
        ["TEMP", toWindowsPath(testTemp)],
        ["TMP", toWindowsPath(testTemp)],
        ["NPM_CONFIG_USERCONFIG", toWindowsPath(testNpmConfig)],
        ["npm_config_userconfig", toWindowsPath(testNpmConfig)],
      ]),
  );
  const child = spawn(host.executable, [host.entryPath, ...args], {
    // Keep the CLI child's process cwd independently configurable for tests
    // that verify an agent/session workspace is not silently replaced by the
    // host process cwd. Normal callers retain the workspace as the default.
    cwd: process.platform === "win32" ? processCwd : toLocalPath(processCwd),
    env: {
      ...cleanEnvironment,
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    shell: false,
  });
  let stdout = "";
  let stderr = "";
  let outputTruncated = false;
  const collect = (stream, key) => {
    stream?.setEncoding("utf8");
    stream?.on("data", (chunk) => {
      const next = appendBounded(key === "stdout" ? stdout : stderr, chunk, MAX_CHILD_OUTPUT_BYTES);
      if (key === "stdout") stdout = next.text;
      else stderr = next.text;
      outputTruncated ||= next.truncated;
    });
  };
  collect(child.stdout, "stdout");
  collect(child.stderr, "stderr");

  return new Promise((resolveResult) => {
    let settled = false;
    let timedOut = false;
    let killTimer;
    let killError;
    let spawnError;
    let treeKillAttempted = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer !== undefined) clearTimeout(killTimer);
      resolveResult({
        ...result,
        pid: child.pid,
        stdout,
        stderr,
        timedOut,
        outputTruncated,
        treeKillAttempted,
        ...(spawnError === undefined ? {} : { spawnError }),
        ...(killError === undefined ? {} : { killError }),
      });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill();
      } catch (error) {
        killError = sanitizeDiagnostic(error);
      }
        // Do not issue a blind taskkill /PID /T /F after kill(): the child may
        // already have exited and its PID may have been reused.  We own the
        // ChildProcess handle above; without an independently verified live
        // identity/lineage, tree recovery is refused and close/reaped remains
        // the only success evidence.  The bounded fallback below is an
        // explicit unreaped failure, never a success claim after kill().
      killTimer = setTimeout(() => finish({
        exitCode: null,
        signal: "timeout",
        reaped: false,
        error: "Windows CLI child did not emit close after timeout termination",
      }), 10_000);
    }, timeoutMs);
    child.once("error", (error) => {
      // An error event is not proof of process-tree quiescence. Wait for the
      // matching close event before reporting reaped=true.
      spawnError = String(error);
    });
   child.once("close", (exitCode, signal) => finish({
     exitCode,
     signal,
     reaped: true,
      ...(spawnError === undefined ? {} : { error: spawnError }),
   }));
  });
}

export function childLifecycleEvidence(result) {
  const error = result.error ?? result.spawnError ?? result.killError ?? null;
  const evidence = {
    exitCode: result.exitCode ?? null,
    signal: result.signal ?? null,
    timedOut: result.timedOut === true,
    closeObserved: result.reaped === true,
    reaped: result.reaped === true,
    treeKillAttempted: result.treeKillAttempted === true,
    outputTruncated: result.outputTruncated === true,
    error,
  };
  evidence.ok = evidence.exitCode === 0
    && evidence.signal === null
    && evidence.timedOut === false
    && evidence.reaped === true
    && error === null;
  return evidence;
}

export function resolvePluginTgz() {
  const supplied = process.env.DSH_PLUGIN_TGZ;
  if (supplied) {
    const windows = toWindowsPath(supplied);
    if (!existsSync(toLocalPath(windows))) throw new SkipError("plugin TGZ does not exist");
    return windows;
  }
  const candidateRoots = [PROJECT_ROOT, RUN_ROOT];
  const candidates = candidateRoots.flatMap((root) => {
    if (!existsSync(root)) return [];
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^dsh-plugin-bash-wsl-0\.2\.1(?:-[^/]*)?\.tgz$/i.test(entry.name))
      .map((entry) => join(root, entry.name));
  });
  if (candidates.length === 0) {
    throw new SkipError("no dsh-plugin-bash-wsl-0.2.1 TGZ; set DSH_PLUGIN_TGZ to the built package");
  }
  const newest = candidates
    .map((path) => ({ path, mtimeMs: statSync(path).mtimeMs }))
    .sort((left, right) => right.mtimeMs - left.mtimeMs)[0]?.path;
  if (newest === undefined) throw new SkipError("no readable dsh-plugin-bash-wsl-0.2.1 TGZ");
  return toWindowsPath(newest);
}

export function profileDir(context) {
  return join(context.home, "profiles", context.profile);
}

function configureIsolatedPersistentTimeout(context, oneShotLimits = undefined) {
  const profileRoot = realpathSync(profileDir(context));
  const patchPath = join(profileDir(context), "cordis.patch.yml");
  if (!existsSync(patchPath)) {
    throw new Error(`isolated profile patch is missing: ${patchPath}`);
  }
  const before = readFileSync(patchPath, "utf8");
  const patchRel = relative(profileRoot, patchPath);
  if (patchRel === "" || patchRel === ".." || patchRel.startsWith(`..${win32.sep}`)
    || patchRel.startsWith("../") || win32.isAbsolute(patchRel)) {
    throw new Error(`isolated profile patch escaped the profile: ${patchPath}`);
  }
  if (!/^\s*(?:#.*\r?\n)*\[\]\s*$/s.test(before)) {
    throw new Error("isolated profile patch was not the expected empty override layer");
  }
  const after = [
    "# Test-only override; production plugin patch and package store are untouched.",
    "- id: bash-wsl-persistent-tool",
    "  config:",
    "    backendType: wsl",
    `    timeoutMs: ${TEST_PERSISTENT_TIMEOUT_MS}`,
    ...(oneShotLimits === undefined ? [] : [
      "- id: bash-wsl-backend-and-tools",
      "  config:",
      "    backendType: wsl",
      "    oneShotMaxOutputBytes: " + oneShotLimits.memoryLimit,
      "    oneShotMaxSpillBytes: " + oneShotLimits.spillLimit,
    ]),
    "",
  ].join("\n");
  writeFileSync(patchPath, after);
  return {
    patch: "isolated profile cordis.patch.yml",
    detached: false,
    timeoutMs: TEST_PERSISTENT_TIMEOUT_MS,
    ...(oneShotLimits === undefined ? {} : {
      oneShotMaxOutputBytes: oneShotLimits.memoryLimit,
      oneShotMaxSpillBytes: oneShotLimits.spillLimit,
    }),
  };
}

function requireSuccessfulCli(result, description) {
  const lifecycle = childLifecycleEvidence(result);
  const diagnostic = sanitizeDiagnostic(result.error ?? result.stderr);
  if (!lifecycle.ok) throw new Error(`${description}: child lifecycle was not clean: ${JSON.stringify(lifecycle)} ${diagnostic}`);
  if (result.exitCode !== 0) {
    if (/(pnpm was not found|ERR_PNPM_NO_OFFLINE_META|ERR_PNPM_META_FETCH_FAIL|ERR_PNPM_FETCH|offline.*(?:metadata|package)|could not resolve.*offline)/i.test(diagnostic)) {
      throw new SkipError(`${description} capability is unavailable: offline package-manager dependency/cache is missing`);
    }
    throw new Error(`${description} failed (exit=${result.exitCode}): ${diagnostic.slice(-4000)}`);
  }
}

export async function prepareIsolatedProfile(root, label = "cli", options = {}) {
  assertWindowsCliAvailable();
  const pluginTgz = resolvePluginTgz();
  const pluginTgzLocal = toLocalPath(pluginTgz);
  const pluginTgzRelative = relative(PROJECT_ROOT, pluginTgzLocal);
  const pluginTgzIsInsideProject = pluginTgzRelative !== ""
    && pluginTgzRelative !== ".."
    && !pluginTgzRelative.startsWith(`..${win32.sep}`)
    && !pluginTgzRelative.startsWith("../")
    && !win32.isAbsolute(pluginTgzRelative);
  const probePackage = options.probePackage === undefined
    ? toWindowsPath(fileURLToPath(new URL("./probe-package", import.meta.url)))
    : toWindowsPath(options.probePackage);
  const home = join(root, "dsh-home");
  const context = {
    root,
    home,
    workspace: join(root, "workspace 中文 space"),
    outside: join(root, "outside fixture 中文 space"),
    profile: `${label}-${process.pid}-${Date.now().toString(36)}`,
    probePackage,
    pluginTgz,
  };
  const host = assertWindowsCliAvailable();
  const wslVersion = wslHostVersion();
  context.host = {
    cliName: host.manifest.name,
    cliVersion: host.manifest.version,
    cliPackageSha256: sha256File(host.packagePath),
    pluginTgzSha256: sha256File(pluginTgzLocal),
    resolvedPluginTgz: {
      source: process.env.DSH_PLUGIN_TGZ ? "DSH_PLUGIN_TGZ" : "auto-discovered",
      relativePath: pluginTgzIsInsideProject
        ? pluginTgzRelative.replaceAll("\\", "/")
        : "<outside-project-root>",
    },
    nodeVersion: windowsNodeVersion(host.executable),
    hostPlatform: process.platform,
    hostArch: process.arch,
    wslVersion: wslVersion?.text,
    wslVersionEncoding: wslVersion?.encoding,
    wslVersionUtf16Detected: wslVersion?.utf16Detected,
    wslVersionHadBom: wslVersion?.hadBom,
    wslVersionByteLength: wslVersion?.byteLength,
  };
  const addArgs = ["plugin", "--profile", context.profile, "add", "--offline", "--ignore-scripts"];
  const pluginInstall = await runWindowsDsh({
    home,
    workspace: context.workspace,
    args: [...addArgs, pluginTgz],
  });
  requireSuccessfulCli(pluginInstall, "isolated plugin install");
  context.persistentTimeout = configureIsolatedPersistentTimeout(
    context,
    options.oneShotLimits,
  );
  const probeInstall = await runWindowsDsh({
    home,
    workspace: context.workspace,
    args: [...addArgs, probePackage],
  });
  requireSuccessfulCli(probeInstall, "isolated CLI probe install");
  const sourceDist = join(PROJECT_ROOT, "dist");
  const installedDist = join(profileDir(context), "node_modules", "dsh-plugin-bash-wsl", "dist");
  if (!existsSync(sourceDist) || !existsSync(installedDist)) {
    const error = new Error("source or installed plugin dist is missing for hash comparison");
    error.hostEvidence = context.host;
    throw error;
  }
  context.host.sourceDistSha256 = sha256Directory(sourceDist);
  context.host.installedDistSha256 = sha256Directory(installedDist);
  context.host.distHashesMatch = context.host.sourceDistSha256 === context.host.installedDistSha256;
  if (!context.host.distHashesMatch) {
    const error = new Error(`source/installed plugin dist hash mismatch: ${context.host.sourceDistSha256} !== ${context.host.installedDistSha256}`);
    error.hostEvidence = context.host;
    throw error;
  }
  const manifestPath = join(profileDir(context), "package.json");
  if (!existsSync(manifestPath)) throw new Error(`isolated profile manifest is missing: ${manifestPath}`);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const bundles = manifest.dsh?.profile?.bundles ?? [];
  for (const expected of ["dsh-plugin-bash-wsl", "dsh-cli-probe"]) {
    if (!bundles.includes(expected)) throw new Error(`profile did not activate bundle ${expected}`);
  }
  const sourceProbeIndex = join(toLocalPath(probePackage), "index.mjs");
  const installedProbeIndex = join(profileDir(context), "node_modules", "dsh-cli-probe", "index.mjs");
    const sourceProbeObserver = join(toLocalPath(probePackage), "windows-process-observer.mjs");
    const installedProbeObserver = join(profileDir(context), "node_modules", "dsh-cli-probe", "windows-process-observer.mjs");
  const probeSourceIndexSha256 = existsSync(sourceProbeIndex) ? sha256File(sourceProbeIndex) : null;
  const probeInstalledIndexSha256 = existsSync(installedProbeIndex) ? sha256File(installedProbeIndex) : null;
    const probeObserverRequired = existsSync(sourceProbeObserver);
    const probeSourceObserverSha256 = probeObserverRequired ? sha256File(sourceProbeObserver) : null;
    const probeInstalledObserverSha256 = probeObserverRequired && existsSync(installedProbeObserver)
      ? sha256File(installedProbeObserver)
      : null;
  context.host.probeSourceIndexSha256 = probeSourceIndexSha256;
  context.host.probeInstalledIndexSha256 = probeInstalledIndexSha256;
  context.host.probeIndexHashesMatch = probeSourceIndexSha256 !== null
    && probeSourceIndexSha256 === probeInstalledIndexSha256;
    context.host.probeObserverRequired = probeObserverRequired;
    context.host.probeSourceObserverSha256 = probeSourceObserverSha256;
    context.host.probeInstalledObserverSha256 = probeInstalledObserverSha256;
    context.host.probeObserverHashesMatch = !probeObserverRequired
      || (probeSourceObserverSha256 !== null
        && probeSourceObserverSha256 === probeInstalledObserverSha256);
  writeFileSync(join(root, "profile-install.json"), `${JSON.stringify({
    cliVersion: EXPECTED_CLI_VERSION,
    pluginVersion: EXPECTED_PLUGIN_VERSION,
    host: context.host,
    profile: context.profile,
    bundles,
    persistentTimeout: context.persistentTimeout,
  }, null, 2)}\n`);
    if (!context.host.probeIndexHashesMatch || !context.host.probeObserverHashesMatch) {
      const error = new Error(`source/installed CLI probe identity mismatch: ${JSON.stringify({
        index: [probeSourceIndexSha256, probeInstalledIndexSha256],
        observer: [probeSourceObserverSha256, probeInstalledObserverSha256],
      })}`);
    error.hostEvidence = context.host;
    throw error;
  }
  return context;
}

export async function dumpConfig(context) {
  return runWindowsDsh({
    home: context.home,
    workspace: context.workspace,
    args: ["--profile", context.profile, "--dump-config"],
  });
}

export async function runProbe(
  context,
  suite,
  mode,
  {
    processCwd = context.workspace,
    cliSuite = suite,
    persistentShell,
    nativeTimeoutOnly = false,
    caseFilter = process.env.DSH_PROBE_CASE_FILTER,
    caseDiagnostic,
    timeoutMs = 180_000,
  } = {},
) {
  return runWindowsDsh({
    home: context.home,
    workspace: context.workspace,
    processCwd,
    timeoutMs,
    args: ["--profile", context.profile, `--${cliSuite}`],
    env: {
      DSH_PROBE_SUITE: suite,
      DSH_PERMISSION_MODE: mode,
      ...(persistentShell === undefined
        ? {}
        : { DSH_PERSISTENT_SHELL: persistentShell }),
      ...(nativeTimeoutOnly ? { DSH_NATIVE_TIMEOUT_ONLY: "1" } : {}),
      ...(process.env.DSH_NATIVE_07_DIAGNOSTIC_ONLY === "1"
        ? { DSH_NATIVE_07_DIAGNOSTIC_ONLY: "1" }
        : {}),
      ...(caseFilter === undefined ? {} : { DSH_PROBE_CASE_FILTER: caseFilter }),
      ...(caseDiagnostic === undefined ? {} : { DSH_PROBE_CASE_DIAGNOSTIC: toWindowsPath(caseDiagnostic) }),
      DSH_PROBE_ROOT: toWindowsPath(context.root),
      DSH_PROBE_WORKSPACE: toWindowsPath(context.workspace),
      DSH_PROBE_HOST_CWD: toWindowsPath(processCwd),
      DSH_PROBE_OUTSIDE: toWindowsPath(context.outside),
      DSH_PROBE_PLUGIN_PATH: toWindowsPath(join(profileDir(context), "node_modules", "dsh-plugin-bash-wsl")),
      DSH_PROBE_PROFILE_MANIFEST: toWindowsPath(join(profileDir(context), "package.json")),
    },
  });
}

export function parseProbeResult(result) {
  const line = result.stdout
    .split(/\r?\n/)
    .reverse()
    .find((entry) => entry.startsWith("DSH_CLI_PROBE_RESULT "));
  if (line === undefined) return undefined;
  try {
    return JSON.parse(line.slice("DSH_CLI_PROBE_RESULT ".length));
  } catch {
    return undefined;
  }
}

export function writeEvidence(root, name, value) {
  mkdirSync(root, { recursive: true });
  const path = assertOwnedPath(RUN_ROOT, join(root, name));
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  return path;
}

export function readInstalledManifest(context, packageName) {
  const path = join(profileDir(context), "node_modules", ...packageName.split("/"), "package.json");
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined;
}
