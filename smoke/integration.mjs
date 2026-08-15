#!/usr/bin/env node

/**
 * Official-tool protocol integration smoke for dsh-plugin-bash-wsl.
 *
 * Drives WslTerminalBackend through the exact rc.6 protocol of
 * `@deepseek-ai/dsh-tool-bash-persistent`, without booting a full Cordis
 * host:
 *
 *   1. spawn the session and run the tool's initialization line
 *      (`stty -echo; PS1=__DSH_PERSISTENT_BASH_PROMPT__`);
 *   2. verify promptCompleted — the send viewport must end with the
 *      persistent prompt text;
 *   3. run one command via the marker wrapCommand protocol and parse the
 *      exit code from the END marker;
 *   4. run a second command proving cwd/export state persisted across calls;
 *   5. read scrollback and close the session.
 *
 * This is the closest real-WSL approximation of the plugin inside DSH.
 *
 * Usage: node smoke/integration.mjs [--distro Ubuntu]
 */

import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolveConfig } from "../dist/config.js";
import { WslTerminalBackend } from "../dist/wsl/backend.js";

const args = process.argv.slice(2);
const distroIndex = args.indexOf("--distro");
const distro = distroIndex >= 0 && args[distroIndex + 1] ? args[distroIndex + 1] : "Ubuntu";

const WINDOWS_WORKSPACE = "C:\\Users\\dell\\Desktop\\dsh_bash";
const WSL_EXE = process.platform === "win32" ? "wsl.exe" : "/mnt/c/Windows/System32/wsl.exe";

let failures = 0;
function fail(message) {
  failures += 1;
  console.error(`INTEGRATION FAIL: ${message}`);
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

// --- Official tool protocol mirror (dsh-tool-bash-persistent rc.6) ---
const SHELL_PROMPT = "__DSH_PERSISTENT_BASH_PROMPT__ ";
const SCROLLBACK_PAGE_LINES = 1_000;
const POLL_INTERVAL_MS = 25;

function quoteForBash(value) {
  return `$'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'").replaceAll("\r", "\\r").replaceAll("\n", "\\n")}'`;
}

function markers() {
  const nonce = randomUUID();
  return {
    start: `__DSH_PERSISTENT_BASH_START_${nonce}__`,
    end: `__DSH_PERSISTENT_BASH_END_${nonce}:`,
  };
}

function wrapCommand(command, marker) {
  return `printf '%s\\n' ${quoteForBash(marker.start)}; eval -- ${quoteForBash(command)}; __dsh_persistent_bash_status=$?; printf '%s%s\\n' ${quoteForBash(marker.end)} "$__dsh_persistent_bash_status"`;
}

function stripPrompt(text) {
  let result = text.replace(/\r?\n$/, "");
  while (result.endsWith(SHELL_PROMPT)) result = result.slice(0, -SHELL_PROMPT.length);
  return result.endsWith("\n") ? result.slice(0, -1) : result;
}

function commandOutput(snapshot, marker) {
  const text = snapshot.text;
  const end = text.lastIndexOf(marker.end);
  if (end < 0) return undefined;
  const status = /^(\d+)\r?\n/.exec(text.slice(end + marker.end.length))?.[1];
  if (status === undefined) return undefined;
  const startMarker = text.lastIndexOf(marker.start, end);
  const start = startMarker < 0 ? 0 : startMarker + marker.start.length;
  return {
    text: stripPrompt(text.slice(start, end).replace(/^\r?\n/, "")),
    incomplete: startMarker < 0,
    exitCode: Number(status),
  };
}

function promptCompleted(result) {
  return (
    result.viewport.endsWith(SHELL_PROMPT) ||
    result.viewport.endsWith(`${SHELL_PROMPT}\r\n`) ||
    result.viewport.endsWith(`${SHELL_PROMPT}\n`)
  );
}

function pause() {
  return new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
}

/** Minimal terminals registry over the backend session. */
class Registry {
  constructor(backend) {
    this.backend = backend;
    this.session = undefined;
  }
  async spawn(owner, request) {
    this.session = await this.backend.spawn({
      type: request.type,
      sessionId: "int-1",
      owner,
      ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
    });
    return { sessionId: "int-1", motd: this.session.motd, type: request.type, status: this.session.status() };
  }
  startSend(owner, id, request) {
    return this.session.startSend(request);
  }
  read(owner, id, request = {}) {
    return this.session.read(request);
  }
  async kill(owner, id, reason) {
    await this.session.close(reason);
  }
  list() {
    return [{ sessionId: "int-1", type: "wsl", status: this.session.status() }];
  }
}

async function retainedScrollback(reg, owner, id, latest) {
  const pages = latest.text.length === 0 ? [] : [latest.text];
  let offset = latest.lineEnd;
  let truncated = latest.truncated;
  while (offset < latest.totalLines) {
    const page = reg.read(owner, id, { offset, count: SCROLLBACK_PAGE_LINES });
    truncated ||= page.truncated;
    if (page.text.length > 0) pages.unshift(page.text);
    if (page.text.length === 0 || page.lineEnd <= offset || page.lineEnd >= page.totalLines) break;
    offset = page.lineEnd;
  }
  return { text: pages.join("\n"), truncated };
}

async function main() {
  try {
    execFileSync(WSL_EXE, ["-d", distro, "--", "true"], { stdio: "ignore" });
  } catch (error) {
    fail(`wsl.exe -d ${distro} unavailable: ${error.message}`);
    return;
  }

  const config = resolveConfig({ distro, pollIntervalMs: 50, idleSilenceMs: 500, timeoutMs: 30_000 });
  const backend = new WslTerminalBackend(makeCtx(), config);
  const owner = {
    id: "int-agent",
    session: { header: { cwd: WINDOWS_WORKSPACE } },
    ctx: { on() {} },
  };
  const reg = new Registry(backend);

  await reg.spawn(owner, { type: "wsl", cwd: WINDOWS_WORKSPACE });
  console.log("integration: session spawned");

  // Initialization exactly as the official tool does it.
  const initOp = reg.startSend(owner, "int-1", {
    text: `stty -echo; PS1=${quoteForBash(SHELL_PROMPT)}`,
    submit: true,
  });
  const initResult = await initOp.done;
  console.log(`integration: init waitReason=${initResult.waitReason} status=${JSON.stringify(initResult.sessionStatus)}`);
  if (initResult.sessionStatus.kind === "exited" || initResult.waitReason === "timeout") {
    fail(`shell did not accept initialization (${JSON.stringify(initResult)})`);
    return;
  }
  if (!promptCompleted(initResult)) {
    fail(`initialization viewport did not end with the persistent prompt: ${JSON.stringify(initResult.viewport.slice(-80))}`);
    return;
  }
  console.log("integration: promptCompleted(init)=true");

  async function executeCommand(command) {
    const marker = markers();
    const wrapped = wrapCommand(command, marker);
    let first = true;
    let fallback = "";
    let fallbackTruncated = false;
    for (let attempt = 0; attempt < 200; attempt++) {
      const operation = reg.startSend(owner, "int-1", { text: first ? wrapped : "", submit: first });
      first = false;
      const result = await operation.done;
      const incremental = operation.readOutput();
      fallback = incremental.delta.length > 0 ? fallback + incremental.delta : result.viewport;
      fallbackTruncated ||= incremental.truncated || result.truncated;
      const latest = reg.read(owner, "int-1", { offset: 0, count: SCROLLBACK_PAGE_LINES });
      if (latest.text.includes(marker.end)) {
        const complete = commandOutput(await retainedScrollback(reg, owner, "int-1", latest), marker);
        if (complete !== undefined) return complete;
      }
      if (result.sessionStatus.kind === "exited") {
        return { text: "", exitCode: null, sessionExited: true };
      }
      if (promptCompleted(result)) {
        return { text: stripPrompt(fallback.replaceAll(SHELL_PROMPT, "")), exitCode: undefined };
      }
      await pause();
    }
    fail(`command did not complete within attempt budget: ${JSON.stringify(command)}`);
    return { text: "", exitCode: undefined };
  }

  // Command 1: mutate shell state.
  const one = await executeCommand("export DSH_INT_VAR=kept; cd /tmp");
  console.log(`integration: cmd1 exitCode=${one.exitCode} text=${JSON.stringify(one.text)}`);
  if (one.exitCode !== 0) fail(`cmd1 exit code ${one.exitCode}`);

  // Command 2: prove persistence through the official protocol.
  const two = await executeCommand('printf \'var=%s pwd=%s\\n\' "$DSH_INT_VAR" "$PWD"');
  console.log(`integration: cmd2 exitCode=${two.exitCode} text=${JSON.stringify(two.text)}`);
  if (two.exitCode !== 0) fail(`cmd2 exit code ${two.exitCode}`);
  if (!two.text.includes("var=kept")) fail(`state did not persist: ${JSON.stringify(two.text)}`);
  if (!two.text.includes("/tmp")) fail(`cwd did not persist: ${JSON.stringify(two.text)}`);

  // Teardown.
  await reg.kill(owner, "int-1", "integration teardown");
  console.log("integration: session closed cleanly");
}

await main();
if (failures > 0) {
  console.error(`INTEGRATION: ${failures} failure(s)`);
  process.exitCode = 1;
} else {
  console.log("INTEGRATION OK");
}
