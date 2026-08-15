import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import type {
  SubprocessOutputReader,
  SubprocessRuntime,
} from "@deepseek-ai/dsh-subprocess";
import { BoundedCapture, type CapturedOutput, DEFAULT_MEMORY_LIMIT, DEFAULT_SPILL_LIMIT } from "./output.js";

export const DEFAULT_TIMEOUT_MS = 120_000;
export const MAX_TIMEOUT_MS = 600_000;

export type ProcessFailureKind =
  | "spawn-error"
  | "timeout"
  | "aborted"
  | "sandbox-denied"
  | "sandbox-unavailable"
  | "runner-failure"
  | "invalid-request";

export interface ProcessFailure {
  kind: ProcessFailureKind;
  message: string;
  code?: string | number;
}

export interface ForegroundProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  aborted: boolean;
  timeoutMs: number;
  stdout: CapturedOutput;
  stderr: CapturedOutput;
  failure?: ProcessFailure;
}

export interface SpawnRequest {
  executable: string;
  argv: readonly string[];
  cwd?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  timeoutMs?: number | undefined;
  signal?: AbortSignal | undefined;
  memoryLimit?: number | undefined;
  spillLimit?: number | undefined;
  spillDirectory?: string | undefined;
  spawnImpl?: typeof spawn | undefined;
}

/**
 * Run one bounded foreground command through DSH's rc.6 subprocess seam.
 *
 * The legacy `runForeground` helper remains available for pure process tests;
 * plugin executions use this adapter so child ownership, abort termination, and
 * collected output stay under `ctx.subprocess`.
 */
export interface SubprocessRequest extends Omit<SpawnRequest, "spawnImpl"> {
  subprocess: SubprocessRuntime;
}

export function validateTimeout(timeoutMs: number | undefined): number {
  const value = timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new Error(`invalid timeoutMs: expected a positive integer, got ${JSON.stringify(timeoutMs)}`);
  }
  if (value > MAX_TIMEOUT_MS) {
    throw new Error(`invalid timeoutMs: maximum is ${MAX_TIMEOUT_MS}ms`);
  }
  return value;
}

/**
 * Spawn one executable with an argv array.  `shell` is deliberately false and
 * never inferred from the command text.  This is the common process seam used
 * by both native tools.
 */
export async function runForeground(request: SpawnRequest): Promise<ForegroundProcessResult> {
  const timeoutMs = validateTimeout(request.timeoutMs);
  const stdoutCapture = new BoundedCapture({
    memoryLimit: request.memoryLimit ?? DEFAULT_MEMORY_LIMIT,
    spillLimit: request.spillLimit ?? DEFAULT_SPILL_LIMIT,
    spillDirectory: request.spillDirectory,
    streamName: "stdout",
  });
  const stderrCapture = new BoundedCapture({
    memoryLimit: request.memoryLimit ?? DEFAULT_MEMORY_LIMIT,
    spillLimit: request.spillLimit ?? DEFAULT_SPILL_LIMIT,
    spillDirectory: request.spillDirectory,
    streamName: "stderr",
  });

  let child: ChildProcess;
  try {
    const spawnFn = request.spawnImpl ?? spawn;
    child = spawnFn(request.executable, [...request.argv], {
      cwd: request.cwd,
      env: request.env,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    return {
      exitCode: null,
      signal: null,
      timedOut: false,
      aborted: false,
      timeoutMs,
      stdout: stdoutCapture.end(),
      stderr: stderrCapture.end(),
      failure: classifySpawnError(error),
    };
  }

  child.stdout?.on("data", (chunk: Buffer | string) => stdoutCapture.append(chunk));
  child.stderr?.on("data", (chunk: Buffer | string) => stderrCapture.append(chunk));

  let timedOut = false;
  let aborted = false;
  let settled = false;
  let closeCode: number | null = null;
  let closeSignal: NodeJS.Signals | null = null;
  let failure: ProcessFailure | undefined;

  const terminate = (reason: "timeout" | "aborted"): void => {
    if (settled) return;
    if (reason === "timeout") timedOut = true;
    else aborted = true;
    try {
      child.kill();
    } catch (error) {
      failure ??= {
        kind: "runner-failure",
        message: `failed to terminate child process: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  };

  const onAbort = (): void => terminate("aborted");
  if (request.signal?.aborted) onAbort();
  else request.signal?.addEventListener("abort", onAbort, { once: true });

  const timer = setTimeout(() => terminate("timeout"), timeoutMs);
  timer.unref?.();

  const onError = (error: Error & { code?: string | number }): void => {
    failure ??= classifySpawnError(error);
  };
  child.once("error", onError);
  child.once("close", (code: number | null, signal: NodeJS.Signals | null) => {
    closeCode = code;
    closeSignal = signal;
    settled = true;
  });

  if (!settled) await once(child, "close");
  clearTimeout(timer);
  request.signal?.removeEventListener("abort", onAbort);
  const stdout = stdoutCapture.end();
  const stderr = stderrCapture.end();

  if (timedOut) failure = { kind: "timeout", message: `process timed out after ${timeoutMs}ms` };
  else if (aborted) failure = { kind: "aborted", message: "process aborted" };

  return {
    exitCode: closeCode,
    signal: closeSignal,
    timedOut,
    aborted,
    timeoutMs,
    stdout,
    stderr,
    ...(failure === undefined ? {} : { failure }),
  };
}

/** Execute a fully specified command with the official rc.6 subprocess API. */
export async function runSubprocessForeground(
  request: SubprocessRequest,
): Promise<ForegroundProcessResult> {
  const timeoutMs = validateTimeout(request.timeoutMs);
  const memoryLimit = request.memoryLimit ?? DEFAULT_MEMORY_LIMIT;
  const spillLimit = request.spillLimit ?? DEFAULT_SPILL_LIMIT;
  const makeEmpty = (): CapturedOutput => ({
    text: "",
    truncated: false,
    spillBytes: 0,
    totalBytes: 0,
    overflowed: false,
  });

  if (request.signal?.aborted) {
    return {
      exitCode: null,
      signal: null,
      timedOut: false,
      aborted: true,
      timeoutMs,
      stdout: makeEmpty(),
      stderr: makeEmpty(),
      failure: { kind: "aborted", message: "process aborted" },
    };
  }

  const timeoutController = new AbortController();
  const signal = request.signal === undefined
    ? timeoutController.signal
    : AbortSignal.any([request.signal, timeoutController.signal]);
  const timer = setTimeout(() => timeoutController.abort(), timeoutMs);
  timer.unref?.();

  let handle: Awaited<ReturnType<SubprocessRuntime["spawn"]>> | undefined;
  let outcome: { exitCode: number | null; signal: NodeJS.Signals | null } = {
    exitCode: null,
    signal: null,
  };
  let failure: ProcessFailure | undefined;
  try {
    handle = request.subprocess.spawn({
      argv: [request.executable, ...request.argv],
      cwd: request.cwd ?? process.cwd(),
      stdio: {
        stdin: "ignore",
        stdout: { maxBytes: memoryLimit, spill: { maxBytes: spillLimit } },
        stderr: { maxBytes: memoryLimit, spill: { maxBytes: spillLimit } },
      },
      graceMs: 3_000,
      signal,
      ...(request.env === undefined ? {} : { env: request.env }),
    });
    try {
      outcome = await handle.done;
    } catch (error) {
      failure = classifySpawnError(error);
    }
  } catch (error) {
    failure = classifySpawnError(error);
  } finally {
    if (handle !== undefined) {
      try {
        await handle.waitForExit();
      } catch (error) {
        failure ??= classifySpawnError(error);
      }
    }
    clearTimeout(timer);
  }

  const readCollected = (
    reader: SubprocessOutputReader | undefined,
  ): CapturedOutput => {
    if (reader === undefined) return makeEmpty();
    const read = reader.readFrom(0);
    return {
      text: read.text,
      truncated: read.lossy,
      ...(read.spillPath === undefined ? {} : { spillPath: read.spillPath }),
      // rc.6 exposes the absolute stream cursor, not spill-byte accounting.
      // Keep the exact total when available and do not invent spill/overflow
      // figures from the visible tail.
      totalBytes: read.nextOffset,
    };
  };

  const timedOut = timeoutController.signal.aborted &&
    !(request.signal?.aborted ?? false);
  const aborted = request.signal?.aborted ?? false;
  if (timedOut) failure = { kind: "timeout", message: `process timed out after ${timeoutMs}ms` };
  else if (aborted) failure = { kind: "aborted", message: "process aborted" };

  return {
    exitCode: outcome.exitCode,
    signal: outcome.signal,
    timedOut,
    aborted,
    timeoutMs,
    stdout: readCollected(handle?.collected.stdout),
    stderr: readCollected(handle?.collected.stderr),
    ...(failure === undefined ? {} : { failure }),
  };
}

function classifySpawnError(error: unknown): ProcessFailure {
  const value = error as { code?: string | number; message?: string } | undefined;
  const code = value?.code;
  return {
    kind: "spawn-error",
    message: value?.message ?? String(error),
    ...(code === undefined ? {} : { code }),
  };
}
