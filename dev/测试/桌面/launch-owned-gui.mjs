#!/usr/bin/env node

/**
 * Start the already-authenticated owned Desktop fixture without inheriting a
 * short-lived terminal stdout/stderr pipe. This is a test launcher only.
 *
 * stdout uses child_process stdio "ignore" (the native null device): the
 * Desktop startup URL contains a short-lived bearer-like launch token and must
 * never be written to a test artifact or inherited from a parent pipe. stderr
 * goes to an owned, ignored log file. The child is detached and unref'ed after
 * Windows duplicates the stderr handle, so the launcher can exit without
 * closing the child's logging target.
 */

import { closeSync, existsSync, mkdirSync, openSync, realpathSync } from "node:fs";
import { spawn } from "node:child_process";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FIXTURE_ID,
  OWNED_ROOT,
  collectGuiSourceHashes,
  readDesktopRuntimeIdentity,
  resolveGuiCandidateBinding,
  sha256File,
} from "./gui-candidate-binding.mjs";

const REPO_ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const { asarSha256: EXPECTED_ASAR_SHA256, executableSha256: EXPECTED_EXE_SHA256 } = readDesktopRuntimeIdentity();
const RUN_ROOT = join(REPO_ROOT, "测试", "运行产物");

function installedDesktopPaths() {
  const localAppData = process.env.LOCALAPPDATA;
  if (typeof localAppData !== "string" || !isAbsolute(localAppData)) {
    throw new Error("LOCALAPPDATA must be an absolute Windows path");
  }
  const installRoot = join(localAppData, "Programs", "DeepSeek Harness");
  return {
    appExe: join(installRoot, "DeepSeek Harness.exe"),
    appAsar: join(installRoot, "resources", "app.asar"),
  };
}

function inside(parent, child) {
  const p = resolve(parent);
  const c = resolve(child);
  const prefix = p.endsWith("\\") ? p : `${p}\\`;
  return c === p || c.startsWith(prefix);
}

if (process.platform !== "win32") throw new Error("owned Desktop launcher requires Windows Node");
readDesktopRuntimeIdentity(process.env, { required: true });
const { appAsar: APP_ASAR, appExe: APP_EXE } = installedDesktopPaths();
if (!existsSync(APP_EXE) || !existsSync(APP_ASAR)) throw new Error("installed DeepSeek Harness runtime is missing");
if (!existsSync(OWNED_ROOT)) throw new Error("owned GUI fixture root is missing");
const runReal = realpathSync(RUN_ROOT);
const rootReal = realpathSync(OWNED_ROOT);
if (!inside(runReal, rootReal)) throw new Error("owned GUI root escaped 测试/运行产物");

const candidate = await resolveGuiCandidateBinding();
if ((await sha256File(APP_ASAR)) !== EXPECTED_ASAR_SHA256) throw new Error("installed Desktop app.asar identity changed");
if ((await sha256File(APP_EXE)) !== EXPECTED_EXE_SHA256) throw new Error("installed Desktop executable identity changed");
const sourceHashes = await collectGuiSourceHashes();

const dshHome = join(OWNED_ROOT, "dsh-home");
const userData = join(OWNED_ROOT, "electron-user-data");
const workspace = join(OWNED_ROOT, "workspace 中文 space");
for (const path of [dshHome, userData, workspace]) {
  if (!inside(rootReal, path)) throw new Error("owned launch path escaped fixture root");
}
const logDir = join(OWNED_ROOT, "logs");
mkdirSync(logDir, { recursive: true });
const stderrPath = join(logDir, "owned-gui-launch.stderr.log");

const stderrFd = openSync(stderrPath, "a");
const guiEnvironment = {
  ...process.env,
  DSH_HOME: dshHome,
  DSH_TELEMETRY_DISABLED: "1",
};
delete guiEnvironment.ELECTRON_RUN_AS_NODE;
delete guiEnvironment.ELECTRON_NO_ATTACH_CONSOLE;
let child;
try {
  child = spawn(APP_EXE, ["--user-data-dir", userData], {
    cwd: workspace,
    env: guiEnvironment,
    detached: true,
    windowsHide: false,
    stdio: ["ignore", "ignore", stderrFd],
    shell: false,
  });
  child.once("error", (error) => {
    process.stderr.write(`owned Desktop spawn failed: ${error.message}\n`);
    process.exitCode = 1;
  });
  child.unref();
} finally {
  // Windows has duplicated the stderr handle for the detached child at this
  // point; the launcher must not retain or close the child's copy on exit.
  closeSync(stderrFd);
}

console.log(JSON.stringify({
  schemaVersion: 1,
  started: true,
  pid: child.pid,
  fixture: FIXTURE_ID,
  runtime: "DeepSeek Harness Desktop 0.2.2-alpha.2",
  tgzSha256: candidate.tgzSha256,
  candidateBinding: {
    tgzRelativePath: candidate.tgzRelativePath,
    expectedSha256: candidate.expectedSha256,
    supplied: candidate.supplied,
    freshRequired: candidate.freshRequired,
    isCanonical: candidate.isCanonical,
    candidateIndependent: candidate.candidateIndependent,
  },
  sourceHashes,
  appAsarSha256: EXPECTED_ASAR_SHA256,
  stdout: "ignore",
  stderr: relative(OWNED_ROOT, stderrPath).replaceAll("\\", "/"),
  detached: true,
  unref: true,
  credentialsRead: false,
}));
