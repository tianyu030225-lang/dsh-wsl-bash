/** Private Node-mode child of the public Windows managed-Job subprocess seam. */
import type { IPty } from "node-pty";
import type { Duplex } from "node:stream";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { createDshHostRequire } from "../runtime.js";
import { readPtyControl, writePtyControl } from "./pty-control.js";

async function main(): Promise<void> {
  if (process.platform !== "win32" || process.argv[2] === undefined) {
    throw new Error("Git Bash PTY helper requires a Windows DSH host anchor");
  }
  const hostRequire = createDshHostRequire(process.argv[2]);
  const { openInheritedControlChannel } = await import(pathToFileURL(hostRequire.resolve("@deepseek-ai/dsh-subprocess/control")).href) as typeof import("@deepseek-ai/dsh-subprocess/control");
  const { scrubbedParentEnv } = await import(pathToFileURL(hostRequire.resolve("@deepseek-ai/dsh-subprocess")).href) as typeof import("@deepseek-ai/dsh-subprocess");
  const win32 = await import(pathToFileURL(hostRequire.resolve("@deepseek-ai/dsh-win32-process")).href) as typeof import("@deepseek-ai/dsh-win32-process");
  const api = win32.extendWin32ProcessBindings(({ kernel32, bind }) => ({
    openProcess: bind(kernel32, "OpenProcess", "void *", ["uint32", "int", "uint32"]) as (rights: number, inherit: number, pid: number) => import("@deepseek-ai/dsh-win32-process").NativePtr,
  }));
  const channel: Duplex = openInheritedControlChannel();
  let terminal: IPty | undefined;
  let started = false;
  let ending = false;
  let failing = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let poll: ReturnType<typeof setInterval> | undefined;
  let rootHandle: import("@deepseek-ai/dsh-win32-process").NativePtr | undefined;
  const fail = (): void => {
    if (failing) return;
    failing = true;
    ending = true;
    if (poll !== undefined) clearInterval(poll);
    if (timer !== undefined) clearTimeout(timer);
    process.stderr.write("Git Bash PTY helper transport or startup failed\n", () => process.exit(1));
  };
  const finish = async (exitCode: number): Promise<void> => {
    if (ending) return;
    ending = true;
    if (poll !== undefined) clearInterval(poll);
    if (timer !== undefined) clearTimeout(timer);
    if (rootHandle !== undefined) {
      win32.closeHandleChecked(api, rootHandle, "Git Bash PTY root observer");
      rootHandle = undefined;
    }
    await writePtyControl(channel, { kind: "exit", exitCode });
    // Flush already delivered PTY bytes, then let the provider close the entire Job.
    await new Promise<void>((resolve, reject) => process.stdout.write("", (error) => error ? reject(error) : resolve()));
    process.exit(0);
  };
  const dimension = (value: unknown): number => {
    if (!Number.isSafeInteger(value) || Number(value) <= 0 || Number(value) > 32_767) {
      throw new Error("Invalid Git Bash PTY dimension");
    }
    return Number(value);
  };
  const start = async (message: Record<string, unknown>): Promise<void> => {
    const argv = message.argv;
    if (started || !Array.isArray(argv) || argv.length !== 4 ||
      argv.some((arg) => typeof arg !== "string" || arg.includes("\0")) ||
      argv[1] !== "--noprofile" || argv[2] !== "--norc" || argv[3] !== "-i" ||
      typeof message.cwd !== "string" || message.cwd.includes("\0") ||
      typeof message.terminalType !== "string" || message.terminalType.includes("\0") ||
      typeof message.env !== "object" || message.env === null || Array.isArray(message.env)) {
      throw new Error("Invalid Git Bash PTY start request");
    }
    started = true;
    const rows = dimension(message.rows);
    const cols = dimension(message.cols);
    const env = { ...scrubbedParentEnv() };
    for (const [key, value] of Object.entries(message.env)) {
      if (key.includes("\0") || key.includes("=") || typeof value !== "string" || value.includes("\0")) {
        throw new Error("Invalid Git Bash PTY environment");
      }
      env[key] = value;
    }
    env.TERM = message.terminalType;
    env.HISTFILE = "/dev/null";
    // A non-inheritable kill-on-close Job precedes ConPTY allocation. OS exit
    // closes its last handle on normal exit, cancellation, or a host crash.
    const job = api.createJobObjectW(null, null);
    if (win32.isNullPtr(job)) throw new Error("Git Bash PTY Job could not be created");
    const limits = Buffer.alloc(144);
    limits.writeUInt32LE(0x2000, 16);
    if (api.setInformationJobObject(job, 9, limits, limits.length) === 0) {
      win32.closeHandleChecked(api, job, "Git Bash PTY unconfigured Job");
      throw new Error("Git Bash PTY kill-on-close Job could not be configured");
    }
    const self = api.openProcess(0x100 | 0x1, 0, process.pid);
    if (win32.isNullPtr(self)) {
      win32.closeHandleChecked(api, job, "Git Bash PTY unassigned Job");
      throw new Error("Git Bash PTY helper process could not be opened");
    }
    const assigned = api.assignProcessToJobObject(job, self);
    win32.closeHandleChecked(api, self, "Git Bash PTY helper process");
    if (assigned === 0) {
      win32.closeHandleChecked(api, job, "Git Bash PTY unassigned Job");
      throw new Error("Git Bash PTY helper Job assignment failed");
    }
    // Keep job open until process.exit; closing it explicitly kills us too.
    const pty = hostRequire(hostRequire.resolve("node-pty")) as typeof import("node-pty");
    terminal = pty.spawn(argv[0], argv.slice(1), { cwd: message.cwd, env, rows, cols, name: message.terminalType });
    const owned = terminal;
    let paused = false;
    owned.onData((data) => {
      if (!process.stdout.write(data, "utf8") && !paused) {
        paused = true;
        owned.pause();
        process.stdout.once("drain", () => { paused = false; if (!ending) owned.resume(); });
      }
    });
    owned.onExit(({ exitCode }) => { void finish(exitCode).catch(fail); });
    const until = Date.now() + 4_000;
    while (!ending && owned.pid <= 0 && Date.now() < until) await delay(10);
    if (ending || owned.pid <= 0) throw new Error("Git Bash PTY did not publish its Windows PID");
    rootHandle = api.openProcess(0x00100000 | 0x1000, 0, owned.pid);
    if (win32.isNullPtr(rootHandle)) throw new Error("Git Bash PTY root observer could not be opened");
    const exitSlot = win32.allocUint32();
    let rootExit: { at: number; exitCode: number } | undefined;
    // Prefer node-pty's queued-output drain. A continuous background writer
    // cannot keep the helper alive indefinitely after the retained root exits.
    poll = setInterval(() => {
      if (ending || rootHandle === undefined) return;
      const status = api.waitForSingleObject(rootHandle, 0);
      if (status === 0) {
        if (api.getExitCodeProcess(rootHandle, exitSlot) === 0) { fail(); return; }
        rootExit ??= { at: Date.now(), exitCode: win32.decodeUint32(exitSlot) | 0 };
        if (Date.now() - rootExit.at >= 250) void finish(rootExit.exitCode).catch(fail);
      } else if (status !== 258) fail();
    }, 25);
    if (timer !== undefined) clearTimeout(timer);
    await writePtyControl(channel, { kind: "ready", pid: owned.pid });
  };
  readPtyControl(channel, (message) => {
    if (message.kind === "start") {
      void start(message).catch(fail);
      return;
    }
    if (!terminal || !started || ending || !Number.isSafeInteger(message.id) || Number(message.id) <= 0) {
      throw new Error("Invalid Git Bash PTY request");
    }
    if (message.kind === "resize") terminal.resize(dimension(message.cols), dimension(message.rows));
    else if (message.kind === "interrupt") terminal.write("\x03");
    else throw new Error("Unsupported Git Bash PTY request");
    void writePtyControl(channel, { kind: "ack", id: message.id }).catch(fail);
  }, fail);
  channel.once("end", () => { if (!ending) fail(); });
  process.stdout.on("error", fail);
  timer = setTimeout(fail, 5_000);
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (text: string) => {
    if (!terminal || ending) { fail(); return; }
    try { terminal.write(text); } catch { fail(); }
  });
  process.stdin.on("error", fail);
  process.stdin.once("end", fail);
}

main().catch(() => {
  process.stderr.write("Git Bash PTY helper initialization failed\n", () => process.exit(1));
});
