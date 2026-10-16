#!/usr/bin/env node

/**
 * Durable Windows parent for run-owned-gui-session.mjs.
 *
 * The wrapper intentionally has no stdout pipe. The driver owns the Desktop
 * child stdout pipe for the lifetime of its own process, while this detached
 * parent exits only after Windows Node has accepted the driver spawn.
 */

import { randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

process.stdout.on("error", () => {});
process.stderr.on("error", () => {});

function selectWrapperMode(args = []) {
  if (!Array.isArray(args)) throw new Error("wrapper arguments must be an array");
  if (args.length === 0) return "real-turn";
  if (args.length !== 1) {
    throw new Error("wrapper arguments must contain at most one mode flag");
  }
  switch (args[0]) {
    case "--capability-only":
      return "capability-only";
    case "--preflight-only":
      return "preflight-only";
    default:
      throw new Error(`unknown wrapper mode flag: ${String(args[0])}`);
  }
}

const wrapperMode = selectWrapperMode(process.argv.slice(2));

const REPO_ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const TEST_ROOT = join(REPO_ROOT, "测试");
const RUN_ROOT = join(TEST_ROOT, "运行产物");
const DRIVER_PATH = fileURLToPath(new URL("./run-owned-gui-session.mjs", import.meta.url));
const safeAttemptId = (value) => {
  const text = String(value ?? "").replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return text.length > 0 ? text.slice(0, 64) : `attempt-${Date.now()}-${randomUUID().slice(0, 8)}`;
};
const attemptId = safeAttemptId(process.env.DSH_GUI_ATTEMPT_ID);
const resultArtifact = `gui-deepseek-real-session-20261011-${attemptId}.json`;
const observationArtifact = `gui-deepseek-real-session-observation-ready-20261011-${attemptId}.json`;
const LAUNCH_INFO_PATH = join(RUN_ROOT, `owned-gui-driver-launch-20261011-${attemptId}.json`);

if (process.platform !== "win32") {
  throw new Error("the durable owned GUI wrapper requires Windows Node");
}

const localAppData = process.env.LOCALAPPDATA;
if (typeof localAppData !== "string" || !isAbsolute(localAppData)) {
  throw new Error("LOCALAPPDATA must identify the Windows host runtime");
}
const appExe = join(localAppData, "Programs", "DeepSeek Harness", "DeepSeek Harness.exe");
const appAsar = join(dirname(appExe), "resources", "app.asar");
const wsModule = join(appAsar, "dsh", "node_modules", "ws", "wrapper.mjs");
if (!existsSync(appExe) || !existsSync(appAsar)) {
  throw new Error("installed Desktop Electron runtime is missing");
}

// Verify only the narrow asar/ws capability in Electron's Node mode before
// detaching the real driver. This does not create a BrowserWindow or Desktop GUI.
const capabilityScript = [
  "(async()=>{",
  "const value=await import(process.argv.at(-1));",
  "if(!value.default) throw new Error('ws default export missing');",
  "})().catch(error=>{process.stderr.write(String(error.message));process.exit(1)})",
].join("");
const capability = spawnSync(appExe, ["--expose-internals", "--eval", capabilityScript, pathToFileURL(wsModule).href], {
  cwd: REPO_ROOT,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", ELECTRON_NO_ATTACH_CONSOLE: "1" },
  windowsHide: true,
  shell: false,
  encoding: "utf8",
  timeout: 15_000,
  maxBuffer: 128 * 1024,
  stdio: ["ignore", "pipe", "pipe"],
});
if (capability.error !== undefined || capability.status !== 0) {
  throw new Error("installed Electron Node mode cannot import the rc.2 ws transport");
}
if (wrapperMode === "capability-only") process.exit(0);

mkdirSync(RUN_ROOT, { recursive: true });
const stderrFd = openSync(join(RUN_ROOT, "owned-gui-driver.stderr.log"), "a");
let child;
try {
  const driverArgs = ["--expose-internals", DRIVER_PATH];
  if (wrapperMode === "preflight-only") driverArgs.push("--preflight-only");
  child = spawn(appExe, driverArgs, {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      ELECTRON_NO_ATTACH_CONSOLE: "1",
      DSH_OWNED_DRIVER_WRAPPED: "1",
      DSH_GUI_ATTEMPT_ID: attemptId,
    },
    detached: true,
    windowsHide: true,
    shell: false,
    stdio: ["ignore", "ignore", stderrFd],
  });
} finally {
  closeSync(stderrFd);
}

child.once("error", (error) => {
  try { process.stderr.write(`owned GUI driver spawn failed: ${error.message}\n`); } catch {}
  process.exitCode = 1;
});
child.once("spawn", () => {
  try {
    writeFileSync(LAUNCH_INFO_PATH, `${JSON.stringify({
      schemaVersion: 1,
      status: "STARTED",
      attemptId,
      driverPid: child.pid,
      resultArtifact,
      observationArtifact,
    }, null, 2)}\n`, "utf8");
  } catch (error) {
    try { child.kill(); } catch {}
    try { process.stderr.write(`owned GUI launch record failed: ${error.message}\n`); } catch {}
    process.exitCode = 1;
    return;
  }
  child.unref();
});

export { selectWrapperMode };
