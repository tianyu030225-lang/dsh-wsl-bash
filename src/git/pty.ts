import type { Context } from "@deepseek-ai/cordis";
import type {
  SubprocessOutcome,
  SubprocessTerminalHandle,
  SubprocessTerminalSpawnSpec,
} from "@deepseek-ai/dsh-subprocess";
import { accessSync, constants } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createDshHostRequire } from "../runtime.js";
import { readPtyControl, writePtyControl } from "./pty-control.js";

const STARTUP_TIMEOUT_MS = 5_000;

/** Keep the ConPTY, its helper, Bash and all descendants in one Windows Job. */
export async function spawnGitBashPty(
  ctx: Context,
  request: SubprocessTerminalSpawnSpec,
  assertPermission: () => void,
): Promise<SubprocessTerminalHandle> {
  request.signal?.throwIfAborted();
  assertPermission();
  if (process.platform !== "win32") throw new Error("Native Git Bash PTY requires Windows");
  const hostRequire = createDshHostRequire(ctx.profileContext.installAnchor);
  const [local, win32] = await Promise.all([
    import(pathToFileURL(hostRequire.resolve("@deepseek-ai/dsh-subprocess-local")).href) as Promise<typeof import("@deepseek-ai/dsh-subprocess-local")>,
    import(pathToFileURL(hostRequire.resolve("@deepseek-ai/dsh-win32-process")).href) as Promise<typeof import("@deepseek-ai/dsh-win32-process")>,
  ]);
  // No direct-range fallback: this adapter depends on the local Job provider.
  if (!(ctx.subprocess instanceof local.LocalSubprocessRuntime)) {
    throw new Error("Native Git Bash PTY requires the Windows local managed-Job subprocess provider");
  }
  accessSync(hostRequire.resolve("@deepseek-ai/dsh-subprocess-local/runner"), constants.R_OK);
  accessSync(process.execPath, constants.X_OK);
  hostRequire.resolve("node-pty");
  win32.probeCurrentTokenJobSupport(win32.loadWin32ProcessBindings());
  request.signal?.throwIfAborted();
  assertPermission();
  const child = ctx.subprocess.spawn({
    argv: [process.execPath, fileURLToPath(new URL("./pty-helper.js", import.meta.url)), ctx.profileContext.installAnchor],
    cwd: request.cwd,
    env: { ELECTRON_RUN_AS_NODE: "1", NODE_OPTIONS: undefined, NODE_PATH: undefined },
    stdio: { stdin: "pipe", stdout: "pipe", stderr: { maxBytes: 4_096 }, control: "pipe" },
    graceMs: request.graceMs,
    // Allocation cancellation belongs to this adapter; it is not a lifetime signal.
  });
  child.done.catch(() => {});
  const control = child.control;
  const output = child.stdout;
  const input = child.stdin;
  let closing = false;
  let cleanup: Promise<void> | undefined;
  const pending = new Map<number, { resolve: () => void; reject: (error: Error) => void }>();
  let sequence = 0;
  let failure: Error | undefined;
  let shellOutcome: SubprocessOutcome | undefined;
  let readyPid: number | undefined;
  let resolveReady: ((pid: number) => void) | undefined;
  let rejectReady: ((error: unknown) => void) | undefined;
  const ready = new Promise<number>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  ready.catch(() => {});
  let finishControl: (() => void) | undefined;
  const controlFinished = new Promise<void>((resolve) => { finishControl = resolve; });
  const rejectPending = (error: Error): void => {
    for (const operation of pending.values()) operation.reject(error);
    pending.clear();
  };
  const terminate = (): Promise<void> => {
    if (cleanup !== undefined) return cleanup;
    closing = true;
    rejectPending(new Error("Git Bash PTY is closing"));
    cleanup = (async () => {
      child.terminate();
      if (!await child.waitForExit()) throw new Error("Git Bash PTY managed Job did not become empty");
      await child.done;
    })();
    cleanup.catch(() => {});
    return cleanup;
  };
  const fail = (error: Error): void => {
    if (closing && failure === undefined) return;
    failure ??= error;
    rejectReady?.(failure);
    rejectPending(failure);
    void terminate();
  };
  let stopControl: (() => void) | undefined;
  const done = child.done.then(async (outcome): Promise<SubprocessOutcome> => {
    closing = true;
    rejectReady?.(failure ?? new Error("Git Bash PTY helper exited during startup"));
    rejectPending(failure ?? new Error("Git Bash PTY has exited"));
    if (!await child.waitForExit()) throw new Error("Git Bash PTY managed Job did not become empty");
    if (cleanup === undefined && shellOutcome === undefined && failure === undefined) {
      // Ordinary child.done does not drain the independent control pipe. Allow
      // its final exit packet to arrive, but never wait indefinitely for it.
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([controlFinished, new Promise<void>((resolve) => {
          timer = setTimeout(resolve, request.graceMs);
        })]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    }
    if (failure !== undefined) throw failure;
    if (cleanup === undefined && shellOutcome === undefined) {
      throw new Error("Git Bash PTY helper exited without a shell outcome");
    }
    return shellOutcome ?? outcome;
  }, async (error: unknown): Promise<SubprocessOutcome> => {
    failure ??= error instanceof Error ? error : new Error("Git Bash PTY subprocess failed");
    rejectReady?.(failure);
    rejectPending(failure);
    try { await terminate(); } catch { /* Preserve the original transport failure. */ }
    throw failure;
  });
  done.catch(() => {});
  if (control === undefined || output === undefined || input === undefined) {
    await terminate();
    throw new Error("Git Bash PTY managed subprocess did not expose its required pipes");
  }
  const onControlEnd = (): void => {
    finishControl?.();
    if (!closing && shellOutcome === undefined) fail(new Error("Git Bash PTY control channel ended unexpectedly"));
  };
  control.once("end", onControlEnd);
  input.on("error", fail);
  stopControl = readPtyControl(control, (message) => {
    if (closing && (cleanup !== undefined || message.kind !== "exit")) return;
    if (message.kind === "ready") {
      if (readyPid !== undefined || !Number.isSafeInteger(message.pid) || Number(message.pid) <= 0) {
        throw new Error("Invalid Git Bash PTY readiness packet");
      }
      readyPid = Number(message.pid);
      resolveReady?.(readyPid);
    } else if (message.kind === "ack") {
      if (!Number.isSafeInteger(message.id) || !pending.has(Number(message.id))) {
        throw new Error("Unexpected Git Bash PTY acknowledgement");
      }
      const operation = pending.get(Number(message.id))!;
      pending.delete(Number(message.id));
      operation.resolve();
    } else if (message.kind === "exit") {
      if (shellOutcome !== undefined || !Number.isSafeInteger(message.exitCode)) {
        failure ??= new Error("Invalid Git Bash PTY exit packet");
        throw failure;
      }
      shellOutcome = { exitCode: Number(message.exitCode), signal: null };
      finishControl?.();
    } else {
      throw new Error("Unexpected Git Bash PTY control packet");
    }
  }, fail);
  const onAbort = (): void => fail(new Error("Git Bash PTY allocation aborted", { cause: request.signal?.reason }));
  request.signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => fail(new Error("Git Bash PTY allocation timed out")), STARTUP_TIMEOUT_MS);
  try {
    request.signal?.throwIfAborted();
    assertPermission();
    await writePtyControl(control, { kind: "start", argv: request.argv, cwd: request.cwd, env: request.env ?? {}, rows: request.rows, cols: request.cols, terminalType: request.terminalType });
    const pid = await ready;
    request.signal?.throwIfAborted();
    if (failure !== undefined) throw failure;
    const rpc = (message: object): Promise<void> => {
      if (closing) return Promise.reject(new Error("Git Bash PTY has exited"));
      if (pending.size >= 32) return Promise.reject(new Error("Too many pending Git Bash PTY control requests"));
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        writePtyControl(control, { ...message, id }).catch((error: Error) => fail(error));
      });
    };
    return {
      pid, output, done,
      write: (data) => new Promise<void>((resolve, reject) => {
        if (closing) { reject(new Error("Git Bash PTY has exited")); return; }
        input.write(data, "utf8", (error) => error ? reject(error) : resolve());
      }),
      resize: (cols, rows) => rpc({ kind: "resize", cols, rows }),
      // Windows uses the shell PID as a stable pseudo-group, not a POSIX PGID.
      inspectForeground: async () => closing ? undefined : { processGroupId: pid, inputWaiting: false },
      inspectActivity: async () => ({ state: closing && await child.waitForExit() ? "idle" : "unknown", revision: closing ? 1 : 0 }),
      signalForeground: async (signal) => {
        if (closing) throw new Error("Git Bash PTY has exited");
        if (signal === "SIGTERM") await terminate();
        else if (signal === "SIGINT") await rpc({ kind: "interrupt" });
        else throw new Error(`signal ${signal} is unsupported for the native Git Bash PTY; close the session to terminate its Job`);
        return pid;
      },
      terminate,
    };
  } catch (error) {
    try { await terminate(); } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Git Bash PTY startup and cleanup failed");
    }
    request.signal?.throwIfAborted();
    throw error;
  } finally {
    clearTimeout(timer);
    request.signal?.removeEventListener("abort", onAbort);
    done.finally(() => {
      stopControl?.();
      control.off("end", onControlEnd);
      input.off("error", fail);
    }).catch(() => {});
  }
}
