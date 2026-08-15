#!/usr/bin/env node

/**
 * Real-WSL security regression for dsh-plugin-bash-wsl.
 *
 * Drives WslTerminalBackend directly (no Cordis host) and checks two facts
 * that unit tests cannot observe:
 *
 *   1. PTY geometry — `script` inherits no window size from a pipe, so the
 *      persistent shell's PTY must be resized to the configured rows/cols.
 *      A 0x0 PTY breaks pagers, `stty size`, and TUI width detection.
 *   2. WSL interop escape — a Windows .exe (cmd.exe) exec'd inside the
 *      restricted bwrap sandbox must FAIL. If it succeeded, the Windows
 *      process would access the native NTFS (C:\...) outside the Linux
 *      read-only bind and could write outside the workspace.
 *
 * The escape probe writes to C:\Windows\Temp with a fixed marker name and
 * removes it afterwards; a leftover marker means the sandbox leaked.
 *
 * Usage: node smoke/security-probe.mjs [--distro Ubuntu]
 */

import { execFileSync, spawn } from "node:child_process";
import { resolveConfig } from "../dist/config.js";
import { WslTerminalBackend } from "../dist/wsl/backend.js";

const args = process.argv.slice(2);
const distroIndex = args.indexOf("--distro");
const distro = distroIndex >= 0 && args[distroIndex + 1] ? args[distroIndex + 1] : "Ubuntu";

const WINDOWS_WORKSPACE = "C:\\Users\\dell\\Desktop\\dsh_bash";
const WSL_EXE = process.platform === "win32" ? "wsl.exe" : "/mnt/c/Windows/System32/wsl.exe";
const ESCAPE_MARKER_WIN = "C:\\Windows\\Temp\\dsh_plugin_escape_probe.txt";
const ESCAPE_MARKER_WSL = "/mnt/c/Windows/Temp/dsh_plugin_escape_probe.txt";

let failures = 0;
function fail(message) {
  failures += 1;
  console.error(`SECURITY FAIL: ${message}`);
}

/** Minimal structural ctx: only the seams the backend touches. */
function makeCtx() {
  return {
    subprocess: {
      spawn(spec) {
        const child = spawn(spec.argv[0], spec.argv.slice(1), {
          cwd: spec.cwd,
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
          env: { ...process.env, ...(spec.env ?? {}) },
          shell: false,
        });
        return {
          pid: child.pid,
          stdin: child.stdin,
          stdout: child.stdout,
          stderr: child.stderr,
          collected: {},
          done: new Promise((resolve, reject) => {
            child.once("error", reject);
            child.once("close", (code, signal) => resolve({ exitCode: code, signal }));
          }),
          terminate() {
            try {
              child.kill();
            } catch {}
          },
          async waitForExit() {
            return new Promise((resolve) => {
              const timer = setTimeout(() => resolve(false), 10_000);
              child.once("close", () => {
                clearTimeout(timer);
                resolve(true);
              });
            });
          },
        };
      },
    },
    terminals: {
      registerBackend() {},
      hasOwnerActivity() {
        return false;
      },
    },
    sandboxPolicy: {
      resolve() {
        return { mode: "workspace-write", workspaceRoot: WINDOWS_WORKSPACE };
      },
    },
  };
}

async function main() {
  try {
    execFileSync(WSL_EXE, ["-d", distro, "--", "true"], { stdio: "ignore" });
  } catch (error) {
    fail(`wsl.exe -d ${distro} unavailable: ${error.message}`);
    return;
  }
  try {
    execFileSync("rm", ["-f", ESCAPE_MARKER_WSL]);
  } catch {}

  const config = resolveConfig({
    distro,
    pollIntervalMs: 50,
    idleSilenceMs: 500,
    timeoutMs: 30_000,
  });
  const backend = new WslTerminalBackend(makeCtx(), config);
  const owner = {
    id: "security-probe",
    session: { header: { cwd: WINDOWS_WORKSPACE } },
    ctx: { on() {} },
  };

  let session;
  try {
    session = await backend.spawn({
      type: "wsl",
      sessionId: "security-1",
      owner,
      cwd: WINDOWS_WORKSPACE,
      signal: new AbortController().signal,
    });
  } catch (error) {
    fail(`session spawn failed: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  console.log(`security: spawned session pid=${session.pid}`);

  async function send(text) {
    const operation = session.startSend({ text, submit: true });
    const result = await operation.done;
    const read = session.read({ offset: 0, count: 500 });
    return `${result.viewport}\n${read.text}`;
  }

  // 1. PTY geometry must reflect the configured rows/cols (default 40x160).
  const sizeOutput = await send("stty size");
  const sizes = sizeOutput.trim().split("\n").filter((line) => /^\d+ \d+$/.test(line));
  const expected = `${config.rows} ${config.cols}`;
  if (sizes.some((line) => line === expected)) {
    console.log(`security: PTY geometry OK (${expected})`);
  } else {
    fail(`PTY geometry mismatch: expected "${expected}", observed ${JSON.stringify(sizes)}`);
  }

  // 2. WSL interop escape: cmd.exe must fail to run inside the sandbox.
  const escapeOutput = await send(`cmd.exe /c "echo ESCAPED > ${ESCAPE_MARKER_WIN}" ; echo exec_code=$?`);
  const execCode = /exec_code=(\d+)/.exec(escapeOutput)?.[1];
  const markerExists = fileExists(ESCAPE_MARKER_WSL);
  if (markerExists) {
    fail(`interop escape: marker written to ${ESCAPE_MARKER_WIN}`);
  } else if (execCode !== "1") {
    // cmd.exe may exit 0 while still failing (WSL bridge quirk); the
    // decisive fact is that no marker appears and no Windows output leaks.
    fail(`interop escape: cmd.exe reported exec_code=${execCode ?? "(none)"} and no marker — inspect manually`);
  } else {
    console.log("security: interop escape blocked (cmd.exe exec failed, no marker written)");
  }

  try {
    await session.close("security probe teardown");
  } catch (error) {
    fail(`teardown failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    execFileSync("rm", ["-f", ESCAPE_MARKER_WSL]);
  } catch {}
}

function fileExists(path) {
  try {
    execFileSync("test", ["-f", path]);
    return true;
  } catch {
    return false;
  }
}

await main();
if (failures > 0) {
  console.error(`SECURITY PROBE: ${failures} failure(s)`);
  process.exitCode = 1;
} else {
  console.log("SECURITY PROBE OK");
}
