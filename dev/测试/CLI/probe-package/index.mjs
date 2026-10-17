import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  appendFileSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, win32 } from "node:path";
import { createRequire } from "node:module";
import {
  buildProcessDetailsScript,
  buildProcessSnapshotScript,
  buildProcessTree,
  matchProcessIdentities,
  mergeProcessDetails,
  parseProcessRows,
} from "./windows-process-observer.mjs";

const PROBE_ROOT = process.env.DSH_PROBE_ROOT ?? process.cwd();
const WORKSPACE = process.env.DSH_PROBE_WORKSPACE ?? process.cwd();
const OUTSIDE = process.env.DSH_PROBE_OUTSIDE ?? join(dirname(WORKSPACE), "outside fixture 中文 space");
const MODE = process.env.DSH_PERMISSION_MODE ?? "workspace-write";
const SUITE = process.env.DSH_PROBE_SUITE ?? "integration";
const PERSISTENT_SHELL = process.env.DSH_PERSISTENT_SHELL ?? "wsl";
const NATIVE_TIMEOUT_ONLY = process.env.DSH_NATIVE_TIMEOUT_ONLY === "1";
const NATIVE_07_DIAGNOSTIC_ONLY = process.env.DSH_NATIVE_07_DIAGNOSTIC_ONLY === "1";
const NATIVE_07_PUBLIC_READS = !NATIVE_07_DIAGNOSTIC_ONLY
  || process.env.DSH_NATIVE_07_PUBLIC_READS === "1";
const CASE_FILTER = process.env.DSH_PROBE_CASE_FILTER === undefined
  ? undefined
  : new Set(process.env.DSH_PROBE_CASE_FILTER.split(",").map((value) => value.trim()).filter(Boolean));
const CASE_DIAGNOSTIC_PATH = process.env.DSH_PROBE_CASE_DIAGNOSTIC
  ?? join(PROBE_ROOT, `case-diagnostics-${SUITE}-${MODE}-${PERSISTENT_SHELL}.jsonl`);

function appendCaseDiagnostic(event, fields = {}) {
  try {
    appendFileSync(CASE_DIAGNOSTIC_PATH, `${JSON.stringify({
      at: new Date().toISOString(),
      pid: process.pid,
      suite: SUITE,
      mode: MODE,
      persistentShell: PERSISTENT_SHELL,
      event,
      ...fields,
    })}\n`, "utf8");
  } catch {
    // Diagnostic logging must never change the production-facing probe result.
  }
}

function shouldRunCase(id) {
  if (CASE_FILTER === undefined) return true;
  return [...CASE_FILTER].some((filter) => id === filter || id.startsWith(filter));
}

class CaseSkip extends Error {
  constructor(message) {
    super(message);
    this.name = "CaseSkip";
  }
}

function sanitized(value) {
  return String(value ?? "")
    .replaceAll(PROBE_ROOT, "<test-root>")
    .replaceAll(WORKSPACE, "<workspace>")
    .replaceAll(OUTSIDE, "<outside-fixture>")
    .replace(/[\r\n]+/g, " ")
    .slice(-4000);
}

function wslPath(value) {
  const match = /^([A-Za-z]):[\\/](.*)$/s.exec(value);
  if (match?.[1] === undefined || match[2] === undefined) {
    throw new Error(`cannot map Windows path to WSL: ${JSON.stringify(value)}`);
  }
  return `/mnt/${match[1].toLowerCase()}/${match[2].replaceAll("\\", "/")}`;
}

function gitBashWindowsPath(value) {
  const match = /^([A-Za-z]):[\\/](.*)$/s.exec(value);
  if (match?.[1] === undefined || match[2] === undefined) {
    throw new Error(`cannot map Windows path to Git Bash: ${JSON.stringify(value)}`);
  }
  return `${match[1].toUpperCase()}:/${match[2].replaceAll("\\", "/")}`;
}

function normalizeGitBashWindowsPath(value) {
  const trimmed = String(value ?? "").trim();
  if (!/^[A-Za-z]:[\\/]/.test(trimmed)) return null;
  return win32.normalize(trimmed.replaceAll("/", "\\")).toLowerCase();
}

function parseGitBashPwdW(output) {
  const beginMarker = "__DSH_GIT_PWD_W_BEGIN__";
  const endMarker = "__DSH_GIT_PWD_W_END__";
  const begin = output.indexOf(beginMarker);
  const end = begin < 0 ? -1 : output.indexOf(endMarker, begin + beginMarker.length);
  if (begin < 0 || end < 0) return [];
  const body = output.slice(begin + beginMarker.length, end);
  return body
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter((value) => /^[A-Za-z]:[\\/]/.test(value))
    .map((value) => ({ raw: value, normalized: normalizeGitBashWindowsPath(value) }))
    .filter((value) => value.normalized !== null);
}

function bashQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function shellPath(value) {
  return PERSISTENT_SHELL === "git-bash" ? gitBashWindowsPath(value) : wslPath(value);
}

function authorizePersistentShell(agent) {
  if (PERSISTENT_SHELL === "git-bash") {
    agent.session.append("sandbox/mode", { mode: "danger-full-access" });
  }
}

function appendUtf8RollingTail(current, chunk, limit = 64 * 1024) {
  if (limit <= 0) return "";
  const previous = Buffer.from(String(current ?? ""), "utf8");
  const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk ?? ""), "utf8");
  const merged = next.length >= limit
    ? next.subarray(next.length - limit)
    : Buffer.concat([previous.subarray(Math.max(0, previous.length - (limit - next.length))), next]);
  let start = 0;
  while (start < merged.length && (merged[start] & 0xc0) === 0x80) start += 1;
  return merged.subarray(start).toString("utf8");
}

function persistentEndFrames(value) {
  return [...String(value ?? "").matchAll(/__DSH_PERSISTENT_BASH_END_[0-9a-f-]+:\d+/gi)]
    .map((match) => match[0])
    .filter((frame, index, frames) => frames.indexOf(frame) === index)
    .slice(0, 8);
}

function instrumentPublicStdout(handle) {
  const stream = handle?.stdout;
  const state = {
    available: stream !== undefined
      && typeof stream.pause === "function"
      && typeof stream.resume === "function",
    pauseCalls: 0,
    resumeCalls: 0,
    error: null,
    sampleBytes: 0,
    sampleHead: "",
    sampleTail: "",
    sampleFrameSearch: "",
    sampleWindow: "",
    rollingTail: "",
    sampleEndFrames: [],
    snapshot() {
      return {
        available: this.available,
        pauseCalls: this.pauseCalls,
        resumeCalls: this.resumeCalls,
        error: this.error,
        totalBytes: this.sampleBytes,
        sampleBytes: this.sampleBytes,
        sampleHead: sanitized(this.sampleHead),
        sampleTail: sanitized(this.sampleTail),
        sampleWindowBytes: Buffer.byteLength(this.sampleWindow),
        sampleWindowEndFrames: persistentEndFrames(this.sampleWindow),
        sampleWindowTrace: terminalFrameTrace(this.sampleWindow),
        sampleTailTrace: terminalFrameTrace(this.sampleTail),
        rollingTailBytes: Buffer.byteLength(this.rollingTail),
        streamTraceSource: "rolling-tail-64KiB",
        streamTrace: terminalFrameTrace(this.rollingTail),
        sampleEndFrames: this.sampleEndFrames,
      };
    },
    restore() {},
  };
  if (!state.available) return state;
  const originalPause = stream.pause;
  const originalResume = stream.resume;
  const originalEmit = stream.emit;
  try {
    stream.pause = function observedStdoutPause(...args) {
      state.pauseCalls += 1;
      appendCaseDiagnostic("subprocess.stdout.pause", { pauseCalls: state.pauseCalls });
      return originalPause.apply(this, args);
    };
    stream.resume = function observedStdoutResume(...args) {
      state.resumeCalls += 1;
      appendCaseDiagnostic("subprocess.stdout.resume", { resumeCalls: state.resumeCalls });
      return originalResume.apply(this, args);
    };
    stream.emit = function observedStdoutEmit(event, ...args) {
      if (event === "data") {
        const text = Buffer.isBuffer(args[0]) ? args[0].toString("utf8") : String(args[0] ?? "");
        state.sampleBytes += Buffer.byteLength(text);
        if (state.sampleHead.length < 4_096) state.sampleHead += text.slice(0, 4_096 - state.sampleHead.length);
        state.sampleTail = `${state.sampleTail}${text}`.slice(-4_096);
        state.rollingTail = appendUtf8RollingTail(state.rollingTail, text);
        const remainingWindowBytes = 65_536 - Buffer.byteLength(state.sampleWindow);
        if (remainingWindowBytes > 0) {
          state.sampleWindow += Buffer.from(text).subarray(0, remainingWindowBytes).toString("utf8");
        }
        const frameText = `${state.sampleFrameSearch}${text}`;
        state.sampleFrameSearch = frameText.slice(-256);
        const frames = persistentEndFrames(frameText);
        state.sampleEndFrames = frames.filter((frame, index) => frames.indexOf(frame) === index).slice(0, 8);
      }
      return originalEmit.call(this, event, ...args);
    };
    state.restore = () => {
      stream.pause = originalPause;
      stream.resume = originalResume;
      stream.emit = originalEmit;
    };
  } catch (error) {
    state.error = sanitized(error);
  }
  return state;
}

function observeNativeSpawner(ctx) {
  const subprocess = ctx.get("subprocess");
  assert(typeof subprocess?.spawn === "function",
    "official subprocess spawn API is unavailable for native Git Bash helper");
  const original = subprocess.spawn;
  const calls = [];
  subprocess.spawn = function observedNativeSpawn(spec) {
    appendCaseDiagnostic("subprocess.spawn.begin", {
      argv: [...spec.argv].map((value) => sanitized(value)),
      cwd: sanitized(spec.cwd),
      stdio: spec.stdio,
    });
    let handle;
    try {
      handle = original.call(this, spec);
    } catch (error) {
      appendCaseDiagnostic("subprocess.spawn.throw", { error: sanitized(error) });
      throw error;
    }
    const stdoutFlow = instrumentPublicStdout(handle);
    calls.push({ argv: [...spec.argv], cwd: spec.cwd, stdio: spec.stdio, env: spec.env, handle, stdoutFlow });
    appendCaseDiagnostic("subprocess.spawn.return", {
      argv: [...spec.argv].map((value) => sanitized(value)),
      capabilities: {
        hasDone: handle?.done !== undefined,
        hasWaitForExit: typeof handle?.waitForExit === "function",
        hasTerminate: typeof handle?.terminate === "function",
        hasControl: handle?.control !== undefined,
        hasCollected: handle?.collected !== undefined,
        hasCollectedStderr: typeof handle?.collected?.stderr?.readFrom === "function",
        hasStderr: handle?.stderr !== undefined,
      },
    });
    if (handle?.done !== undefined && typeof handle.done?.then === "function") {
      Promise.resolve(handle.done).then(
        (outcome) => appendCaseDiagnostic("subprocess.done.fulfilled", {
          exitCode: outcome?.exitCode ?? null,
          signal: outcome?.signal ?? null,
          timedOut: outcome?.timedOut === true,
        }),
        (error) => appendCaseDiagnostic("subprocess.done.rejected", { error: sanitized(error) }),
      ).catch(() => {});
    }
    return handle;
  };
  return {
    calls,
    restore() {
      for (const call of calls) call.stdoutFlow?.restore();
      subprocess.spawn = original;
    },
  };
}

function isWslPersistentSubprocessSpec(spec) {
  const argv = Array.isArray(spec?.argv) ? spec.argv.map((value) => String(value)) : [];
  const hasWslLauncher = argv.some((value) => {
    const normalized = value.replaceAll("\\", "/");
    const basename = normalized.slice(normalized.lastIndexOf("/") + 1);
    return /^wsl(?:\.exe)?$/i.test(basename);
  });
  const hasBwrap = argv.some((value) => /(?:^|[\\/])bwrap$/i.test(value));
  return hasWslLauncher && hasBwrap;
}

/**
 * Observe the public ordinary managed subprocess seam used by the WSL PTY.
 * This deliberately records no Windows PID: WSL's public terminal session
 * does not expose a Linux foreground group or a valid Windows process identity
 * for model-facing assertions.  The argv shape distinguishes the persistent
 * bwrap terminal from the short-lived WSL path probes performed during setup.
 */
function observeWslManagedSubprocesses(ctx) {
  const subprocess = ctx.get("subprocess");
  assert(typeof subprocess?.spawn === "function",
    "official subprocess spawn API is unavailable for WSL managed-session observation");
  const original = subprocess.spawn;
  const calls = [];
  subprocess.spawn = function observedWslManagedSpawn(spec) {
    const startedAt = Date.now();
    let handle;
    try {
      handle = original.call(this, spec);
    } catch (error) {
      appendCaseDiagnostic("wsl.subprocess.spawn.throw", { error: sanitized(error) });
      throw error;
    }
    const stdoutFlow = instrumentPublicStdout(handle);
    const call = {
      index: calls.length,
      argv: Array.isArray(spec?.argv) ? [...spec.argv] : [],
      cwd: spec?.cwd,
      stdio: spec?.stdio,
      handle,
      persistentTerminal: isWslPersistentSubprocessSpec(spec),
      startedAt,
      done: null,
      doneError: null,
      stdoutFlow,
    };
    calls.push(call);
    appendCaseDiagnostic("wsl.subprocess.spawn.return", {
      index: call.index,
      persistentTerminal: call.persistentTerminal,
      argv: call.argv.map((value) => sanitized(value)),
      cwd: sanitized(call.cwd),
      capabilities: publicSubprocessHandleSnapshot(handle, stdoutFlow),
    });
    if (handle?.done !== undefined && typeof handle.done?.then === "function") {
      Promise.resolve(handle.done).then(
        (outcome) => {
          call.done = {
            elapsedMs: Date.now() - startedAt,
            exitCode: outcome?.exitCode ?? null,
            signal: outcome?.signal ?? null,
            timedOut: outcome?.timedOut === true,
          };
          appendCaseDiagnostic("wsl.subprocess.done.fulfilled", {
            index: call.index,
            persistentTerminal: call.persistentTerminal,
            done: call.done,
          });
        },
        (error) => {
          call.doneError = sanitized(error);
          appendCaseDiagnostic("wsl.subprocess.done.rejected", {
            index: call.index,
            persistentTerminal: call.persistentTerminal,
            error: call.doneError,
          });
        },
      ).catch(() => {});
    }
    return handle;
  };
  return {
    calls,
    persistentCalls() {
      return calls.filter((call) => call.persistentTerminal);
    },
    restore() {
      for (const call of calls) call.stdoutFlow?.restore();
      subprocess.spawn = original;
    },
  };
}

async function settleObservedWslManagedHandles(observation, label) {
  const calls = observation?.persistentCalls?.() ?? [];
  assert(calls.length > 0, `WSL ${label} did not expose a persistent managed subprocess`);
  const settlements = [];
  for (const call of calls) {
    assert(typeof call.handle?.waitForExit === "function",
      `WSL ${label} managed subprocess ${call.index} did not expose waitForExit`);
    let waitForExit;
    let waitError;
    try {
      waitForExit = await call.handle.waitForExit();
    } catch (error) {
      waitError = sanitized(error);
    }
    let done;
    let doneError;
    try {
      done = await call.handle.done;
    } catch (error) {
      doneError = sanitized(error);
    }
    const settlement = {
      index: call.index,
      waitForExit,
      waitError: waitError ?? null,
      done: done === undefined ? null : {
        exitCode: done?.exitCode ?? null,
        signal: done?.signal ?? null,
        timedOut: done?.timedOut === true,
      },
      doneError: doneError ?? null,
    };
    settlements.push(settlement);
    assert(waitError === undefined && waitForExit === true && doneError === undefined,
      `WSL ${label} managed subprocess ${call.index} did not settle cleanly: ${sanitized(JSON.stringify(settlement))}`);
  }
  return settlements;
}

function publicWslSessionEvidence(observation) {
  return (observation?.calls ?? [])
    .filter((call) => call?.type === "wsl")
    .map((call) => ({
      type: "wsl",
      sessionId: call.sessionId,
      cwd: sanitized(call.cwd),
      ...(call.pid === null || call.pid === undefined ? {} : { pid: call.pid }),
      startedAt: call.startedAt,
      publishedAt: call.publishedAt ?? null,
      ...(call.error === undefined ? {} : { error: call.error }),
    }));
}

function windowsProcess(pid) {
  if (process.platform !== "win32" || !Number.isSafeInteger(Number(pid)) || Number(pid) <= 0) return undefined;
  const script = `$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${Number(pid)}'; if ($null -eq $p) { exit 3 }; $p | Select-Object ProcessId,ParentProcessId,CreationDate,Name,ExecutablePath,CommandLine | ConvertTo-Json -Compress`;
  try {
    const text = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8",
      timeout: 2_000,
      maxBuffer: 512 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    return text.length === 0 ? undefined : JSON.parse(text);
  } catch (error) {
    if (Number(error?.status) === 3) return undefined;
    const detail = `Windows CIM process query failed for pid=${pid}: status=${String(error?.status ?? "unknown")} ` +
      `code=${String(error?.code ?? "unknown")} stderr=${sanitized(error?.stderr)} stdout=${sanitized(error?.stdout)}`;
    appendCaseDiagnostic("cim.error", { operation: "process", pid: Number(pid), detail });
    throw new Error(detail, { cause: error });
  }
}

function windowsProcessSnapshot() {
  const script = buildProcessSnapshotScript();
  try {
    const text = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8",
      timeout: 2_000,
      maxBuffer: 512 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return parseProcessRows(text, "Windows CIM process snapshot");
  } catch (error) {
    const detail = `Windows CIM process snapshot failed: status=${String(error?.status ?? "unknown")} ` +
      `code=${String(error?.code ?? "unknown")} stderr=${sanitized(error?.stderr)} stdout=${sanitized(error?.stdout)}`;
    appendCaseDiagnostic("cim.error", { operation: "snapshot", detail });
    throw new Error(detail, { cause: error });
  }
}

function windowsProcessDetails(pids, label) {
  const ids = [...new Set((Array.isArray(pids) ? pids : []).map((pid) => Number(pid)))];
  if (ids.length === 0) return [];
  const script = buildProcessDetailsScript(ids);
  try {
    const text = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8",
      timeout: 2_000,
      maxBuffer: 512 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return text.trim().length === 0 ? [] : parseProcessRows(text, label);
  } catch (error) {
    const detail = `Windows CIM process details failed for ${label}: status=${String(error?.status ?? "unknown")} ` +
      `code=${String(error?.code ?? "unknown")} stderr=${sanitized(error?.stderr)} stdout=${sanitized(error?.stdout)}`;
    appendCaseDiagnostic("cim.error", { operation: "details", pids: ids, detail });
    throw new Error(detail, { cause: error });
  }
}

function windowsDescendants(pid, snapshot = undefined) {
  const rows = snapshot ?? windowsProcessSnapshot();
  try {
    return buildProcessTree(rows, pid);
  } catch (error) {
    const detail = `Windows CIM process tree failed for root pid=${pid}: ${sanitized(error)}`;
    appendCaseDiagnostic("cim.error", { operation: "tree", pid: Number(pid), detail });
    throw new Error(detail, { cause: error });
  }
}

function hydrateWindowsRows(rows, label) {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  const details = windowsProcessDetails(rows.map((row) => row.ProcessId), label);
  try {
    return mergeProcessDetails(rows, details, label);
  } catch (error) {
    const detail = `Windows CIM candidate identity failed for ${label}: ${sanitized(error)}`;
    appendCaseDiagnostic("cim.error", { operation: "identity", label, detail });
    throw new Error(detail, { cause: error });
  }
}

function windowsLineage(pid, stopWhen = undefined) {
  const lineage = [];
  const seen = new Set();
  let current = Number(pid);
  while (Number.isSafeInteger(current) && current > 0 && !seen.has(current) && lineage.length < 16) {
    seen.add(current);
    const row = windowsProcess(current);
    if (row === undefined) break;
    lineage.push(row);
    if (stopWhen?.(row) === true) break;
    current = Number(row.ParentProcessId);
  }
  return lineage;
}

function normalizeWindowsImage(value) {
  const text = String(value ?? "").replace(/^\\\\\?\\/, "");
  return win32.normalize(text).toLowerCase();
}

function processCreationIdentity(row) {
  if (row === undefined) return null;
  return { pid: Number(row.ProcessId), creationDate: String(row.CreationDate ?? "") };
}

function processAtIdentity(identity) {
  if (identity === null || identity === undefined) return undefined;
  const row = windowsProcess(identity.pid);
  return row !== undefined && String(row.CreationDate ?? "") === identity.creationDate ? row : undefined;
}

function sanitizedProcessRow(row) {
  if (row === undefined) return null;
  return {
    ...row,
    ExecutablePath: sanitized(row.ExecutablePath),
    CommandLine: sanitized(row.CommandLine),
  };
}

function publicTerminalSnapshot(ctx, agent) {
  const terminals = ctx.get("terminals");
  if (typeof terminals?.list !== "function") return { available: false };
  try {
    return {
      available: true,
      entries: terminals.list(agent).map((entry) => ({
        sessionId: entry?.sessionId ?? null,
        type: entry?.type ?? null,
        status: entry?.status ?? null,
        pid: entry?.pid ?? null,
      })),
    };
  } catch (error) {
    return { available: true, error: sanitized(error) };
  }
}

function boundedTextSample(value, limit = 4_096) {
  const text = Buffer.isBuffer(value) ? value.toString("utf8") : String(value ?? "");
  const bytes = Buffer.byteLength(text);
  const head = text.slice(0, limit);
  const tail = text.slice(-limit);
  const endFrames = persistentEndFrames(`${head}\n${tail}`);
  return {
    bytes,
    head: sanitized(head),
    tail: sanitized(tail),
    endFrames,
  };
}

function observeTerminalOperations(ctx, agent) {
  const terminals = ctx.get("terminals");
  assert(typeof terminals?.startSend === "function",
    "official terminal startSend API is unavailable for operation observation");
  const original = terminals.startSend;
  const calls = [];
  terminals.startSend = function observedTerminalStartSend(...args) {
    const startedAt = Date.now();
    const request = args[2] ?? {};
    const call = {
      index: calls.length,
      sessionId: args[1] ?? null,
      ownerMatches: args[0] === agent,
      text: sanitized(request.text),
      submit: request.submit === true,
      startedAt,
      readOutputs: [],
      done: null,
      doneError: null,
    };
    let operation;
    try {
      operation = original.apply(this, args);
    } catch (error) {
      call.doneError = sanitized(error);
      calls.push(call);
      appendCaseDiagnostic("terminal.operation.start.throw", call);
      throw error;
    }
    const originalReadOutput = operation?.readOutput;
    if (typeof originalReadOutput === "function") {
      operation.readOutput = function observedReadOutput(...readArgs) {
        const result = originalReadOutput.apply(this, readArgs);
        const delta = result?.delta ?? result?.text ?? "";
        const readRecord = {
          at: Date.now(),
          args: readArgs,
          delta: boundedTextSample(delta),
          truncated: result?.truncated === true,
        };
        call.readOutputs.push(readRecord);
        appendCaseDiagnostic("terminal.operation.readOutput", {
          index: call.index,
          sessionId: call.sessionId,
          read: readRecord,
        });
        return result;
      };
    }
    call.restoreReadOutput = () => {
      if (typeof originalReadOutput === "function") operation.readOutput = originalReadOutput;
    };
    calls.push(call);
    Promise.resolve(operation?.done).then(
      (result) => {
        call.done = {
          elapsedMs: Date.now() - startedAt,
          waitReason: result?.waitReason ?? null,
          sessionStatus: result?.sessionStatus?.kind ?? null,
          viewport: boundedTextSample(result?.viewport),
          truncated: result?.truncated === true,
        };
        appendCaseDiagnostic("terminal.operation.done", {
          index: call.index,
          sessionId: call.sessionId,
          done: call.done,
        });
      },
      (error) => {
        call.doneError = sanitized(error);
        appendCaseDiagnostic("terminal.operation.done.error", {
          index: call.index,
          sessionId: call.sessionId,
          error: call.doneError,
        });
      },
    ).catch(() => {});
    appendCaseDiagnostic("terminal.operation.start", {
      index: call.index,
      sessionId: call.sessionId,
      text: call.text,
      submit: call.submit,
    });
    return operation;
  };
  return {
    calls,
    restore() {
      for (const call of calls) call.restoreReadOutput?.();
      terminals.startSend = original;
    },
  };
}

function outputFragment(value) {
  const text = String(value ?? "");
  return {
    chars: text.length,
    bytes: Buffer.byteLength(text),
    head: sanitized(text.slice(0, 512)),
    tail: sanitized(text.slice(-512)),
    timedOut: /(?:command timed out|timed out or OOM|\[Command timed out)/i.test(text),
    frameTrace: terminalFrameTrace(text),
  };
}

function persistentReapWrapper(text) {
  const source = String(text ?? "");
  const starts = [...source.matchAll(
    /__DSH_PERSISTENT_BASH_START_([0-9a-f-]+)__/gi,
  )];
  const ends = [...source.matchAll(
    /__DSH_PERSISTENT_BASH_END_([0-9a-f-]+):/gi,
  )];
  if (starts.length !== 1 || ends.length !== 1
    || starts[0][1].toLowerCase() !== ends[0][1].toLowerCase()
    || (starts[0].index ?? Infinity) >= (ends[0].index ?? -1)) {
    return null;
  }
  return {
    nonce: starts[0][1],
    endPrefix: `__DSH_PERSISTENT_BASH_END_${ends[0][1]}:`,
  };
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function persistentReapPair(sample, marker, endPrefix) {
  const text = typeof sample === "string" ? sample : "";
  const markerAt = text.lastIndexOf(marker);
  const endPattern = new RegExp(
    `${escapeRegExp(endPrefix)}0(?=$|\\s|\\u001b)`,
    "g",
  );
  let endAt = -1;
  for (const match of text.matchAll(endPattern)) endAt = match.index ?? endAt;
  return markerAt >= 0 && endAt > markerAt
    ? { markerAt, endAt, bytes: Buffer.byteLength(text) }
    : null;
}

/**
 * Validate a persistent reap result against the exact operation that submitted
 * the reap command. This is test-side evidence validation: it does not infer a
 * reap from readiness or a generic exit marker, and it never joins head/tail
 * fragments to manufacture an ordering that was not observed in one sample.
 */
export function inspectPersistentReapEvidence({
  outcome = undefined,
  expectedMarker = "",
  expectedSessionId = undefined,
  operationCalls = [],
  publicReads = [],
} = {}) {
  const reasons = [];
  const result = outcome?.result;
  const renderedText = typeof outcome?.text === "string" ? outcome.text : null;
  const resultValue = result && typeof result === "object"
    ? result.value
    : undefined;
  const addReason = (reason) => reasons.push(reason);
  const validMarker = typeof expectedMarker === "string"
    && expectedMarker.length > 0 && !/[\r\n]/.test(expectedMarker);
  if (!validMarker) addReason("expected reap marker was invalid");
  if (renderedText === null) addReason("rendered tool text was not a string");
  if (typeof resultValue !== "string") {
    addReason("tool result.value was not a string");
  } else if (renderedText !== resultValue) {
    addReason("tool result.value did not equal rendered text");
  }
  if (result?.isError === true) addReason("tool result was isError");
  if (result?.failure !== undefined && result?.failure !== null) {
    addReason("tool result carried failure");
  }
  if (result?.error !== undefined && result?.error !== null) {
    addReason("tool result carried error");
  }
  const timedOut = result?.timedOut === true
    || result?.value?.timedOut === true
    || /command timed out|timed out or OOM|\[Command timed out/i.test(
      renderedText ?? "",
    );
  const aborted = result?.aborted === true
    || result?.value?.aborted === true
    || /tool call aborted/i.test(renderedText ?? "");
  if (timedOut) addReason("tool result timed out");
  if (aborted) addReason("tool result was aborted");
  if (/\[shell exited: code\s+-?\d+\]/i.test(renderedText ?? "")) {
    addReason("tool result reported shell exit");
  }
  const completion = renderedText === null
    ? null
    : /(?:^|\r?\n)\[Command finished with exit code\s+(-?\d+)\]\s*$/i
      .exec(renderedText);
  if (completion === null || completion[1] !== "0") {
    addReason("tool result lacked canonical trailing exit code 0");
  }

  const calls = Array.isArray(operationCalls) ? operationCalls : [];
  const truncationFlags = {
    operationDone: [],
    operationReadOutput: [],
    publicRead: [],
  };
  if (calls.length === 0) addReason("reap operation call range was empty");
  if (typeof expectedSessionId !== "string" || expectedSessionId.length === 0) {
    addReason("reap operation had no expected owner session");
  }
  const matchingCalls = [];
  for (const call of calls) {
    if (call?.ownerMatches !== true) {
      addReason("reap operation owner did not match the expected agent");
    }
    if (call?.sessionId !== expectedSessionId) {
      addReason("reap operation session did not match its owner");
    }
    if (call?.doneError !== null && call?.doneError !== undefined) {
      addReason("reap operation had a done error");
    }
    if (call?.done === null || call?.done === undefined) {
      addReason("reap operation did not settle");
    } else {
      if (call.done.waitReason === "timeout") {
        addReason("reap operation settled by timeout");
      }
      if (call.done.sessionStatus !== "running") {
        addReason("reap operation session was not running");
      }
      truncationFlags.operationDone.push({
        index: call.index,
        truncated: call.done.truncated === true,
      });
    }
    const requestText = String(call?.text ?? "");
    const isEmptyPoll = call?.submit === false && requestText.trim() === "";
    if (isEmptyPoll) continue;
    const wrapper = persistentReapWrapper(requestText);
    if (call?.submit !== true || wrapper === null) {
      addReason("reap operation had a nonempty non-wrapper request");
      continue;
    }
    const markerCount = requestText.split(expectedMarker).length - 1;
    if (markerCount !== 1) {
      addReason("reap operation did not submit the expected marker");
      continue;
    }
    matchingCalls.push({ call, wrapper });
  }
  if (matchingCalls.length !== 1) {
    addReason("reap operation range did not identify exactly one fresh marker call");
  }

  const evidenceSources = [];
  const inspectSample = (
    label,
    sample,
    kind,
    wrapper,
    truncated = false,
    rejectTruncated = false,
  ) => {
    if (truncated === true) {
      if (rejectTruncated) addReason(`${label} was truncated`);
      return;
    }
    const pair = persistentReapPair(sample, expectedMarker, wrapper.endPrefix);
    if (pair !== null) evidenceSources.push({ label, kind, ...pair });
  };
  for (const { call, wrapper } of matchingCalls) {
    for (const [index, read] of (call.readOutputs ?? []).entries()) {
      truncationFlags.operationReadOutput.push({
        index: call.index,
        readIndex: index,
        truncated: read?.truncated === true,
      });
      inspectSample(
        `operation[${call.index}] readOutput[${index}] head`,
        read?.delta?.head,
        "operation",
        wrapper,
        read?.truncated,
        true,
      );
      inspectSample(
        `operation[${call.index}] readOutput[${index}] tail`,
        read?.delta?.tail,
        "operation",
        wrapper,
        read?.truncated,
        true,
      );
    }
    inspectSample(
      `operation[${call.index}] done viewport head`,
      call.done?.viewport?.head,
      "operation",
      wrapper,
      call.done?.truncated,
    );
    inspectSample(
      `operation[${call.index}] done viewport tail`,
      call.done?.viewport?.tail,
      "operation",
      wrapper,
      call.done?.truncated,
    );
  }
  for (const [index, read] of (Array.isArray(publicReads) ? publicReads : [])
    .entries()) {
    truncationFlags.publicRead.push({
      index,
      truncated: read?.read?.truncated === true,
    });
    if (read?.sessionId !== expectedSessionId) {
      addReason(`public read[${index}] session did not match its owner`);
      continue;
    }
    const wrapper = matchingCalls[0]?.wrapper;
    if (wrapper === undefined) continue;
    inspectSample(
      `public read[${index}] head`,
      read?.read?.text?.head,
      "public",
      wrapper,
      read?.read?.truncated,
    );
    inspectSample(
      `public read[${index}] tail`,
      read?.read?.text?.tail,
      "public",
      wrapper,
      read?.read?.truncated,
    );
  }

  const renderedClipped = /<response clipped>/i.test(renderedText ?? "");
  if (!renderedClipped && !(renderedText ?? "").includes(expectedMarker)) {
    addReason("unclipped rendered text lacked the expected marker");
  }
  if (!evidenceSources.some((source) =>
    source.kind === "operation" || source.kind === "public")) {
    addReason("operation/public evidence lacked a fresh marker and END:0 pair");
  }
  return {
    ok: reasons.length === 0,
    reasons,
    renderedClipped,
    operationIndex: matchingCalls.length === 1
      ? matchingCalls[0].call.index
      : null,
    evidenceSources,
    truncationFlags,
  };
}

function terminalFrameTrace(value, limit = 64 * 1024) {
  const text = Buffer.isBuffer(value) ? value.toString("utf8") : String(value ?? "");
  const bytes = Buffer.byteLength(text);
  const raw = Buffer.from(text);
  const bounded = raw.length > limit ? raw.subarray(raw.length - limit).toString("utf8") : text;
  const tokenRegex = /(?:\u001b\]133;D[^\u0007\u001b]*(?:\u0007|\u001b\\)|__DSH_PERSISTENT_BASH_PROMPT__|__DSH_PERSISTENT_BASH_START_[0-9a-f-]+__|__DSH_PERSISTENT_BASH_END_[0-9a-f-]+:\d+)/gi;
  const tokens = [...bounded.matchAll(tokenRegex)].slice(0, 64).map((match) => {
    const token = match[0];
    return {
      at: match.index ?? 0,
      kind: token.startsWith("\u001b]133;D")
        ? "osc133D"
        : token.includes("PROMPT")
          ? "controlledPrompt"
          : token.includes("_END_") ? "end" : "start",
      token: sanitized(token),
    };
  });
  const compact = bounded.replace(/ {32,}/g, (spaces) => `<spaces:${spaces.length}>`);
  return {
    bytes,
    boundedBytes: Buffer.byteLength(bounded),
    tokens,
    compactHead: sanitized(compact.slice(0, 1_024)),
    compactTail: sanitized(compact.slice(-1_024)),
  };
}

function publicSubprocessHandleSnapshot(handle, stdoutFlow = undefined) {
  if (handle === undefined || handle === null) return null;
  return {
    keys: Object.keys(handle),
    hasDone: handle.done !== undefined,
    hasWaitForExit: typeof handle.waitForExit === "function",
    hasTerminate: typeof handle.terminate === "function",
    hasControl: handle.control !== undefined,
    hasCollected: handle.collected !== undefined,
    collectedKeys: handle.collected === undefined ? [] : Object.keys(handle.collected),
    collectedStdoutReadFrom: typeof handle.collected?.stdout?.readFrom === "function",
    collectedStderrReadFrom: typeof handle.collected?.stderr?.readFrom === "function",
    stdoutKeys: handle.stdout === undefined ? [] : Object.keys(handle.stdout),
    stdoutPause: typeof handle.stdout?.pause === "function",
    stdoutResume: typeof handle.stdout?.resume === "function",
    stdoutFlow: stdoutFlow?.snapshot() ?? null,
  };
}

function observeTerminalSessions(ctx) {
  const terminals = ctx.get("terminals");
  assert(typeof terminals?.spawn === "function",
    "official terminal spawn API is unavailable for public PID observation");
  const original = terminals.spawn;
  const calls = [];
  terminals.spawn = async function observedTerminalSpawn(...args) {
    const startedAt = Date.now();
    appendCaseDiagnostic("terminals.spawn.begin", {
      type: args[1]?.type ?? null,
      cwd: sanitized(args[1]?.cwd),
    });
    try {
      const result = await original.apply(this, args);
      calls.push({
        type: args[1]?.type ?? null,
        cwd: args[1]?.cwd ?? null,
        sessionId: result?.sessionId ?? null,
        pid: result?.pid ?? null,
        startedAt,
        publishedAt: Date.now(),
      });
      appendCaseDiagnostic("terminals.spawn.return", {
        type: args[1]?.type ?? null,
        cwd: sanitized(args[1]?.cwd),
        sessionId: result?.sessionId ?? null,
        pid: result?.pid ?? null,
        elapsedMs: Date.now() - startedAt,
      });
      return result;
    } catch (error) {
      calls.push({
        type: args[1]?.type ?? null,
        cwd: args[1]?.cwd ?? null,
        startedAt,
        error: sanitized(error),
      });
      appendCaseDiagnostic("terminals.spawn.throw", {
        type: args[1]?.type ?? null,
        cwd: sanitized(args[1]?.cwd),
        elapsedMs: Date.now() - startedAt,
        error: sanitized(error),
      });
      throw error;
    }
  };
  return {
    calls,
    restore() {
      terminals.spawn = original;
    },
  };
}

function configuredNativeGitBinary() {
  return process.env.DSH_GIT_BASH_PATH ?? "C:\\Program Files\\Git\\bin\\bash.exe";
}

function hasForbiddenNativeWrapper(argv) {
  return argv.some((value) => {
    const normalized = String(value).replaceAll("\\", "/");
    const basename = normalized.slice(normalized.lastIndexOf("/") + 1);
    return /^(?:pwsh(?:\.exe)?|powershell(?:\.exe)?|wsl(?:\.exe)?|bwrap|runner\.js)$/i.test(basename);
  });
}

export function nativeTreeCandidateProjection(processSnapshot, helperChildren, topDescendants) {
  const candidateIds = new Set([
    ...(Array.isArray(helperChildren) ? helperChildren : []),
    ...(Array.isArray(topDescendants) ? topDescendants : []),
  ].map((row) => Number(row?.ProcessId)));
  return (Array.isArray(processSnapshot) ? processSnapshot : [])
    .filter((row) => candidateIds.has(Number(row?.ProcessId)));
}

function nativeTreeSnapshot(spawnObservation, sessionObservation) {
  const session = [...(sessionObservation?.calls ?? [])]
    .reverse()
    .find((candidate) => Number.isSafeInteger(Number(candidate.pid)) && Number(candidate.pid) > 0);
  const topPid = Number(session?.pid);
  const topIdentity = windowsProcess(topPid);
  const topLineage = windowsLineage(topPid, (row) => /pty-helper\.js/i.test(String(row.CommandLine ?? "")));
  const helperIdentity = topLineage.find((row) => /pty-helper\.js/i.test(String(row.CommandLine ?? "")));
  const helperPid = Number(helperIdentity?.ProcessId);
  const processSnapshot = windowsProcessSnapshot();
  const helperChildren = windowsDescendants(helperPid, processSnapshot);
  const topDescendants = windowsDescendants(topPid, processSnapshot);
  const detailedRows = hydrateWindowsRows(
    nativeTreeCandidateProjection(processSnapshot, helperChildren, topDescendants),
    "native tree candidates",
  );
  const detailedByPid = new Map(detailedRows.map((row) => [Number(row.ProcessId), row]));
  const detailedHelperChildren = helperChildren.map((row) => detailedByPid.get(Number(row.ProcessId)));
  const detailedTopDescendants = topDescendants.map((row) => detailedByPid.get(Number(row.ProcessId)));
  const configuredBinary = configuredNativeGitBinary();
  const innerIdentity = normalizeWindowsImage(topIdentity?.ExecutablePath) === normalizeWindowsImage(configuredBinary)
    && normalizeWindowsImage(configuredBinary).endsWith("\\git\\usr\\bin\\bash.exe")
    ? topIdentity
    : detailedTopDescendants.find((row) => normalizeWindowsImage(row?.ExecutablePath).endsWith("\\git\\usr\\bin\\bash.exe"));
  const shellPid = Number(innerIdentity?.ProcessId ?? topPid);
  const descendants = [...detailedHelperChildren, ...detailedTopDescendants];
  const conhostIdentity = descendants.find((row) => String(row.Name ?? "").toLowerCase() === "conhost.exe");
  const byIdentity = new Map();
  for (const row of [helperIdentity, topIdentity, innerIdentity, conhostIdentity, ...descendants]) {
    const identity = processCreationIdentity(row);
    if (identity !== null && identity.creationDate.length > 0) {
      byIdentity.set(`${identity.pid}:${identity.creationDate}`, identity);
    }
  }
  return {
    sessionId: session?.sessionId ?? null,
    topPid,
    topIdentity,
    topLineage,
    topDescendants: detailedTopDescendants,
    helperPid,
    helperIdentity,
    helperChildren: detailedHelperChildren,
    shellPid,
    shellIdentity: innerIdentity,
    conhostIdentity,
    configuredBinary,
    helperArgv: spawnObservation?.calls?.[0]?.argv?.map((value) => String(value)) ?? [],
    helperStdio: spawnObservation?.calls?.[0]?.stdio,
    ownedIdentities: [...byIdentity.values()],
    valid: Number.isSafeInteger(topPid) && topPid > 0
      && String(helperIdentity?.Name ?? "").toLowerCase() === "node.exe"
      && /pty-helper\.js/i.test(String(helperIdentity?.CommandLine ?? ""))
      && normalizeWindowsImage(topIdentity?.ExecutablePath) === normalizeWindowsImage(configuredBinary)
      && String(innerIdentity?.Name ?? "").toLowerCase() === "bash.exe"
      && normalizeWindowsImage(innerIdentity?.ExecutablePath).endsWith("\\git\\usr\\bin\\bash.exe")
      && /--noprofile.*--norc.*-i/i.test(String(innerIdentity?.CommandLine ?? ""))
      && helperChildren.some((row) => Number(row.ProcessId) === topPid)
      && conhostIdentity !== undefined,
  };
}

function addNativeOwnedRows(tree, rows) {
  const byIdentity = new Map(tree.ownedIdentities.map((identity) => [`${identity.pid}:${identity.creationDate}`, identity]));
  for (const row of rows) {
    const identity = processCreationIdentity(row);
    if (identity !== null && identity.creationDate.length > 0) {
      byIdentity.set(`${identity.pid}:${identity.creationDate}`, identity);
    }
  }
  tree.ownedIdentities = [...byIdentity.values()];
}

async function waitForNativeTree(spawnObservation, sessionObservation, label, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  let latest;
  while (Date.now() < deadline) {
    latest = nativeTreeSnapshot(spawnObservation, sessionObservation);
    if (latest.valid) return latest;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`native ${label} process identities were not all published: ${sanitized(JSON.stringify({
    snapshot: latest === undefined ? null : {
      topPid: latest.topPid,
      helperPid: latest.helperPid,
      shellPid: latest.shellPid,
      configuredBinary: latest.configuredBinary,
      top: sanitizedProcessRow(latest.topIdentity),
      helper: sanitizedProcessRow(latest.helperIdentity),
      shell: sanitizedProcessRow(latest.shellIdentity),
      conhost: sanitizedProcessRow(latest.conhostIdentity),
      helperArgv: latest.helperArgv,
    },
  }))}`);
}

async function waitForNativeTreeGone(tree, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  let remaining = [];
  let helperDescendants = [];
  const collect = () => {
    const snapshot = windowsProcessSnapshot();
    remaining = matchProcessIdentities(
      snapshot,
      tree.ownedIdentities,
      "native cleanup identities",
    ).filter((entry) => entry.process !== undefined);
    const helperIdentity = {
      pid: tree.helperPid,
      creationDate: String(tree.helperIdentity?.CreationDate ?? ""),
    };
    const helperPresent = matchProcessIdentities(
      snapshot,
      [helperIdentity],
      "native cleanup helper",
    )[0]?.process !== undefined;
    helperDescendants = helperPresent
      ? windowsDescendants(tree.helperPid, snapshot)
      : [];
  };
  while (Date.now() < deadline) {
    collect();
    if (remaining.length === 0 && helperDescendants.length === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  collect();
  return {
    remaining: remaining.map((entry) => ({
      identity: entry.identity,
      process: sanitizedProcessRow(entry.process),
    })),
    helperDescendants: helperDescendants.map(sanitizedProcessRow),
    observedAt: Date.now(),
  };
}

async function settleObservedNativeHandles(spawnObservation, label) {
  if (spawnObservation === undefined) return [];
  const settlements = [];
  for (const [index, call] of spawnObservation.calls.entries()) {
    assert(typeof call.handle?.waitForExit === "function",
      `native ${label} helper ${index} did not expose waitForExit`);
    let waitForExit;
    let waitError;
    try {
      waitForExit = await call.handle.waitForExit();
    } catch (error) {
      waitError = sanitized(error);
    }
    let done;
    let doneError;
    try {
      done = await call.handle.done;
    } catch (error) {
      doneError = sanitized(error);
    }
    const settlement = {
      index,
      waitForExit,
      waitError: waitError ?? null,
      done: done === undefined ? null : {
        exitCode: done?.exitCode ?? null,
        signal: done?.signal ?? null,
        timedOut: done?.timedOut === true,
      },
      doneError: doneError ?? null,
    };
    settlements.push(settlement);
    assert(waitError === undefined && waitForExit === true && doneError === undefined,
      `native ${label} helper ${index} did not settle cleanly: ${sanitized(JSON.stringify(settlement))}`);
  }
  return settlements;
}

function ownedPath(...parts) {
  const candidate = resolve(...parts);
  const root = resolve(PROBE_ROOT);
  const rel = relative(root, candidate);
  if (rel === ".." || rel.startsWith("..\\") || rel.startsWith("../") || win32.isAbsolute(rel)) {
    throw new Error(`probe path escaped its test root: ${candidate}`);
  }
  return candidate;
}

function removeIfPresent(path) {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch (error) {
    throw new Error(`owned fixture cleanup failed for ${sanitized(path)}: ${sanitized(error)}`);
  }
}

function marker(name) {
  return ownedPath(OUTSIDE, `${name}.marker`);
}

function missingRuntime(result) {
  const text = JSON.stringify(result);
  return /(?:wsl\.exe|Ubuntu|bwrap|\/usr\/bin\/script|spawn|not found|unavailable|realpath)/i.test(text);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function contextLifecycleSnapshot(ctx) {
  const snapshot = {
    context: {},
    services: {},
  };
  try {
    snapshot.context.string = String(ctx);
    snapshot.context.rootString = ctx?.root === undefined ? null : String(ctx.root);
    snapshot.context.fiberName = ctx?.fiber?.name ?? null;
    snapshot.context.fiberState = ctx?.fiber?.state ?? null;
    snapshot.context.rootFiberName = ctx?.root?.fiber?.name ?? null;
    snapshot.context.rootFiberState = ctx?.root?.fiber?.state ?? null;
  } catch (error) {
    snapshot.context.error = sanitized(error);
  }
  for (const name of ["agents", "terminals", "tools", "approval", "appExit"]) {
    try {
      const service = ctx.get(name);
      const value = {
        available: service !== undefined,
        type: typeof service,
      };
      if (service !== undefined) {
        for (const method of ["create", "requireFactory", "list", "read", "signal", "kill", "spawn", "setPolicy", "ask", "request", "answer", "register", "subscribe"]) {
          value[method] = typeof service[method] === "function";
        }
      }
      if (name === "agents" && service !== undefined) {
        value.factoryPresent = service.factory !== undefined;
        if (typeof service.requireFactory === "function") {
          try {
            const factory = service.requireFactory();
            value.requireFactory = {
              ok: true,
              targetPresent: factory?.target !== undefined,
            };
          } catch (error) {
            value.requireFactory = { ok: false, error: sanitized(error) };
          }
        }
        value.serviceFiberName = service.ctx?.fiber?.name ?? null;
        value.serviceFiberState = service.ctx?.fiber?.state ?? null;
      }
      snapshot.services[name] = value;
    } catch (error) {
      snapshot.services[name] = { available: false, error: sanitized(error) };
    }
  }
  return snapshot;
}

async function setOfficialApprovalPolicy(ctx, agent, policy) {
  const anchor = ctx.get("profileContext")?.installAnchor;
  assert(typeof anchor === "string", "official profileContext.installAnchor is unavailable for approval policy setup");
  const hostManifest = JSON.parse(readFileSync(anchor, "utf8"));
  const hostVersion = hostManifest.version ?? null;
  const hostRequire = createRequire(anchor);
  const helperPath = hostRequire.resolve("@deepseek-ai/dsh-user-approval");
  const manifestPath = hostRequire.resolve("@deepseek-ai/dsh-user-approval/package.json");
  const helperManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  assert(helperManifest.version === hostVersion,
    `official approval helper version ${helperManifest.version} does not match host ${hostVersion}`);
  const helper = await import(pathToFileURL(helperPath).href);
  assert(typeof helper.setApprovalPolicy === "function", "official dsh-user-approval setApprovalPolicy export is unavailable");
  helper.setApprovalPolicy(agent.session, policy);
  let version = null;
  try { version = JSON.parse(readFileSync(manifestPath, "utf8")).version ?? null; } catch {}
  return {
    helper: "setApprovalPolicy",
    packageVersion: helperManifest.version ?? version,
    hostVersion,
    helperSha256: createHash("sha256").update(readFileSync(helperPath)).digest("hex"),
    source: "<runtime>/node_modules/@deepseek-ai/dsh-user-approval/lib/index.js",
    policy,
  };
}

async function loadPluginApi() {
  const installed = process.env.DSH_PROBE_PLUGIN_PATH;
  const entry = installed === undefined
    ? await import.meta.resolve("dsh-plugin-bash-wsl")
    : pathToFileURL(join(installed, "dist", "index.js")).href;
  const plugin = await import(entry);
  const dist = dirname(fileURLToPath(entry));
  const [wsl, git] = await Promise.all([
    import(pathToFileURL(join(dist, "tools", "wsl-bash.js")).href),
    import(pathToFileURL(join(dist, "tools", "git-bash.js")).href),
  ]);
  const doctor = await import(pathToFileURL(join(dist, "doctor", "index.js")).href);
  return { ...plugin, ...wsl, ...git, doctor };
}

function observedSubprocess(service, calls, handles = [], onSpawn) {
  return {
    spawn(spec) {
      calls.push({
        argv: [...spec.argv],
        cwd: spec.cwd,
      });
      const handle = service.spawn(spec);
      handles.push(handle);
      onSpawn?.(spec, handle);
      return handle;
    },
  };
}

function waitForCollectedOutput(handle, expected, timeoutMs = 5_000) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const poll = () => {
      const text = handle?.collected?.stdout?.readFrom(0)?.text ?? "";
      if (text.includes(expected)) {
        resolve({ ready: true, text });
        return;
      }
      if (Date.now() >= deadline) {
        resolve({ ready: false, text });
        return;
      }
      const timer = setTimeout(poll, 25);
      timer.unref?.();
    };
    poll();
  });
}

async function waitForNoOwnerActivity(terminals, owner, timeoutMs = 5_000) {
  assert(typeof terminals?.hasOwnerActivity === "function",
    "official terminal service has no hasOwnerActivity lifecycle API");
  const deadline = Date.now() + timeoutMs;
  while (terminals.hasOwnerActivity(owner) || terminals.list(owner).length > 0) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return true;
}

function capabilityError(result, calls) {
  if (result?.failure === undefined) return undefined;
  if (result.failure.kind === "timeout" || result.failure.kind === "aborted") return undefined;
  // The real Windows CLI must expose the managed WSL argv and diagnostics. A
  // generic "bash/script/bwrap unavailable" label is not enough to call this
  // a capability skip: the local host is expected to have the runtime, and a
  // quoting/preflight regression must reach the production owner as FAIL.
  return new Error(`WSL runtime execution failed: ${sanitized(JSON.stringify({
    failure: result.failure,
    stdout: result.stdout,
    stderr: result.stderr,
    sandbox: result.sandbox,
    calls,
  }))}`);
}

async function runWsl(api, services, policy, command, options = {}) {
  const calls = [];
  const handles = [];
  const result = await api.executeWslBash(
    {
      command,
      description: options.description ?? `CLI ${SUITE} probe`,
      workdir: options.workdir ?? WORKSPACE,
      timeoutMs: options.timeoutMs,
    },
    {
      policy,
      executable: "wsl.exe",
      distro: process.env.DSH_WSL_DISTRO ?? "Ubuntu",
      signal: options.signal,
      subprocess: observedSubprocess(services.subprocess, calls, handles, options.onSpawn),
      memoryLimit: options.memoryLimit,
      spillLimit: options.spillLimit,
      probeRuntime: options.probeRuntime,
      skipPreflight: options.skipPreflight,
    },
  );
  const unavailable = capabilityError(result, calls);
  if (unavailable !== undefined) throw unavailable;
  return { result, calls, handles };
}

async function requireWsl(api, services, policy) {
  const ready = await runWsl(api, services, policy, "printf 'dsh-cli-wsl-ready\\n'");
  assert(ready.result.exitCode === 0, `WSL readiness failed: ${sanitized(ready.result.stderr.text)}`);
  return ready;
}

async function runCase(id, body) {
  if (!shouldRunCase(id)) {
    appendCaseDiagnostic("case.filtered", { id });
    return { id, status: "SKIP", detail: `case filtered by DSH_PROBE_CASE_FILTER=${[...CASE_FILTER].join(",")}`, durationMs: 0 };
  }
  const startedAt = Date.now();
  appendCaseDiagnostic("case.begin", { id });
  try {
    const evidence = await body();
    const result = { id, status: "PASS", evidence, durationMs: Date.now() - startedAt };
    appendCaseDiagnostic("case.end", { id, status: result.status, durationMs: result.durationMs });
    return result;
  } catch (error) {
    if (error instanceof CaseSkip) {
      const result = { id, status: "SKIP", detail: error.message, durationMs: Date.now() - startedAt };
      appendCaseDiagnostic("case.end", { id, status: result.status, durationMs: result.durationMs, detail: result.detail });
      return result;
    }
    const result = {
      id,
      status: "FAIL",
      detail: sanitized(error?.stack ?? error),
      ...(error?.evidence === undefined ? {} : { evidence: error.evidence }),
      durationMs: Date.now() - startedAt,
    };
    appendCaseDiagnostic("case.end", { id, status: result.status, durationMs: result.durationMs, detail: result.detail });
    return result;
  }
}

const desktopPresetAudit = [];

/**
 * Desktop's Web composition owns agent tools through the official standard
 * preset. The CLI composition intentionally remains preset-free, so only the
 * real Desktop child mounts it through the actual agentPresets service.
 */
async function createProbeAgent(ctx, options) {
  const agents = ctx.get("agents");
  if (process.env.DSH_DESKTOP_PROBE !== "1") return agents.create(options);
  const presets = ctx.get("agentPresets");
  assert(presets !== undefined
    && typeof presets.resolve === "function"
    && typeof presets.mount === "function",
  "real Desktop agentPresets service cannot resolve/mount the standard preset");
  const resolved = await presets.resolve("standard");
  assert(resolved?.id === "standard", `Desktop resolved unexpected agent preset: ${JSON.stringify(resolved)}`);
  const callerSetup = options?.setup;
  const handle = await agents.create({
    ...options,
    meta: { ...(options?.meta ?? {}), agentPreset: resolved.id },
    setup: async (agentCtx, agent) => {
      await callerSetup?.(agentCtx, agent);
      const mounted = await presets.mount(agentCtx, resolved.id);
      assert(mounted?.id === resolved.id, `Desktop agent preset mount returned ${JSON.stringify(mounted)}`);
    },
  });
  assert(typeof presets.composedPreset === "function", "real Desktop agentPresets service has no composedPreset audit API");
  const composedPreset = presets.composedPreset(handle?.agent?.ctx);
  assert(composedPreset === resolved.id, `Desktop agent composed preset was ${JSON.stringify(composedPreset)}`);
  desktopPresetAudit.push({
    agentId: handle?.agent?.id ?? null,
    presetId: resolved.id,
    service: "agentPresets",
    mounted: true,
    composedPreset,
    metaAgentPreset: options?.meta?.agentPreset ?? resolved.id,
  });
  return handle;
}

async function resolveProbePolicy(ctx, services) {
  assert(services.policy !== undefined
    && typeof services.policy.resolve === "function",
  "official sandbox-policy service is missing");
  const handle = await createProbeAgent(ctx, {
    sessionId: randomUUID(),
    meta: { cwd: WORKSPACE },
  });
  try {
    const agent = handle?.agent;
    assert(agent?.session !== undefined,
      "official agent factory returned no session for policy resolution");
    const policy = services.policy.resolve({
      session: agent.session,
      mode: MODE,
    });
    assert(policy?.workspaceRoot === WORKSPACE,
      "official sandbox policy root did not follow the agent workspace: " +
      sanitized(policy?.workspaceRoot));
    assert(policy?.mode === MODE,
      `official sandbox policy mode did not match ${MODE}: ${sanitized(policy?.mode)}`);
    return policy;
  } finally {
    if (handle?.dispose) await handle.dispose();
  }
}

function desktopPresetEvidence() {
  return process.env.DSH_DESKTOP_PROBE === "1"
    ? { agentPreset: "standard", presetMounts: desktopPresetAudit.slice() }
    : { agentPreset: null, presetMounts: [] };
}

async function inspectServices(ctx, api) {
  const tools = ctx.get("tools");
  const terminals = ctx.get("terminals");
  const subprocess = ctx.get("subprocess");
  const policy = ctx.get("sandboxPolicy");
  const approval = ctx.get("approval");
  const profileContext = ctx.get("profileContext");
  assert(tools !== undefined && typeof tools.schemas === "function", "official tools service is missing");
  assert(terminals !== undefined && typeof terminals.listBackends === "function", "official terminal service is missing");
  assert(subprocess !== undefined && typeof subprocess.spawn === "function", "official subprocess service is missing");
  assert(policy !== undefined && typeof policy.resolve === "function", "official sandbox-policy service is missing");
  assert(approval !== undefined, "official approval service is missing");
  assert(typeof profileContext?.installAnchor === "string", "profileContext.installAnchor is missing");
  const names = tools.schemas().map((schema) => schema.name);
  const backends = terminals.listBackends();
  const hostVersion = api.readDshVersion(profileContext.installAnchor);
  assert(hostVersion === "0.2.1-rc.2", `unexpected host version ${hostVersion}`);
  assert(names.includes("wsl_bash"), "wsl_bash is not registered in the CLI context");
  assert(names.includes("git_bash"), "git_bash is not registered in the CLI context");
  assert(names.includes("bash"), "official persistent bash tool is not registered in the CLI context");
  assert(backends.includes(PERSISTENT_SHELL),
    `plugin persistent backend ${PERSISTENT_SHELL} is not registered: ${JSON.stringify(backends)}`);
  return {
    hostVersion,
    installAnchor: "<windows-cli-install>/package.json",
    toolNames: ["bash", "wsl_bash", "git_bash"].filter((name) => names.includes(name)),
    backendTypes: backends,
    officialApproval: true,
    officialSubprocess: true,
    officialSandboxPolicy: true,
    officialTerminal: true,
  };
}

function officialResultText(result) {
  if (typeof result?.value === "string") return result.value;
  return (result?.content ?? [])
    .filter((block) => block?.type === "text")
    .map((block) => block.text)
    .join("\\n");
}

async function executeOfficialRaw(ctx, agent, name, command, signal = undefined, extraArguments = {}) {
  const tools = ctx.get("tools");
  if (tools === undefined || typeof tools.execute !== "function") {
    throw new CaseSkip("official ToolRuntime.execute is unavailable");
  }
  const callId = randomUUID();
  const startedAt = Date.now();
  appendCaseDiagnostic("tools.execute.begin", {
    callId,
    name,
    command: sanitized(command),
    hasAbortSignal: signal !== undefined,
    signalAborted: signal?.aborted === true,
  });
  try {
    const result = await tools.execute({
      callId,
      name,
      arguments: { ...extraArguments, command },
      agent,
      signal: signal ?? new AbortController().signal,
    });
    const text = officialResultText(result);
    appendCaseDiagnostic("tools.execute.return", {
      callId,
      name,
      elapsedMs: Date.now() - startedAt,
      isError: result?.isError === true,
      error: result?.error === undefined ? null : result.error,
      text: sanitized(text),
    });
    return { result, text };
  } catch (error) {
    appendCaseDiagnostic("tools.execute.throw", {
      callId,
      name,
      elapsedMs: Date.now() - startedAt,
      error: sanitized(error),
    });
    throw error;
  }
}

export function nativeTerminalQueryCommand() {
  return `(${[
    "saved_stty=$(stty -g) || exit 81",
    "restore_native_query_stty() { stty \"$saved_stty\"; }",
    "trap restore_native_query_stty EXIT HUP INT TERM",
    "stty -icanon -echo min 0 time 0 || exit 82",
    "raw=''; dsr=''; da=''",
    "printf '\\033[6n\\033[c' > /dev/tty || exit 83",
    "dsr_re=$'\\033''\\[[1-9][0-9]*;[1-9][0-9]*R'; da_re=$'\\033''\\[\\?[0-9]+(;[0-9]+)*c'",
    "for ((i=0; i<20; i++)); do ch=''; if IFS= read -r -N 1 -t 0.1 ch; then raw+=\"$ch\"; fi; if [[ -z \"$dsr\" && \"$raw\" =~ $dsr_re ]]; then dsr=\"${BASH_REMATCH[0]}\"; fi; if [[ -z \"$da\" && \"$raw\" =~ $da_re ]]; then da=\"${BASH_REMATCH[0]}\"; fi; if [[ -n \"$dsr\" && -n \"$da\" ]]; then break; fi; done",
    "dsr_status=0; da_status=0; [ -n \"$dsr\" ] || dsr_status=1; [ -n \"$da\" ] || da_status=1",
    "raw_hex=$(LC_ALL=C printf '%s' \"$raw\" | od -An -tx1 -v | tr -d ' \\n'); dsr_hex=$(LC_ALL=C printf '%s' \"$dsr\" | od -An -tx1 -v | tr -d ' \\n'); da_hex=$(LC_ALL=C printf '%s' \"$da\" | od -An -tx1 -v | tr -d ' \\n')",
    "stty \"$saved_stty\" || exit 85",
    "trap - EXIT HUP INT TERM",
    "if [ \"$dsr_status\" -ne 0 ] || [ \"$da_status\" -ne 0 ]; then printf 'DSH_NATIVE_DSR_DA stty_restored=1 dsr_status=%s da_status=%s raw_hex=%s dsr_hex=%s da_hex=%s\\n' \"$dsr_status\" \"$da_status\" \"$raw_hex\" \"$dsr_hex\" \"$da_hex\"; exit 86; fi",
    "printf 'DSH_NATIVE_DSR_DA stty_restored=1 dsr_status=%s da_status=%s raw_hex=%s dsr_hex=%s da_hex=%s\\n' \"$dsr_status\" \"$da_status\" \"$raw_hex\" \"$dsr_hex\" \"$da_hex\"",
    "exit 0",
  ].join("; ")})`;
}
export function nativeTerminalQueryResultSummary(query) {
  const result = query?.result;
  const text = String(query?.text ?? "");
  const actualValue = result && typeof result === "object" && typeof result.value === "string"
    ? result.value
    : null;
  const renderMatchesValue = actualValue !== null && text === actualValue;
  const completion = actualValue === null
    ? null
    : /(?:^|\r?\n)\[Command finished with exit code\s+(-?\d+)\]\s*$/i.exec(actualValue);
  const shellExit = /\[shell exited: code\s+(-?\d+)\]/i.exec(actualValue ?? text);
  const failure = result && typeof result === "object"
    ? (result.failure ?? result.value?.failure ?? null)
    : null;
  const resultError = result && typeof result === "object"
    ? (result.error ?? result.value?.error ?? null)
    : null;
  const timedOut = result?.timedOut === true
    || result?.value?.timedOut === true
    || /command timed out|timed out or OOM/i.test(actualValue ?? text);
  const aborted = result?.aborted === true
    || result?.value?.aborted === true
    || /tool call aborted/i.test(actualValue ?? text);
  const parsedExitCode = completion === null
    ? shellExit === null ? null : Number(shellExit[1])
    : Number(completion[1]);
  const shellExited = shellExit !== null;
  const actualExit0 = parsedExitCode === 0
    && result?.isError !== true
    && failure === null
    && resultError === null
    && timedOut !== true
    && aborted !== true
    && shellExited !== true
    && renderMatchesValue
    && completion !== null
      && completion[1] === "0";
  return {
    parsedExitCode,
    shellExited,
    timedOut,
    aborted,
    isError: result?.isError === true,
    failure,
    error: resultError,
    toolExitCode: result && typeof result === "object" && "exitCode" in result
      ? result.exitCode
      : null,
    valueIsString: actualValue !== null,
    renderMatchesValue,
    completionLine: completion?.[0] ?? null,
    actualExit0,
    output: text,
  };
}

function nativeTerminalHex(hex, label) {
  assert(typeof hex === "string" && /^[0-9a-f]+$/i.test(hex) && hex.length % 2 === 0,
    `native terminal ${label} reply was not a nonempty hex byte string: ${sanitized(hex)}`);
  return Buffer.from(hex, "hex").toString("ascii");
}

export function parseNativeTerminalQueryOutput(text) {
  const prefix = "DSH_NATIVE_DSR_DA ";
  const line = String(text ?? "")
    .split(/\r?\n/)
    .find((candidate) => candidate.startsWith(prefix));
  assert(line !== undefined, `native terminal query did not return its evidence marker: ${sanitized(text)}`);
  const fields = Object.create(null);
  for (const token of line.slice(prefix.length).trim().split(/\s+/)) {
    const separator = token.indexOf("=");
    assert(separator > 0, `native terminal query returned a malformed field: ${sanitized(line)}`);
    const key = token.slice(0, separator);
    assert(fields[key] === undefined, `native terminal query repeated field ${key}`);
    fields[key] = token.slice(separator + 1);
  }
  for (const key of ["stty_restored", "dsr_status", "da_status", "dsr_hex", "da_hex"]) {
    assert(fields[key] !== undefined, `native terminal query omitted ${key}: ${sanitized(line)}`);
  }
  const parseStatus = (key) => {
    const value = Number(fields[key]);
    assert(Number.isSafeInteger(value) && value >= 0,
      `native terminal query returned invalid ${key}: ${sanitized(line)}`);
    return value;
  };
  const dsrHex = fields.dsr_hex;
  const daHex = fields.da_hex;
  const dsrReply = nativeTerminalHex(dsrHex, "DSR");
  const daReply = nativeTerminalHex(daHex, "DA");
  const dsrMatch = /^\u001b\[([1-9][0-9]*);([1-9][0-9]*)R$/.exec(dsrReply);
  assert(dsrMatch !== null,
    `native terminal DSR reply was not CSI row;column R with positive integers: ${sanitized(dsrHex)}`);
  const daMatch = /^\u001b\[\?([0-9]+(?:;[0-9]+)*)c$/.exec(daReply);
  assert(daMatch !== null,
    `native terminal DA reply was not CSI ?digits(;digits)* c: ${sanitized(daHex)}`);
  const parseCsiNumber = (value, label) => {
    const number = Number(value);
    assert(Number.isSafeInteger(number), `native terminal ${label} parameter was not a safe integer`);
    return number;
  };
  return {
    sttyRestored: fields.stty_restored === "1",
    dsrStatus: parseStatus("dsr_status"),
    daStatus: parseStatus("da_status"),
    dsrHex,
    daHex,
    dsr: {
      row: parseCsiNumber(dsrMatch[1], "DSR row"),
      column: parseCsiNumber(dsrMatch[2], "DSR column"),
    },
    da: {
      parameters: daMatch[1].split(";").map((value) => parseCsiNumber(value, "DA")),
    },
  };
}

async function runNativeTerminalQuery(ctx, agent, nativeTree) {
  const ownerCreationBeforePrepare = {
    top: processCreationIdentity(nativeTree.topIdentity),
    shell: processCreationIdentity(nativeTree.shellIdentity),
  };
  assert(ownerCreationBeforePrepare.top?.creationDate.length > 0
    && ownerCreationBeforePrepare.shell?.creationDate.length > 0,
  "native terminal query had no owner CreationDate before prepare");
  const query = await executeOfficialRaw(ctx, agent, "bash", nativeTerminalQueryCommand());
  const resultSummary = nativeTerminalQueryResultSummary(query);
  assert(resultSummary.actualExit0,
    `native terminal query tool did not return a clean parsed exitCode 0: ${sanitized(JSON.stringify(resultSummary))}`);
  const parsed = parseNativeTerminalQueryOutput(query.text);
  assert(parsed.sttyRestored && parsed.dsrStatus === 0 && parsed.daStatus === 0,
    `native terminal query did not restore stty and read both replies: ${sanitized(JSON.stringify(parsed))}`);
  const topAfter = processAtIdentity(ownerCreationBeforePrepare.top);
  const shellAfter = processAtIdentity(ownerCreationBeforePrepare.shell);
  assert(topAfter !== undefined && shellAfter !== undefined,
    `native terminal query changed or lost the owner shell identity before prepare: ${sanitized(JSON.stringify(ownerCreationBeforePrepare))}`);
  return {
    toolExitCode: resultSummary.parsedExitCode,
    parsedExitCode: resultSummary.parsedExitCode,
    shellExited: resultSummary.shellExited,
    timedOut: resultSummary.timedOut,
    aborted: resultSummary.aborted,
    sttyRestored: parsed.sttyRestored,
    dsrStatus: parsed.dsrStatus,
    daStatus: parsed.daStatus,
    dsrHex: parsed.dsrHex,
    daHex: parsed.daHex,
    dsr: parsed.dsr,
    da: parsed.da,
    ownerCreationBeforePrepare,
    ownerCreationAfterProbe: {
      top: processCreationIdentity(topAfter),
      shell: processCreationIdentity(shellAfter),
    },
  };
}

async function executeOfficialTool(ctx, agent, name, command, signal = undefined, extraArguments = {}) {
  const { result, text } = await executeOfficialRaw(ctx, agent, name, command, signal, extraArguments);
  if (result?.isError) {
    throw new Error(result.error?.message ?? text);
  }
  return { result, text };
}

async function persistentState(ctx) {
  const agents = ctx.get("agents");
  if (agents === undefined || typeof agents.create !== "function") {
    throw new CaseSkip("official agents service/factory is unavailable in this CLI composition");
  }
  const tools = ctx.get("tools");
  const persistentCwd = ownedPath(WORKSPACE, "persistent-cwd 中文 space");
  const persistentCwdShell = shellPath(persistentCwd);
  const persistentCwdWsl = wslPath(persistentCwd);
  const pwdFramePath = ownedPath(WORKSPACE, `persistent-cwd-frame-${MODE}.txt`);
  const pwdFrameShell = shellPath(pwdFramePath);
  removeIfPresent(persistentCwd);
  removeIfPresent(pwdFramePath);
  const terminals = ctx.get("terminals");
  let handle;
  let agent;
  const spawnObservation = PERSISTENT_SHELL === "git-bash"
    ? observeNativeSpawner(ctx)
    : undefined;
  const sessionObservation = observeTerminalSessions(ctx);
  const managedObservation = PERSISTENT_SHELL === "wsl"
    ? observeWslManagedSubprocesses(ctx)
    : undefined;
  const observerIdentity = PERSISTENT_SHELL === "git-bash"
    ? processCreationIdentity(windowsProcess(process.pid))
    : null;
  let nativeEvidence;
  let nativeManagedSettlements;
  try {
    handle = await createProbeAgent(ctx, {
      sessionId: randomUUID(),
      meta: { cwd: WORKSPACE },
    });
    agent = handle?.agent;
    assert(agent !== undefined, "official agent factory returned no agent");
    assert(typeof tools.get === "function" && tools.get("bash", agent) !== undefined,
      "official persistent bash tool is not visible to the created agent");
    authorizePersistentShell(agent);
    const first = await executeOfficialTool(
      ctx,
      agent,
      "bash",
      `mkdir -p ${bashQuote(persistentCwdShell)}; export DSH_CLI_PERSIST=kept; cli_probe_function(){ printf 'function=kept\\n'; }; (sleep 20) & export DSH_CLI_JOB_PID=$!; cd ${bashQuote(persistentCwdShell)}`,
    );
    const pwdProbe = PERSISTENT_SHELL === "git-bash"
      ? "pwd -W"
      : "printf '%s' \"$PWD\"";
    const pwdFrame = `{ printf '__DSH_CLI_PWD_BEGIN__'; ${pwdProbe} | base64 | tr -d '\\r\\n'; printf '__DSH_CLI_PWD_END__'; } > ${bashQuote(pwdFrameShell)}`;
    const second = await executeOfficialTool(
      ctx,
      agent,
      "bash",
      `job_pid=\"\${DSH_CLI_JOB_PID-}\"; if [ -n \"$job_pid\" ] && kill -0 \"$job_pid\" 2>/dev/null && jobs -p | grep -Fx \"$job_pid\" >/dev/null; then printf 'job-alive=%s\\n' \"$job_pid\"; else printf 'job-missing\\n'; fi; ${pwdFrame}; printf 'var=%s size=%s\\n' \"$DSH_CLI_PERSIST\" \"$(stty size 2>/dev/null || printf unavailable)\"; cli_probe_function; kill \"$job_pid\" 2>/dev/null || true; wait \"$job_pid\" 2>/dev/null || true; printf 'job-clean\\n'`,
    );
    const output = `${first.text}\\n${second.text}`;
    assert(output.includes("var=kept"), "persistent environment did not survive the second official bash call");
   assert(output.includes("function=kept"), "persistent shell function did not survive the second official bash call");
    assert(/job-alive=\d+/.test(output), "persistent background job did not survive the second official bash call");
    assert(output.includes("job-clean"), "persistent background job was not explicitly killed and waited");
    const expectedPersistentCwd = PERSISTENT_SHELL === "git-bash"
      ? gitBashWindowsPath(persistentCwd).toLowerCase()
      : persistentCwdWsl;
    const frameText = existsSync(pwdFramePath) ? readFileSync(pwdFramePath, "utf8") : "";
    const pwdMatch = /__DSH_CLI_PWD_BEGIN__([A-Za-z0-9+/=]+)__DSH_CLI_PWD_END__/.exec(frameText);
    assert(pwdMatch !== null,
      `official persistent cwd frame was missing: frame=${sanitized(frameText)} output=${sanitized(output)}`);
    const observedCwd = Buffer.from(pwdMatch[1], "base64").toString("utf8")
      .replace(/(?:\r\n|\r|\n)+$/u, "");
    const normalizedExpectedCwd = PERSISTENT_SHELL === "git-bash"
      ? expectedPersistentCwd.replaceAll("\\", "/").toLowerCase()
      : expectedPersistentCwd.replaceAll("\\", "/");
    const normalizedObservedCwd = PERSISTENT_SHELL === "git-bash"
      ? observedCwd.replaceAll("\\", "/").toLowerCase()
      : observedCwd.replaceAll("\\", "/");
    assert(normalizedObservedCwd === normalizedExpectedCwd,
      `official persistent cwd did not remain exact: expected=${sanitized(expectedPersistentCwd)} observed=${sanitized(observedCwd)} output=${sanitized(output)}`);
    assert(output.includes("40 160"), "official persistent PTY geometry was not 40x160");
    let observedArgv;
    if (spawnObservation !== undefined) {
      assert(spawnObservation.calls.length === 1,
        `native Git Bash startup spawned ${spawnObservation.calls.length} helper process(es)`);
      assert(sessionObservation?.calls.length === 1,
        `native Git Bash published ${sessionObservation?.calls.length ?? 0} terminal session(s)`);
      const helperCall = spawnObservation.calls[0];
      const argv = helperCall.argv.map((value) => String(value));
      const joinedArgv = argv.join(" ");
      const topPid = Number(sessionObservation.calls[0].pid);
      const topIdentity = windowsProcess(topPid);
      const topLineage = windowsLineage(topPid, (row) => /pty-helper\.js/i.test(String(row.CommandLine ?? "")));
      const helperIdentity = topLineage.find((row) => /pty-helper\.js/i.test(String(row.CommandLine ?? "")));
      const helperPid = Number(helperIdentity?.ProcessId);
      const processSnapshot = windowsProcessSnapshot();
      const helperDescendants = windowsDescendants(helperPid, processSnapshot);
      const configuredBinary = process.env.DSH_GIT_BASH_PATH ?? "C:\\Program Files\\Git\\bin\\bash.exe";
      const topDescendants = hydrateWindowsRows(
        windowsDescendants(topPid, processSnapshot),
        "native Git Bash candidates",
      );
      const innerIdentity = normalizeWindowsImage(topIdentity?.ExecutablePath) === normalizeWindowsImage(configuredBinary)
        && normalizeWindowsImage(configuredBinary).endsWith("\\git\\usr\\bin\\bash.exe")
        ? topIdentity
        : topDescendants.find((row) => normalizeWindowsImage(row.ExecutablePath).endsWith("\\git\\usr\\bin\\bash.exe"));
      const shellPid = Number(innerIdentity?.ProcessId ?? topPid);
      const shellIdentity = innerIdentity;
      const installAnchor = ctx.get("profileContext")?.installAnchor;
      assert(Number.isSafeInteger(topPid) && topPid > 0,
        `native Git Bash terminal did not publish a top-process PID: ${sanitized(joinedArgv)}`);
      assert(Number.isSafeInteger(helperPid) && helperPid > 0
        && String(helperIdentity?.Name ?? "").toLowerCase() === "node.exe"
        && String(helperIdentity?.ExecutablePath ?? "").toLowerCase().endsWith("\\node.exe")
        && /pty-helper\.js/i.test(String(helperIdentity?.CommandLine ?? "")),
      `native Git Bash helper was not found in the terminal PID lineage: ${sanitized(JSON.stringify({ topPid, topLineage, argv }))}`);
      assert(!hasForbiddenNativeWrapper(argv),
        `native Git Bash helper argv used a forbidden wrapper: ${sanitized(joinedArgv)}`);
      assert(argv.length === 3
        && String(argv[0]).toLowerCase().endsWith("\\node.exe")
        && /pty-helper\.js$/i.test(argv[1])
        && argv[2] === installAnchor,
      `native Git Bash helper argv did not preserve the real host anchor: ${sanitized(JSON.stringify({ argv, installAnchor }))}`);
      assert(helperCall.stdio?.stdin === "pipe"
        && helperCall.stdio?.stdout === "pipe"
        && helperCall.stdio?.control === "pipe"
        && helperCall.stdio?.stderr?.maxBytes === 4_096,
      `native Git Bash helper did not expose the bounded private control/stdio contract: ${sanitized(JSON.stringify(helperCall.stdio))}`);
      assert(normalizeWindowsImage(topIdentity?.ExecutablePath) === normalizeWindowsImage(configuredBinary),
        `native Git Bash top image did not match configured executable: ${sanitized(JSON.stringify({ configuredBinary, topIdentity }))}`);
      assert(Number.isSafeInteger(shellPid) && shellPid > 0
        && String(shellIdentity?.Name ?? "").toLowerCase() === "bash.exe"
        && normalizeWindowsImage(shellIdentity?.ExecutablePath).endsWith("\\git\\usr\\bin\\bash.exe")
        && /--noprofile.*--norc.*-i/i.test(String(shellIdentity?.CommandLine ?? "")),
      `native Git Bash actual usr/bin MSYS child was not observed: ${sanitized(JSON.stringify({ configuredBinary, topIdentity, topDescendants, shellPid, shellIdentity }))}`);
      assert(topLineage.some((row) => Number(row.ProcessId) === helperPid)
        && helperDescendants.some((row) => Number(row.ProcessId) === topPid),
      `native Git Bash top process was not rooted in the helper: ${sanitized(JSON.stringify({ helperPid, topPid, topLineage, helperDescendants }))}`);
      nativeEvidence = {
        helperPid,
        helperArgv: argv.map((value) => sanitized(value)),
        controlPipe: true,
        helperIdentity: sanitizedProcessRow(helperIdentity),
        helperChildren: helperDescendants.map(sanitizedProcessRow),
        helperCreationIdentity: processCreationIdentity(helperIdentity),
        topPid,
        configuredBinary: sanitized(configuredBinary),
        topIdentity: sanitizedProcessRow(topIdentity),
        topCreationIdentity: processCreationIdentity(topIdentity),
        shellPid,
        shellIdentity: sanitizedProcessRow(shellIdentity),
        shellCreationIdentity: processCreationIdentity(shellIdentity),
        session: {
          ...sessionObservation.calls[0],
          cwd: sanitized(sessionObservation.calls[0].cwd),
        },
      };
      observedArgv = argv.map((value) => sanitized(value));
    }
    const commonEvidence = {
      agentId: agent.id,
      cwdAndEnvPersisted: true,
      canonicalCwdPersisted: true,
      cwdProbe: {
        expected: sanitized(expectedPersistentCwd),
        observed: sanitized(observedCwd),
        comparison: PERSISTENT_SHELL === "git-bash"
          ? "case-folded slash-normalized"
          : "slash-normalized, case-preserving",
      },
      ...(observedArgv === undefined ? {} : { nativeArgv: observedArgv, nativeProcess: nativeEvidence }),
      ptySize: "40x160",
      backgroundJobPersisted: true,
      backgroundJobReaped: true,
      officialToolRuntime: true,
    };
    if (PERSISTENT_SHELL === "wsl") {
      await handle.dispose();
      handle = undefined;
      const managedSettlements = await settleObservedWslManagedHandles(managedObservation, "persistent state");
      const managedDone = managedSettlements.length > 0
        && managedSettlements.every((entry) => entry.doneError === null && entry.done !== null);
      const managedWaitForExit = managedSettlements.length > 0
        && managedSettlements.every((entry) => entry.waitError === null && entry.waitForExit === true);
      const ownerActivityCleared = await waitForNoOwnerActivity(terminals, agent, 5_000);
      assert(managedDone && managedWaitForExit,
        `WSL persistent state managed handles did not settle cleanly: ${sanitized(JSON.stringify(managedSettlements))}`);
      assert(ownerActivityCleared,
        "WSL persistent state disposal left owner terminal activity registered");
      return {
        ...commonEvidence,
        publicSession: publicWslSessionEvidence(sessionObservation),
        managedSettlements,
        managedDone,
        managedWaitForExit,
        ownerActivityCleared,
        observationError: null,
      };
    }
    return {
      ...commonEvidence,
      ...(observedArgv === undefined ? {} : { nativeArgv: observedArgv, nativeProcess: nativeEvidence }),
    };
  } finally {
    spawnObservation?.restore();
    sessionObservation?.restore();
    managedObservation?.restore();
    try {
      if (handle?.dispose) await handle.dispose();
    } finally {
      if (nativeEvidence !== undefined) {
        nativeManagedSettlements = await settleObservedNativeHandles(spawnObservation, "persistent state");
        const deadline = Date.now() + 5_000;
        while (Date.now() < deadline
          && (processAtIdentity(nativeEvidence.helperCreationIdentity) !== undefined
            || processAtIdentity(nativeEvidence.topCreationIdentity) !== undefined
            || processAtIdentity(nativeEvidence.shellCreationIdentity) !== undefined)) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        const remaining = [
          { pid: nativeEvidence.helperPid, process: sanitizedProcessRow(processAtIdentity(nativeEvidence.helperCreationIdentity)) },
          { pid: nativeEvidence.topPid, process: sanitizedProcessRow(processAtIdentity(nativeEvidence.topCreationIdentity)) },
          { pid: nativeEvidence.shellPid, process: sanitizedProcessRow(processAtIdentity(nativeEvidence.shellCreationIdentity)) },
        ].filter((entry) => entry.process !== null);
        const helperChildren = processAtIdentity(nativeEvidence.helperCreationIdentity) === undefined
          ? []
          : windowsDescendants(nativeEvidence.helperPid).map(sanitizedProcessRow);
        nativeEvidence.afterDispose = {
          helper: remaining.find((entry) => entry.pid === nativeEvidence.helperPid)?.process ?? null,
          top: remaining.find((entry) => entry.pid === nativeEvidence.topPid)?.process ?? null,
          shell: remaining.find((entry) => entry.pid === nativeEvidence.shellPid)?.process ?? null,
          remaining,
          helperChildren,
          managedSettlements: nativeManagedSettlements,
        };
        nativeEvidence.managedSettlements = nativeManagedSettlements;
        nativeEvidence.managedDone = nativeManagedSettlements.length > 0
          && nativeManagedSettlements.every((entry) => entry.doneError === null && entry.done !== null);
        nativeEvidence.managedWaitForExit = nativeManagedSettlements.length > 0
          && nativeManagedSettlements.every((entry) => entry.waitError === null && entry.waitForExit === true);
        nativeEvidence.observerHostAliveAfterExit = observerIdentity !== null
          && processAtIdentity(observerIdentity) !== undefined;
        nativeEvidence.observationError = null;
        assert(nativeEvidence.afterDispose.helper === null
          && nativeEvidence.afterDispose.top === null
          && nativeEvidence.afterDispose.shell === null
          && nativeEvidence.afterDispose.remaining.length === 0
          && nativeEvidence.afterDispose.helperChildren.length === 0,
        `native Git Bash helper/Job cleanup left owned processes: ${sanitized(JSON.stringify(nativeEvidence.afterDispose))}`);
        assert(nativeEvidence.observerHostAliveAfterExit,
          "native Git Bash state observer host exited before cleanup evidence was collected");
      }
      removeIfPresent(persistentCwd);
      removeIfPresent(pwdFramePath);
    }
  }
}
async function officialOneShot(ctx, toolName, mode, command, description) {
  const agents = ctx.get("agents");
  if (agents === undefined || typeof agents.create !== "function") {
    throw new CaseSkip(`official agents service/factory is unavailable for ${toolName}`);
  }
  let handle;
  try {
    handle = await createProbeAgent(ctx, { sessionId: randomUUID(), meta: { cwd: WORKSPACE } });
    const agent = handle?.agent;
    assert(agent !== undefined, `official agent factory returned no agent for ${toolName}`);
    const tools = ctx.get("tools");
    assert(typeof tools?.get === "function" && tools.get(toolName, agent) !== undefined,
      `official ${toolName} tool is not visible to the created agent`);
    if (typeof agent.session?.append === "function") {
      agent.session.append("sandbox/mode", { mode });
    }
    const { result, text } = await executeOfficialRaw(
      ctx,
      agent,
      toolName,
      command,
      undefined,
      { description, workdir: WORKSPACE },
    );
    if (result?.isError) throw new Error(result.error?.message ?? text);
    const value = result.value;
    assert(value?.exitCode === 0, `${toolName} exit code was ${value?.exitCode}`);
    assert(value?.stdout?.text?.includes("中文 空格"), `${toolName} lost UTF-8/space output`);
    return {
      tool: toolName,
      exitCode: value.exitCode,
      stdout: value.stdout.text,
      sandbox: value.sandbox,
      officialToolRuntime: true,
    };
  } finally {
    if (handle?.dispose) await handle.dispose();
  }
}

async function officialMalformedUtf8CapForTool(ctx, toolName, mode) {
  const agents = ctx.get("agents");
  if (agents === undefined || typeof agents.create !== "function") {
    throw new CaseSkip("official agents service/factory is unavailable for malformed UTF-8 cap");
  }
  let handle;
  try {
    handle = await createProbeAgent(ctx, {
      sessionId: randomUUID(),
      meta: { cwd: WORKSPACE },
    });
    const agent = handle?.agent;
    assert(agent !== undefined, "official agent factory returned no agent for malformed UTF-8 cap");
    const tools = ctx.get("tools");
    assert(typeof tools?.get === "function" && tools.get(toolName, agent) !== undefined,
      "official " + toolName + " tool is not visible to the created agent");
    if (typeof agent.session?.append === "function") {
      agent.session.append("sandbox/mode", { mode });
    }
    const command = "printf '\\377\\377\\377\\377'";
    const { result, text } = await executeOfficialRaw(
      ctx,
      agent,
      toolName,
      command,
      undefined,
      {
        description: "malformed UTF-8 visible-byte cap",
        workdir: WORKSPACE,
      },
    );
    if (result?.isError) throw new Error(result.error?.message ?? text);
    const value = result.value;
    const stdout = value?.stdout;
    const visibleBytes = Buffer.byteLength(stdout?.text ?? "", "utf8");
    const replacementCount = (stdout?.text?.match(/\uFFFD/g) ?? []).length;
    assert(value?.exitCode === 0,
      toolName + " malformed UTF-8 command exit=" + value?.exitCode);
    assert(stdout?.truncated === true,
      toolName + " malformed UTF-8 output was not marked truncated: " + sanitized(text));
    assert(visibleBytes <= 4,
      toolName + " malformed UTF-8 visible bytes exceeded cap: " + visibleBytes);
    return {
      tool: toolName,
      mode,
      command,
      requestedRawBytes: 4,
      configuredVisibleCapBytes: 4,
      exitCode: value.exitCode,
      truncated: stdout.truncated,
      visibleBytes,
      replacementCount,
      output: sanitized(stdout.text),
      officialToolRuntime: true,
    };
  } finally {
    if (handle?.dispose) await handle.dispose();
  }
}

async function officialGitBashMalformedUtf8StderrCap(ctx) {
  const agents = ctx.get("agents");
  if (agents === undefined || typeof agents.create !== "function") {
    throw new CaseSkip("official agents service/factory is unavailable for Git Bash stderr cap");
  }
  let handle;
  try {
    handle = await createProbeAgent(ctx, {
      sessionId: randomUUID(),
      meta: { cwd: WORKSPACE },
    });
    const agent = handle?.agent;
    assert(agent !== undefined, "official agent factory returned no agent for Git Bash stderr cap");
    const tools = ctx.get("tools");
    assert(typeof tools?.get === "function" && tools.get("git_bash", agent) !== undefined,
      "official git_bash tool is not visible to the created agent");
    if (typeof agent.session?.append === "function") {
      agent.session.append("sandbox/mode", { mode: "danger-full-access" });
    }
    const command = "printf '\\377\\377\\377\\377' >&2";
    const { result, text } = await executeOfficialRaw(
      ctx,
      agent,
      "git_bash",
      command,
      undefined,
      {
        description: "malformed UTF-8 stderr visible-byte cap",
        workdir: WORKSPACE,
      },
    );
    if (result?.isError) throw new Error(result.error?.message ?? text);
    const value = result.value;
    const stderr = value?.stderr;
    const visibleBytes = Buffer.byteLength(stderr?.text ?? "", "utf8");
    const replacementCount = (stderr?.text?.match(/\uFFFD/g) ?? []).length;
    assert(value?.exitCode === 0,
      "git_bash malformed UTF-8 stderr command exit=" + value?.exitCode);
    assert(stderr?.truncated === true,
      "git_bash malformed UTF-8 stderr was not marked truncated: " + sanitized(text));
    assert(visibleBytes <= 4,
      "git_bash malformed UTF-8 stderr visible bytes exceeded cap: " + visibleBytes);
    return {
      tool: "git_bash",
      mode: "danger-full-access",
      stream: "stderr",
      command,
      requestedRawBytes: 4,
      configuredVisibleCapBytes: 4,
      exitCode: value.exitCode,
      truncated: stderr.truncated,
      visibleBytes,
      replacementCount,
      output: sanitized(stderr.text),
      officialToolRuntime: true,
    };
  } finally {
    if (handle?.dispose) await handle.dispose();
  }
}

async function officialWslMergedStderrCap(ctx) {
  const agents = ctx.get("agents");
  if (agents === undefined || typeof agents.create !== "function") {
    throw new CaseSkip("official agents service/factory is unavailable for WSL merged stderr cap");
  }
  let handle;
  try {
    handle = await createProbeAgent(ctx, {
      sessionId: randomUUID(),
      meta: { cwd: WORKSPACE },
    });
    const agent = handle?.agent;
    assert(agent !== undefined, "official agent factory returned no agent for WSL merged stderr cap");
    const tools = ctx.get("tools");
    assert(typeof tools?.get === "function" && tools.get("wsl_bash", agent) !== undefined,
      "official wsl_bash tool is not visible to the created agent");
    if (typeof agent.session?.append === "function") {
      agent.session.append("sandbox/mode", { mode: "workspace-write" });
    }
    const command = "printf '\\377\\377\\377\\377' >&2";
    const { result, text } = await executeOfficialRaw(
      ctx,
      agent,
      "wsl_bash",
      command,
      undefined,
      {
        description: "malformed UTF-8 stderr merged into WSL PTY stdout cap",
        workdir: WORKSPACE,
      },
    );
    if (result?.isError) throw new Error(result.error?.message ?? text);
    const value = result.value;
    const stdout = value?.stdout;
    const stdoutText = stdout?.text ?? "";
    const visibleBytes = Buffer.byteLength(stdoutText, "utf8");
    const replacementCount = (stdoutText.match(/\uFFFD/g) ?? []).length;
    assert(value?.exitCode === 0,
      "wsl_bash merged stderr command exit=" + value?.exitCode);
    assert(stdout?.truncated === true,
      "wsl_bash merged stderr output was not marked truncated: " + sanitized(text));
    assert(replacementCount > 0,
      "wsl_bash merged stderr bytes were not visible in captured stdout: " + sanitized(text));
    assert(visibleBytes <= 4,
      "wsl_bash merged stderr visible bytes exceeded cap: " + visibleBytes);
    return {
      tool: "wsl_bash",
      mode: "workspace-write",
      stream: "stderr",
      command,
      sentStream: "stderr",
      capturedStream: "stdout",
      ptyMergingObserved: true,
      transportNote: "Bash program stderr was captured through the WSL script PTY stdout; outer tool/process stderr is not treated as program stderr",
      requestedRawBytes: 4,
      sentRawBytes: 4,
      configuredVisibleCapBytes: 4,
      exitCode: value.exitCode,
      truncated: stdout.truncated,
      visibleBytes,
      replacementCount,
      output: sanitized(stdoutText),
      officialToolRuntime: true,
    };
  } finally {
    if (handle?.dispose) await handle.dispose();
  }
}

async function officialRegisteredMalformedUtf8Cap(ctx) {
  return {
    wsl_bash: await officialMalformedUtf8CapForTool(ctx, "wsl_bash", "workspace-write"),
    git_bash: await officialMalformedUtf8CapForTool(ctx, "git_bash", "danger-full-access"),
    git_bash_stderr: await officialGitBashMalformedUtf8StderrCap(ctx),
    wsl_stderr_merged: await officialWslMergedStderrCap(ctx),
  };
}

async function officialGitBashWorkdirDefaultsV2(ctx) {
  const agents = ctx.get("agents");
  if (agents === undefined || typeof agents.create !== "function") {
    throw new CaseSkip("official agents service/factory is unavailable for Git Bash workdir diagnostic");
  }
  const hostCwd = process.env.DSH_PROBE_HOST_CWD ?? process.cwd();
  const actualProcessCwd = resolve(process.cwd());
  const agentWorkspace = ownedPath(WORKSPACE, "agent workspace 中文 space");
  const relativeName = "git-relative-child 中文 space";
  const workspaceChild = ownedPath(agentWorkspace, relativeName);
  const hostChild = ownedPath(hostCwd, relativeName);
  mkdirSync(agentWorkspace, { recursive: true });
  mkdirSync(workspaceChild, { recursive: true });
  mkdirSync(hostChild, { recursive: true });
  const expectedWorkspace = gitBashWindowsPath(agentWorkspace);
  const expectedWorkspaceChild = gitBashWindowsPath(workspaceChild);
  const expectedHost = gitBashWindowsPath(hostCwd);
  const expectedHostChild = gitBashWindowsPath(hostChild);
  assert(actualProcessCwd.toLowerCase() === resolve(hostCwd).toLowerCase(),
    "actual probe process.cwd differed from the declared host process cwd: " +
    sanitized(JSON.stringify({ actualProcessCwd, hostCwd })));
  assert(actualProcessCwd.toLowerCase() !== agentWorkspace.toLowerCase(),
    "actual probe process.cwd unexpectedly matched the agent workspace");
  const subprocess = ctx.get("subprocess");
  const originalSpawn = subprocess?.spawn;
  let spawnSpyInstalled = false;
  let handle;
  try {
    handle = await createProbeAgent(ctx, {
      sessionId: randomUUID(),
      meta: { cwd: agentWorkspace },
    });
    const agent = handle?.agent;
    assert(agent !== undefined, "official agent factory returned no agent for Git Bash workdir diagnostic");
    const sessionCwd = agent.session?.header?.cwd;
    if (sessionCwd === undefined) {
      throw new CaseSkip("official Agent session header cwd is unavailable");
    }
    assert(sessionCwd === agentWorkspace,
      "agent session workspace was not the requested workspace: " + sanitized(sessionCwd));
    const policyService = ctx.get("sandboxPolicy");
    assert(typeof policyService?.resolve === "function",
      "official sandboxPolicy.resolve is unavailable for Git Bash workdir diagnostic");
    const resolvedPolicy = policyService.resolve({ session: agent.session });
    const policyWorkspaceRoot = resolvedPolicy?.workspaceRoot;
    assert(policyWorkspaceRoot === agentWorkspace,
      "official sandbox policy workspaceRoot differed from the agent workspace: " +
      sanitized(policyWorkspaceRoot));
    const tools = ctx.get("tools");
    assert(typeof tools?.get === "function" && tools.get("git_bash", agent) !== undefined,
      "official git_bash tool is not visible to the created agent");
    if (typeof agent.session?.append === "function") {
      agent.session.append("sandbox/mode", { mode: "danger-full-access" });
    }
    const execute = async (label, workdir, expected, forbidden) => {
      const extraArguments = {
        description: "Git Bash cwd diagnostic " + label,
        ...(workdir === undefined ? {} : { workdir }),
      };
      let result;
      let text = "";
      try {
        ({ result, text } = await executeOfficialRaw(
          ctx,
          agent,
          "git_bash",
          "printf 'pwd=%s\\n' \"$PWD\"; printf '__DSH_GIT_PWD_W_BEGIN__\\n'; pwd -W; printf '__DSH_GIT_PWD_W_END__\\n'",
          undefined,
          extraArguments,
        ));
      } catch (error) {
        return {
          label,
          requestedWorkdir: workdir ?? null,
          expectedGitBashCwd: expected,
          forbiddenHostGitBashCwd: forbidden,
          error: sanitized(error),
          matchesExpectedWorkspace: false,
          officialToolRuntime: true,
        };
      }
      if (result?.isError) {
        return {
          label,
          requestedWorkdir: workdir ?? null,
          expectedGitBashCwd: expected,
          forbiddenHostGitBashCwd: forbidden,
          error: sanitized(result.error?.message ?? text),
          matchesExpectedWorkspace: false,
          officialToolRuntime: true,
        };
      }
      const value = result.value;
      const output = text + "\n" + (value?.stdout?.text ?? "");
      const parsedPwdW = parseGitBashPwdW(output);
      const actualPwdW = parsedPwdW.length === 1 ? parsedPwdW[0] : null;
      const expectedNormalized = normalizeGitBashWindowsPath(expected);
      const forbiddenNormalized = normalizeGitBashWindowsPath(forbidden);
      const matchesExpectedWorkspace = value?.exitCode === 0
        && actualPwdW !== null
        && actualPwdW.normalized === expectedNormalized
        && actualPwdW.normalized !== forbiddenNormalized;
      return {
        label,
        requestedWorkdir: workdir ?? null,
        expectedGitBashCwd: expected,
        forbiddenHostGitBashCwd: forbidden,
        actualOutput: sanitized(output),
        parsedPwdW: parsedPwdW.map((entry) => entry.raw),
        actualGitBashCwd: actualPwdW?.raw ?? null,
        actualGitBashCwdNormalized: actualPwdW?.normalized ?? null,
        expectedGitBashCwdNormalized: expectedNormalized,
        forbiddenHostGitBashCwdNormalized: forbiddenNormalized,
        exitCode: value?.exitCode ?? null,
        matchesExpectedWorkspace,
        officialToolRuntime: true,
      };
    };
    const omitted = await execute("omitted", undefined, expectedWorkspace, expectedHost);
    const relative = await execute("relative", relativeName, expectedWorkspaceChild, expectedHostChild);
    const absolute = await execute("absolute", workspaceChild, expectedWorkspaceChild, expectedHostChild);
    assert(omitted.matchesExpectedWorkspace === true && relative.matchesExpectedWorkspace === true,
      "Git Bash workdir results did not resolve to the agent workspace: " +
      sanitized(JSON.stringify({ omitted, relative, absolute })));
    assert(absolute.matchesExpectedWorkspace === true,
      "Git Bash explicit absolute workdir did not resolve to the requested workspace child: " +
      sanitized(JSON.stringify(absolute)));
    assert(typeof originalSpawn === "function",
      "official subprocess.spawn is unavailable for namespace workdir rejection");
    const namespaceRejected = [];
    subprocess.spawn = function observedGitBashSpawn(spec) {
      namespaceRejected.push({ argv: [...spec.argv], cwd: spec.cwd });
      return originalSpawn.call(this, spec);
    };
    spawnSpyInstalled = true;
    const positiveBeforeSpawnCount = namespaceRejected.length;
    const positiveResponse = await executeOfficialRaw(
      ctx,
      agent,
      "git_bash",
      "printf 'git-positive-control\\n'",
      undefined,
      {
        description: "Git Bash namespace positive control",
        workdir: relativeName,
      },
    );
    if (positiveResponse.result?.isError) {
      throw new Error(positiveResponse.result.error?.message ?? positiveResponse.text);
    }
    const positiveValue = positiveResponse.result.value;
    const positiveOutput = `${positiveResponse.text}\n${positiveValue?.stdout?.text ?? ""}`;
    assert(positiveValue?.exitCode === 0,
      "Git Bash positive control failed: " + sanitized(positiveOutput));
    assert(namespaceRejected.length === positiveBeforeSpawnCount + 1,
      "Git Bash positive control did not observe exactly one forwarded spawn");
    const positiveControl = {
      requestedWorkdir: relativeName,
      actualOutput: sanitized(positiveOutput),
      exitCode: positiveValue.exitCode,
      observedSpawnCount: namespaceRejected.length - positiveBeforeSpawnCount,
      officialToolRuntime: true,
    };
    const invalidWorkdirs = [
      { label: "UNC", workdir: "\\\\server\\share" },
      { label: "device", workdir: "\\\\?\\C:\\outside" },
    ];
    const namespaceResults = [];
    for (const entry of invalidWorkdirs) {
      const beforeSpawnCount = namespaceRejected.length;
      let response;
      let thrown;
      try {
        response = await executeOfficialRaw(
          ctx,
          agent,
          "git_bash",
          "printf should-not-run",
          undefined,
          { description: "Git Bash namespace rejection " + entry.label, workdir: entry.workdir },
        );
      } catch (error) {
        thrown = error;
      }
      const value = response?.result?.value;
      const rejected = thrown !== undefined
        || response?.result?.isError === true
        || value?.exitCode === null
        || value?.exitCode === undefined
        || value?.exitCode !== 0;
      assert(rejected, entry.label + " namespace workdir was unexpectedly accepted");
      assert(namespaceRejected.length === beforeSpawnCount,
        entry.label + " namespace rejection spawned a child process");
      namespaceResults.push({
        label: entry.label,
        workdir: entry.workdir,
        rejected: true,
        thrown: thrown === undefined ? null : sanitized(thrown),
        exitCode: value?.exitCode ?? null,
        observedSpawnCount: namespaceRejected.length - beforeSpawnCount,
      });
    }
    subprocess.spawn = originalSpawn;
    spawnSpyInstalled = false;
    return {
      agentSessionWorkspace: sanitized(sessionCwd),
      policyWorkspaceRoot: sanitized(policyWorkspaceRoot),
      fixtureWorkspaceRoot: sanitized(WORKSPACE),
      agentWorkspace: sanitized(agentWorkspace),
      hostProcessCwd: sanitized(hostCwd),
      actualProcessCwd: sanitized(actualProcessCwd),
      workspace: sanitized(agentWorkspace),
      omitted,
      relative,
      absolute,
      positiveControl,
      namespaceResults,
      processCwdDistinctFromWorkspace: hostCwd !== WORKSPACE,
      processCwdDistinctFromAgentWorkspace: actualProcessCwd.toLowerCase() !== agentWorkspace.toLowerCase(),
      officialToolRuntime: true,
    };
  } finally {
    try {
      if (spawnSpyInstalled) subprocess.spawn = originalSpawn;
      if (handle?.dispose) await handle.dispose();
    } finally {
      removeIfPresent(workspaceChild);
      removeIfPresent(agentWorkspace);
      removeIfPresent(hostChild);
    }
  }
}

async function officialWslWorkdirBoundary(ctx, services) {
  const agents = ctx.get("agents");
  if (agents === undefined || typeof agents.create !== "function") {
    throw new CaseSkip("official agents service/factory is unavailable for WSL workdir boundary");
  }
  const child = ownedPath(WORKSPACE, `official-wsl-cwd 中文 space`);
  mkdirSync(child, { recursive: true });
  const childWsl = wslPath(child);
  const invalid = [
    { kind: "outside", workdir: `${WORKSPACE}\\..\\outside fixture 中文 space` },
    { kind: "outside-wsl", workdir: wslPath(OUTSIDE) },
    { kind: "different-drive", workdir: "D:\\dsh-cli-outside" },
    { kind: "UNC", workdir: "\\\\server\\share" },
    { kind: "device", workdir: "\\\\?\\C:\\outside" },
  ];
  let handle;
  let installedSpy = false;
  const originalSpawn = services.subprocess?.spawn;
  try {
    assert(typeof originalSpawn === "function", "official subprocess spawn API is unavailable for WSL workdir boundary");
    handle = await createProbeAgent(ctx, { sessionId: randomUUID(), meta: { cwd: WORKSPACE } });
    const agent = handle?.agent;
    assert(agent !== undefined, "official agent factory returned no agent for WSL workdir boundary");
    if (typeof agent.session?.append === "function") {
      agent.session.append("sandbox/mode", { mode: MODE });
    }
    const calls = [];
    services.subprocess.spawn = function observedOfficialSpawn(spec) {
      calls.push({ argv: [...spec.argv], cwd: spec.cwd });
      return originalSpawn.call(this, spec);
    };
    installedSpy = true;
    const execute = async (workdir, label, expectAccepted) => {
      calls.length = 0;
      const markerPath = marker(`official-workdir-${MODE}-${label}`);
      removeIfPresent(markerPath);
      let response;
      let thrown;
      try {
        response = await executeOfficialRaw(
          ctx,
          agent,
          "wsl_bash",
          `printf 'official-workdir=${label} pwd=%s\\n' "$PWD"; test ! -e ${bashQuote(wslPath(markerPath))}`,
          undefined,
          { description: `official WSL workdir ${label}`, workdir },
        );
      } catch (error) {
        thrown = error;
      }
      const commandSpawnCount = calls.filter((call) => call.argv.includes("/usr/bin/bwrap")).length;
      const text = response?.text ?? "";
      const value = response?.result?.value;
      if (!expectAccepted) {
        const rejected = thrown !== undefined
          || response?.result?.isError === true
          || value?.exitCode === null
          || value?.exitCode === undefined
          || value?.exitCode !== 0;
        assert(rejected, `${label} invalid workdir was unexpectedly accepted`);
        assert(commandSpawnCount === 0, `${label} official invalid workdir spawned ${commandSpawnCount} command process(es)`);
        assert(!existsSync(markerPath), `${label} invalid workdir created an outside marker`);
        return {
          workdir: label,
          rejected: true,
          thrown: thrown === undefined ? undefined : sanitized(thrown),
          failure: value?.exitCode === null ? "rejected" : response?.result?.isError === true ? "tool-error" : undefined,
          observedSpawnCount: calls.length,
          commandSpawnCount,
        };
      }
      if (thrown !== undefined) {
        throw new Error(`${label} official accepted workdir threw before execution: ${sanitized(thrown)}`);
      }
      assert(response?.result?.isError !== true, `${label} official WSL tool returned an error: ${sanitized(text)}`);
      assert(value?.exitCode === 0, `${label} official WSL workdir failed: ${sanitized(text)}`);
      const outputText = `${text}\n${value?.stdout?.text ?? ""}`;
      assert(outputText.includes(`pwd=${childWsl}`), `${label} official WSL cwd was not canonical: ${sanitized(outputText)}`);
      assert(commandSpawnCount === 1, `${label} official WSL valid workdir spawned ${commandSpawnCount} command process(es)`);
      removeIfPresent(markerPath);
      return {
        workdir: label,
        accepted: true,
        exitCode: value.exitCode,
        canonicalCwd: childWsl,
        observedSpawnCount: calls.length,
        commandSpawnCount,
        officialToolRuntime: true,
      };
    };
    const equivalent = [
      await execute(child, "windows", true),
      await execute(childWsl, "wsl", true),
    ];
    const rejected = [];
    for (const entry of invalid) rejected.push(await execute(entry.workdir, entry.kind, false));
    for (const entry of rejected) {
      assert(entry.rejected === true, `${entry.workdir} was unexpectedly accepted`);
      assert(entry.commandSpawnCount === 0, `${entry.workdir} invalid workdir launched a command`);
    }
    return {
      equivalent,
      rejected,
      commandSpawnCountForInvalid: rejected.map((entry) => entry.commandSpawnCount),
      officialToolRuntime: true,
    };
  } finally {
    try {
      if (installedSpy) services.subprocess.spawn = originalSpawn;
    } finally {
      try {
        if (handle?.dispose) await handle.dispose();
      } finally {
        removeIfPresent(child);
      }
    }
  }
}

async function powerShellTool(ctx) {
  const agents = ctx.get("agents");
  if (agents === undefined || typeof agents.create !== "function") {
    throw new CaseSkip("official agents service/factory is unavailable for the PowerShell probe");
  }
  const tools = ctx.get("tools");
  let handle;
  try {
    handle = await createProbeAgent(ctx, { sessionId: randomUUID(), meta: { cwd: WORKSPACE } });
    const agent = handle?.agent;
    assert(agent !== undefined, "official agent factory returned no agent for PowerShell");
    assert(typeof tools.get === "function" && tools.get("pwsh", agent) !== undefined,
      "official PowerShell tool is not visible to the created agent");
    const result = await executeOfficialTool(
      ctx,
      agent,
      "pwsh",
      "Write-Output dsh-pwsh-ready",
      undefined,
      { description: "Print a local readiness value" },
    );
    assert(result.text.includes("dsh-pwsh-ready"), "official PowerShell tool returned no readiness output");
    return { tool: "pwsh", usable: true, businessCommand: false, ...desktopPresetEvidence() };
  } finally {
    if (handle?.dispose) await handle.dispose();
  }
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

async function doctorReadOnly(api, ctx) {
  const manifest = process.env.DSH_PROBE_PROFILE_MANIFEST;
  const installAnchor = ctx.get("profileContext")?.installAnchor;
  if (typeof manifest !== "string" || typeof installAnchor !== "string") {
    throw new CaseSkip("profile manifest or installAnchor is unavailable for the doctor probe");
  }
  const before = sha256File(manifest);
  const report = await api.doctor.runDoctor({
    platform: "win32",
    installAnchor,
    distro: process.env.DSH_WSL_DISTRO ?? "Ubuntu",
    workspaceRoot: WORKSPACE,
  });
  const after = sha256File(manifest);
  assert(before === after, "Windows doctor changed the isolated profile manifest");
  assert(report.ok === true, `Windows doctor reported FAIL: ${sanitized(JSON.stringify(report.checks))}`);
  return {
    ok: report.ok,
    profileManifestHashStable: true,
    failedChecks: report.checks.filter((check) => check.status === "fail").map((check) => check.id),
  };
}

async function officialPersistentCancellation(ctx) {
  const agents = ctx.get("agents");
  if (agents === undefined || typeof agents.create !== "function") {
    throw new CaseSkip("official agents service/factory is unavailable for cancellation");
  }
  const startedMarker = ownedPath(WORKSPACE, `official-cancel-started-${MODE}.marker`);
  const leakMarker = ownedPath(WORKSPACE, `official-cancel-leak-${MODE}.marker`);
  const backgroundReadyMarker = ownedPath(WORKSPACE, `official-cancel-background-ready-${MODE}.marker`);
  const releaseMarker = ownedPath(WORKSPACE, `official-cancel-release-${MODE}.marker`);
  const backgroundDiagnosticPath = ownedPath(WORKSPACE, `official-cancel-background-${MODE}.log`);
  const backgroundDiagnosticShell = shellPath(backgroundDiagnosticPath);
  removeIfPresent(startedMarker);
  removeIfPresent(leakMarker);
  removeIfPresent(backgroundReadyMarker);
  removeIfPresent(releaseMarker);
  removeIfPresent(backgroundDiagnosticPath);
  let handle;
  let spawnObservation;
  let sessionObservation;
  let nativeTree;
  let nativeResetTree;
  const observerIdentity = PERSISTENT_SHELL === "git-bash"
    ? processCreationIdentity(windowsProcess(process.pid))
    : null;
  const managedObservation = PERSISTENT_SHELL === "wsl"
    ? observeWslManagedSubprocesses(ctx)
    : undefined;
  try {
    handle = await createProbeAgent(ctx, { sessionId: randomUUID(), meta: { cwd: WORKSPACE } });
    const agent = handle?.agent;
    assert(agent !== undefined, "official agent factory returned no agent for cancellation");
    authorizePersistentShell(agent);
    sessionObservation = observeTerminalSessions(ctx);
    if (PERSISTENT_SHELL === "git-bash") {
      spawnObservation = observeNativeSpawner(ctx);
      const bootstrap = await executeOfficialRaw(ctx, agent, "bash", "printf 'cancel-bootstrap\\n'");
      assert(bootstrap.result?.isError !== true && bootstrap.text.includes("cancel-bootstrap"),
        `native cancellation bootstrap failed: ${sanitized(bootstrap.text)}`);
      nativeTree = await waitForNativeTree(spawnObservation, sessionObservation, "cancellation");
    }
    const controller = new AbortController();
    const command = [
      `export DSH_CLI_CANCEL_STATE=stale`,
      `printf started > ${bashQuote(shellPath(startedMarker))}`,
      `(while [ ! -f ${bashQuote(shellPath(releaseMarker))} ]; do sleep 0.02; done; sleep 2; printf leaked > ${bashQuote(shellPath(leakMarker))}) & child=$!`,
      `child_winpid=; for attempt in 1 2 3 4 5 6 7 8 9 10; do IFS= read -r child_winpid </proc/$child/winpid 2>/dev/null; [ -n \"$child_winpid\" ] && break; sleep 0.05; done`,
      `printf 'child_pid=%s child_winpid=%s prepared_ms=%s\\n' \"$child\" \"$child_winpid\" \"$(date +%s%3N)\" > ${bashQuote(backgroundDiagnosticShell)}`,
      `printf cancel-background-ready > ${bashQuote(shellPath(backgroundReadyMarker))}`,
      `while [ ! -f ${bashQuote(shellPath(releaseMarker))} ]; do sleep 0.02; done`,
      `wait \"$child\"`,
    ].join("; ");
    let settled;
    const pending = executeOfficialRaw(ctx, agent, "bash", command, controller.signal)
      .then((value) => ({ ok: true, value }), (error) => ({ ok: false, error }))
      .then((value) => { settled = value; return value; });
    const deadline = Date.now() + 5_000;
    while ((!existsSync(startedMarker)
      || (PERSISTENT_SHELL === "git-bash" && !existsSync(backgroundReadyMarker)))
      && settled === undefined && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert(existsSync(startedMarker), `official cancellation command never reached its ready marker${settled?.error ? `: ${sanitized(settled.error)}` : ""}`);
    assert(PERSISTENT_SHELL !== "git-bash" || existsSync(backgroundReadyMarker),
      `native cancellation command never published its pre-abort background identity${settled?.error ? `: ${sanitized(settled.error)}` : ""}`);
    let nativeBackground;
    let backgroundPid;
    let backgroundMsysPid;
    let preparedAt;
    const backgroundDiagnostic = existsSync(backgroundDiagnosticPath)
      ? readFileSync(backgroundDiagnosticPath, "utf8")
      : "";
    if (PERSISTENT_SHELL === "git-bash") {
      const pidMatch = /child_pid=(\d+)\s+child_winpid=(\d+)\s+prepared_ms=(\d+)/.exec(backgroundDiagnostic);
      assert(pidMatch !== null,
        `native cancellation background diagnostic lacked /proc/$!/winpid: ${sanitized(backgroundDiagnostic)}`);
      backgroundMsysPid = Number(pidMatch[1]);
      backgroundPid = Number(pidMatch[2]);
      preparedAt = Number(pidMatch[3]);
      assert(Number.isSafeInteger(backgroundMsysPid) && backgroundMsysPid > 0
        && Number.isSafeInteger(backgroundPid) && backgroundPid > 0
        && Number.isSafeInteger(preparedAt) && preparedAt > 0,
      `native cancellation background diagnostic had invalid identity/timestamp: ${sanitized(backgroundDiagnostic)}`);
      const backgroundRow = windowsProcess(backgroundPid);
      assert(backgroundRow !== undefined,
        `native cancellation background exited before pre-abort identity capture: ${sanitized(JSON.stringify({ backgroundPid, backgroundDiagnostic }))}`);
      nativeBackground = sanitizedProcessRow(backgroundRow);
      assert(nativeTree.topDescendants.some((row) => Number(row.ProcessId) === backgroundPid)
        || Number(backgroundRow.ParentProcessId) === nativeTree.shellPid,
      `native cancellation background was not rooted in the owned Git Bash tree: ${sanitized(JSON.stringify({ backgroundRow, topDescendants: nativeTree.topDescendants }))}`);
      addNativeOwnedRows(nativeTree, [backgroundRow]);
    }
    writeFileSync(releaseMarker, "release\n", "utf8");
    controller.abort(new Error("official cancellation probe"));
    const outcome = await pending;
    const cancellationDiagnostic = outcome.ok
      ? `${outcome.value?.text ?? ""} ${outcome.value?.result?.error?.message ?? ""}`
      : sanitized(outcome.error);
    const abortErrorInfo = outcome.ok ? outcome.value?.result?.error?.info : undefined;
    const rejectedAbortInfo = outcome.ok ? undefined : (outcome.error?.info ?? outcome.error);
    const typedEnvelopeAbort = outcome.ok === true
      && outcome.value?.result?.isError === true
      && controller.signal.aborted === true
      && abortErrorInfo?.name === "AbortError"
      && abortErrorInfo?.code === "ABORTED"
      && /abort/i.test(String(outcome.value?.result?.error?.message ?? ""));
    const rejectedAsAbort = outcome.ok === false
      && controller.signal.aborted === true
      && rejectedAbortInfo?.name === "AbortError"
      && rejectedAbortInfo?.code === "ABORTED";
    const emptyOutputAbort = outcome.ok === true
      && outcome.value?.result?.isError === true
      && outcome.value?.text === ""
      && controller.signal.aborted === true
      && abortErrorInfo?.name === "AbortError"
      && abortErrorInfo?.code === "ABORTED"
      && /abort|cancel/i.test(cancellationDiagnostic);
    const cancellationObserved = typedEnvelopeAbort || rejectedAsAbort || emptyOutputAbort;
    assert(cancellationObserved,
      `official cancellation did not satisfy the abort/empty-output contract: ${sanitized(JSON.stringify({ outcome, cancellationDiagnostic }))}`);
    const cancellationActivityCleared = await waitForNoOwnerActivity(ctx.get("terminals"), agent, 5_000);
    assert(cancellationActivityCleared, "official cancellation left owner terminal activity registered");
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    assert(!existsSync(leakMarker), "official cancellation left a background child alive");
    const reset = await executeOfficialTool(
      ctx,
      agent,
      "bash",
      "if [ \"${DSH_CLI_CANCEL_STATE-}\" = stale ]; then printf stale; else printf clean-reset; fi",
    );
    assert(reset.text.includes("clean-reset"), "official persistent bash retained cancelled shell state");
    if (PERSISTENT_SHELL === "git-bash") {
      nativeResetTree = await waitForNativeTree(spawnObservation, sessionObservation, "cancellation reset");
      const finalExit = await executeOfficialRaw(ctx, agent, "bash", "exit");
      assert(/shell exited|starts from the workspace|reset/i.test(finalExit.text),
        `native cancellation final shell exit was not reported: ${sanitized(finalExit.text)}`);
      const finalActivityCleared = await waitForNoOwnerActivity(ctx.get("terminals"), agent, 5_000);
      assert(finalActivityCleared, "native cancellation final shell exit left owner terminal activity registered");
      const managedSettlements = await settleObservedNativeHandles(spawnObservation, "cancellation");
      const afterDispose = [];
      for (const tree of [nativeTree, nativeResetTree]) {
        const after = await waitForNativeTreeGone(tree, 5_000);
        assert(after.remaining.length === 0 && after.helperDescendants.length === 0,
          `native cancellation left owned helper/ConPTY/Bash/background processes: ${sanitized(JSON.stringify(after))}`);
        afterDispose.push(after);
      }
      const observerAfter = observerIdentity === null ? undefined : processAtIdentity(observerIdentity);
      assert(observerAfter !== undefined, "native cancellation observer host exited before cleanup evidence was collected");
      const nativeTreesAfterDispose = [nativeTree, nativeResetTree].filter((tree) => tree !== undefined);
      const remaining = afterDispose.flatMap((entry) => entry.remaining);
      const helperChildren = afterDispose.flatMap((entry) => entry.helperDescendants);
      const processForPids = (pids) => remaining.find((entry) => pids.includes(Number(entry.identity?.pid)))?.process ?? null;
      const managedDone = managedSettlements.length > 0
        && managedSettlements.every((entry) => entry.doneError === null && entry.done !== null);
      const managedWaitForExit = managedSettlements.length > 0
        && managedSettlements.every((entry) => entry.waitError === null && entry.waitForExit === true);
      const nativeAfterDispose = {
        helper: processForPids(nativeTreesAfterDispose.map((tree) => tree.helperPid)),
        top: processForPids(nativeTreesAfterDispose.map((tree) => tree.topPid)),
        shell: processForPids(nativeTreesAfterDispose.map((tree) => tree.shellPid)),
        remaining,
        helperChildren,
        trees: afterDispose,
      };
      assert(managedDone && managedWaitForExit,
        `native cancellation managed handles did not settle cleanly: ${sanitized(JSON.stringify(managedSettlements))}`);
      return {
        started: true,
        aborted: true,
        controllerSignalAborted: controller.signal.aborted,
        cancellationDiagnostic: sanitized(cancellationDiagnostic),
        typedEnvelopeAbort,
        abortErrorInfo: abortErrorInfo === undefined ? null : abortErrorInfo,
        rejectionClassifiedAsAbort: rejectedAsAbort,
        emptyOutputAbort,
        leakMarkerCreated: false,
        resetVerified: true,
        cancellationActivityCleared: true,
        observerHostAliveAfterAbort: true,
        backgroundMsysPid,
        backgroundPid,
        preparedAt,
        backgroundDiagnostic: sanitized(backgroundDiagnostic),
        background: nativeBackground,
        nativeManagedSettlements: managedSettlements,
        nativeProcess: {
          managedDone,
          managedWaitForExit,
          observerHostAliveAfterExit: observerAfter !== undefined,
          observationError: null,
          initial: {
            helperPid: nativeTree.helperPid,
            topPid: nativeTree.topPid,
            shellPid: nativeTree.shellPid,
            helper: sanitizedProcessRow(nativeTree.helperIdentity),
            top: sanitizedProcessRow(nativeTree.topIdentity),
            shell: sanitizedProcessRow(nativeTree.shellIdentity),
            conhost: sanitizedProcessRow(nativeTree.conhostIdentity),
          },
          reset: {
            helperPid: nativeResetTree.helperPid,
            topPid: nativeResetTree.topPid,
            shellPid: nativeResetTree.shellPid,
            helper: sanitizedProcessRow(nativeResetTree.helperIdentity),
            top: sanitizedProcessRow(nativeResetTree.topIdentity),
            shell: sanitizedProcessRow(nativeResetTree.shellIdentity),
            conhost: sanitizedProcessRow(nativeResetTree.conhostIdentity),
          },
          afterDispose: nativeAfterDispose,
        },
      };
    }
    if (PERSISTENT_SHELL === "wsl") {
      const finalExit = await executeOfficialRaw(ctx, agent, "bash", "exit");
      assert(/shell exited|starts from the workspace|reset/i.test(finalExit.text),
        `WSL cancellation final shell exit was not reported: ${sanitized(finalExit.text)}`);
      const finalActivityCleared = await waitForNoOwnerActivity(ctx.get("terminals"), agent, 5_000);
      assert(finalActivityCleared, "WSL cancellation final shell exit left owner terminal activity registered");
      const managedSettlements = await settleObservedWslManagedHandles(managedObservation, "cancellation");
      const managedDone = managedSettlements.length > 0
        && managedSettlements.every((entry) => entry.doneError === null && entry.done !== null);
      const managedWaitForExit = managedSettlements.length > 0
        && managedSettlements.every((entry) => entry.waitError === null && entry.waitForExit === true);
      assert(managedDone && managedWaitForExit,
        `WSL cancellation managed handles did not settle cleanly: ${sanitized(JSON.stringify(managedSettlements))}`);
      return {
        started: true,
        aborted: true,
        controllerSignalAborted: controller.signal.aborted,
        cancellationDiagnostic: sanitized(cancellationDiagnostic),
        typedEnvelopeAbort,
        abortErrorInfo: abortErrorInfo === undefined ? null : abortErrorInfo,
        rejectionClassifiedAsAbort: rejectedAsAbort,
        emptyOutputAbort,
        leakMarkerCreated: false,
        resetVerified: true,
        cancellationActivityCleared: true,
        finalActivityCleared,
        publicSession: publicWslSessionEvidence(sessionObservation),
        managedSettlements,
        managedDone,
        managedWaitForExit,
        observationError: null,
      };
    }
    return {
      started: true,
      aborted: true,
      controllerSignalAborted: controller.signal.aborted,
      cancellationDiagnostic: sanitized(cancellationDiagnostic),
      typedEnvelopeAbort,
      abortErrorInfo: abortErrorInfo === undefined ? null : abortErrorInfo,
      rejectionClassifiedAsAbort: rejectedAsAbort,
      emptyOutputAbort: emptyOutputAbort,
      leakMarkerCreated: false,
      resetVerified: true,
    };
  } finally {
    sessionObservation?.restore();
    spawnObservation?.restore();
    managedObservation?.restore();
    try {
      if (handle?.dispose) await handle.dispose();
    } finally {
      for (const tree of [nativeTree, nativeResetTree].filter((value) => value !== undefined)) {
        try { await waitForNativeTreeGone(tree, 5_000); } catch {}
      }
      try {
        removeIfPresent(startedMarker);
      } finally {
        try {
          removeIfPresent(leakMarker);
        } finally {
          try {
            removeIfPresent(backgroundReadyMarker);
          } finally {
            try {
              removeIfPresent(releaseMarker);
            } finally {
              removeIfPresent(backgroundDiagnosticPath);
            }
          }
        }
      }
    }
  }
}

async function officialPersistentTimeoutReset(ctx) {
  const agents = ctx.get("agents");
  if (agents === undefined || typeof agents.create !== "function") {
    throw new CaseSkip("official agents service/factory is unavailable for timeout reset");
  }
  const startedMarker = ownedPath(WORKSPACE, `official-timeout-started-${MODE}.marker`);
  const leakMarker = ownedPath(WORKSPACE, `official-timeout-leak-${MODE}.marker`);
  const timeoutCwd = ownedPath(WORKSPACE, `persistent-timeout-cwd ${MODE}`);
  const timeoutDiagnosticPath = ownedPath(WORKSPACE, `persistent-timeout-diagnostic-${MODE}.log`);
  const timeoutDiagnosticShell = shellPath(timeoutDiagnosticPath);
  const expectedWorkspace = shellPath(WORKSPACE);
  const delayedChildSeconds = 12;
  const timeoutObservationMs = delayedChildSeconds * 1_000 + 1_000;
  removeIfPresent(startedMarker);
  removeIfPresent(leakMarker);
  removeIfPresent(timeoutCwd);
  removeIfPresent(timeoutDiagnosticPath);
  let handle;
  let sessionObservation;
  let spawnObservation;
  const nativeTrees = [];
  const observerIdentity = PERSISTENT_SHELL === "git-bash"
    ? processCreationIdentity(windowsProcess(process.pid))
    : null;
  const managedObservation = PERSISTENT_SHELL === "wsl"
    ? observeWslManagedSubprocesses(ctx)
    : undefined;
  try {
    handle = await createProbeAgent(ctx, { sessionId: randomUUID(), meta: { cwd: WORKSPACE } });
    const agent = handle?.agent;
    assert(agent !== undefined, "official agent factory returned no agent for timeout reset");
    authorizePersistentShell(agent);
    const terminals = ctx.get("terminals");
    assert(typeof terminals?.list === "function", "official terminal list API is unavailable for timeout reset");
    sessionObservation = observeTerminalSessions(ctx);
    if (PERSISTENT_SHELL === "git-bash") spawnObservation = observeNativeSpawner(ctx);
    if (PERSISTENT_SHELL === "git-bash") {
      const bootstrap = await executeOfficialRaw(ctx, agent, "bash", "printf 'timeout-bootstrap\\n'");
      assert(bootstrap.result?.isError !== true && bootstrap.text.includes("timeout-bootstrap"),
        `native timeout bootstrap failed: ${sanitized(bootstrap.text)}`);
      nativeTrees.push(await waitForNativeTree(spawnObservation, sessionObservation, "timeout"));
    }
    const shellWinPidPs = "ps -p $$ -o winpid= 2>/dev/null | tr -d '[:space:]'";
    const shellWinPidProc = "cat /proc/$$/winpid 2>/dev/null | tr -d '[:space:]'";
    const command = [
      `mkdir -p ${bashQuote(shellPath(timeoutCwd))}`,
      `cd ${bashQuote(shellPath(timeoutCwd))}`,
      "export DSH_CLI_TIMEOUT_STATE=stale",
      `shell_pid=$$; shell_winpid_ps=$(${shellWinPidPs}); shell_winpid_proc=$(${shellWinPidProc})`,
      `printf 'timeout_start_ms=%s shell_pid=%s shell_winpid_ps=%s shell_winpid_proc=%s\\n' "$(date +%s%3N)" "$shell_pid" "$shell_winpid_ps" "$shell_winpid_proc" > ${bashQuote(timeoutDiagnosticShell)}`,
      `printf 'timeout-ready\\n' > ${bashQuote(shellPath(startedMarker))}`,
      `(sleep ${delayedChildSeconds}; printf 'leak_ms=%s\\n' "$(date +%s%3N)" >> ${bashQuote(timeoutDiagnosticShell)}; printf leaked > ${bashQuote(shellPath(leakMarker))}) & leak=$!`,
      `child_winpid_ps=$(ps -p "$leak" -o winpid= 2>/dev/null | tr -d '[:space:]'); child_winpid_proc=$(cat /proc/$leak/winpid 2>/dev/null | tr -d '[:space:]'); printf 'child_pid=%s child_winpid_ps=%s child_winpid_proc=%s\\n' "$leak" "$child_winpid_ps" "$child_winpid_proc" >> ${bashQuote(timeoutDiagnosticShell)}`,
      'wait "$leak"',
    ].join("; ");
    let outcome;
    let timeoutSettled;
    let timeoutBackground;
    let timeoutBackgroundPid;
    let timeoutBackgroundMsysPid;
    let timeoutPreparedAt;
    if (PERSISTENT_SHELL === "git-bash") {
      const timeoutPending = executeOfficialRaw(ctx, agent, "bash", command)
        .then((value) => ({ ok: true, value }), (error) => ({ ok: false, error }));
      const readyDeadline = Date.now() + 5_000;
      while (!existsSync(startedMarker) && Date.now() < readyDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert(existsSync(startedMarker), "native persistent timeout command did not reach its readiness marker before identity capture");
      const diagnosticDeadline = Date.now() + 2_000;
      let timeoutDiagnosticBefore = "";
      let timeoutMatch;
      while (Date.now() < diagnosticDeadline) {
        timeoutDiagnosticBefore = existsSync(timeoutDiagnosticPath)
          ? readFileSync(timeoutDiagnosticPath, "utf8")
          : "";
        timeoutMatch = /child_pid=(\d+)\s+child_winpid_(?:ps|proc)=(\d+)\s+/.exec(timeoutDiagnosticBefore);
        if (timeoutMatch !== null) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const procMatch = /child_pid=(\d+)\s+child_winpid_ps=([^\s]*)\s+child_winpid_proc=(\d+)\s+/.exec(timeoutDiagnosticBefore);
      assert(procMatch !== null,
        `native timeout diagnostic did not publish /proc/$!/winpid before timeout: ${sanitized(timeoutDiagnosticBefore)}`);
      timeoutBackgroundMsysPid = Number(procMatch[1]);
      timeoutBackgroundPid = Number(procMatch[3]);
      timeoutPreparedAt = Number((/timeout_start_ms=(\d+)/.exec(timeoutDiagnosticBefore) ?? [])[1]);
      assert(Number.isSafeInteger(timeoutBackgroundMsysPid) && timeoutBackgroundMsysPid > 0
        && Number.isSafeInteger(timeoutBackgroundPid) && timeoutBackgroundPid > 0
        && Number.isSafeInteger(timeoutPreparedAt) && timeoutPreparedAt > 0,
      `native timeout diagnostic had invalid identity/timestamp: ${sanitized(timeoutDiagnosticBefore)}`);
      const backgroundRow = windowsProcess(timeoutBackgroundPid);
      assert(backgroundRow !== undefined,
        `native timeout background exited before identity capture: ${sanitized(JSON.stringify({ timeoutBackgroundPid, timeoutDiagnosticBefore }))}`);
      timeoutBackground = sanitizedProcessRow(backgroundRow);
      assert(nativeTrees[0].topDescendants.some((row) => Number(row.ProcessId) === timeoutBackgroundPid)
        || Number(backgroundRow.ParentProcessId) === nativeTrees[0].shellPid,
      `native timeout background was not rooted in the owned Git Bash tree: ${sanitized(JSON.stringify({ backgroundRow, topDescendants: nativeTrees[0].topDescendants }))}`);
      addNativeOwnedRows(nativeTrees[0], [backgroundRow]);
      timeoutSettled = await timeoutPending;
      assert(timeoutSettled.ok, `native persistent timeout tool rejected unexpectedly: ${sanitized(timeoutSettled.error)}`);
      outcome = timeoutSettled.value;
    } else {
      outcome = await executeOfficialRaw(ctx, agent, "bash", command);
    }
    assert(outcome.result?.isError !== true,
      `official persistent timeout returned a tool error: ${sanitized(outcome.text)}`);
    assert(/Your command timed out after \d+ seconds or experienced an OOM error/i.test(outcome.text)
      && outcome.text.includes("[Command timed out or OOM]")
      && outcome.text.includes("The persistent bash shell was reset; the next bash call starts from the workspace"),
      `official persistent timeout was not reported: ${sanitized(outcome.text)}`);
    assert(existsSync(startedMarker), "persistent timeout command did not reach its readiness marker");
    const timeoutActivityCleared = await waitForNoOwnerActivity(terminals, agent);
    assert(timeoutActivityCleared, "persistent timeout left owner terminal activity registered");
    await new Promise((resolve) => setTimeout(resolve, timeoutObservationMs));
    const timeoutDiagnostic = existsSync(timeoutDiagnosticPath)
      ? readFileSync(timeoutDiagnosticPath, "utf8")
      : "<missing>";
    assert(!existsSync(leakMarker),
      `persistent timeout left a background child alive: diagnostic=${sanitized(timeoutDiagnostic)} publicSessions=${sanitized(JSON.stringify(sessionObservation?.calls ?? []))}`);
    const resetPwdProbe = PERSISTENT_SHELL === "git-bash" ? "pwd -W" : "printf '%s' \"$PWD\"";
    const expectedResetCwd = PERSISTENT_SHELL === "git-bash"
      ? gitBashWindowsPath(WORKSPACE)
      : expectedWorkspace;
    const normalizeResetCwd = (value) => PERSISTENT_SHELL === "git-bash"
      ? value.replaceAll("\\", "/").replace(/(?:\r\n|\r|\n)+$/u, "").toLowerCase()
      : value.replaceAll("\\", "/");
    const assertResetCwd = (label, text, state) => {
      assert(text.includes(state), `official bash after ${label} did not report clean state: ${sanitized(text)}`);
      const match = /pwd=([^\r\n]*)/.exec(text);
      const observed = match?.[1];
      assert(observed !== undefined && normalizeResetCwd(observed) === normalizeResetCwd(expectedResetCwd),
        `official bash after ${label} did not reset cwd: expected=${sanitized(expectedResetCwd)} observed=${sanitized(observed ?? "<missing>")} text=${sanitized(text)} diagnostic=${sanitized(timeoutDiagnostic)} publicSessions=${sanitized(JSON.stringify(sessionObservation?.calls ?? []))}`);
    };
    const reset = await executeOfficialRaw(
      ctx,
      agent,
      "bash",
      `printf "state=%s pwd=%s\\n" "\${DSH_CLI_TIMEOUT_STATE-clean}" "\$(${resetPwdProbe})"`,
    );
    assert(!reset.result?.isError, `official bash after timeout failed: ${sanitized(reset.text)}`);
    assertResetCwd("timeout", reset.text, "state=clean");
    if (PERSISTENT_SHELL === "git-bash") {
      nativeTrees.push(await waitForNativeTree(spawnObservation, sessionObservation, "timeout reset"));
    }
    const naturalExit = await executeOfficialRaw(ctx, agent, "bash", "export DSH_CLI_NATURAL=stale; exit");
    assert(/shell exited|starts from the workspace|reset/i.test(naturalExit.text),
      `official persistent natural exit was not reported: ${sanitized(naturalExit.text)}`);
    const naturalActivityCleared = await waitForNoOwnerActivity(terminals, agent);
    assert(naturalActivityCleared, "natural persistent shell exit left owner activity registered");
    const naturalReset = await executeOfficialRaw(
      ctx,
      agent,
      "bash",
      `printf "natural=%s pwd=%s\\n" "\${DSH_CLI_NATURAL-clean}" "\$(${resetPwdProbe})"`,
    );
    assert(!naturalReset.result?.isError, `official bash after natural exit failed: ${sanitized(naturalReset.text)}`);
    assertResetCwd("natural exit", naturalReset.text, "natural=clean");
    if (PERSISTENT_SHELL === "git-bash") {
      nativeTrees.push(await waitForNativeTree(spawnObservation, sessionObservation, "natural reset"));
    }
    let nativeManagedSettlements;
    let nativeAfterDispose;
    let nativeFinalActivityCleared = false;
    let observerHostAliveAfterTimeout;
    if (PERSISTENT_SHELL === "git-bash") {
      const finalExit = await executeOfficialRaw(ctx, agent, "bash", "exit");
      assert(/shell exited|starts from the workspace|reset/i.test(finalExit.text),
        `native timeout final shell exit was not reported: ${sanitized(finalExit.text)}`);
      nativeFinalActivityCleared = await waitForNoOwnerActivity(terminals, agent, 5_000);
      assert(nativeFinalActivityCleared, "native timeout final shell exit left owner terminal activity registered");
      nativeManagedSettlements = await settleObservedNativeHandles(spawnObservation, "timeout");
      nativeAfterDispose = [];
      for (const tree of nativeTrees) {
        const after = await waitForNativeTreeGone(tree, 5_000);
        assert(after.remaining.length === 0 && after.helperDescendants.length === 0,
          `native timeout/reset left owned helper/ConPTY/Bash/background processes: ${sanitized(JSON.stringify(after))}`);
        nativeAfterDispose.push(after);
      }
      observerHostAliveAfterTimeout = observerIdentity === null
        ? false
        : processAtIdentity(observerIdentity) !== undefined;
      assert(observerHostAliveAfterTimeout, "native timeout observer host exited before cleanup evidence was collected");
      const remaining = nativeAfterDispose.flatMap((entry) => entry.remaining);
      const helperChildren = nativeAfterDispose.flatMap((entry) => entry.helperDescendants);
      const processForPids = (pids) => remaining.find((entry) => pids.includes(Number(entry.identity?.pid)))?.process ?? null;
      const treePids = nativeTrees;
      const managedDone = nativeManagedSettlements.length > 0
        && nativeManagedSettlements.every((entry) => entry.doneError === null && entry.done !== null);
      const managedWaitForExit = nativeManagedSettlements.length > 0
        && nativeManagedSettlements.every((entry) => entry.waitError === null && entry.waitForExit === true);
      const nativeAfterDisposeSummary = {
        helper: processForPids(treePids.map((tree) => tree.helperPid)),
        top: processForPids(treePids.map((tree) => tree.topPid)),
        shell: processForPids(treePids.map((tree) => tree.shellPid)),
        remaining,
        helperChildren,
        trees: nativeAfterDispose,
      };
      assert(managedDone && managedWaitForExit,
        `native timeout managed handles did not settle cleanly: ${sanitized(JSON.stringify(nativeManagedSettlements))}`);
      nativeAfterDispose = nativeAfterDisposeSummary;
    }
    if (spawnObservation !== undefined) {
      assert(spawnObservation.calls.length >= 1, "native timeout/reset path did not observe any helper spawn");
      for (const call of spawnObservation.calls) {
        const argv = call.argv.map((value) => String(value));
        assert(argv.length === 3
          && String(argv[0]).toLowerCase().endsWith("\\node.exe")
          && /pty-helper\.js$/i.test(argv[1])
          && call.stdio?.control === "pipe"
          && !hasForbiddenNativeWrapper(argv),
        `native timeout/reset helper argv was not the private Node transport: ${sanitized(JSON.stringify({ argv, stdio: call.stdio }))}`);
      }
    }
    let managedSettlements;
    let managedDone;
    let managedWaitForExit;
    let finalActivityCleared;
    if (PERSISTENT_SHELL === "wsl") {
      const finalExit = await executeOfficialRaw(ctx, agent, "bash", "exit");
      assert(/shell exited|starts from the workspace|reset/i.test(finalExit.text),
        `WSL timeout final shell exit was not reported: ${sanitized(finalExit.text)}`);
      finalActivityCleared = await waitForNoOwnerActivity(terminals, agent, 5_000);
      assert(finalActivityCleared, "WSL timeout final shell exit left owner terminal activity registered");
      managedSettlements = await settleObservedWslManagedHandles(managedObservation, "timeout");
      managedDone = managedSettlements.length > 0
        && managedSettlements.every((entry) => entry.doneError === null && entry.done !== null);
      managedWaitForExit = managedSettlements.length > 0
        && managedSettlements.every((entry) => entry.waitError === null && entry.waitForExit === true);
      assert(managedDone && managedWaitForExit,
        `WSL timeout managed handles did not settle cleanly: ${sanitized(JSON.stringify(managedSettlements))}`);
    }
    return {
       timeoutMs: 10_000,
       delayedChildSeconds,
       cleanupObservationMs: timeoutObservationMs,
      ready: true,
      timedOut: true,
      timeoutDiagnostic: sanitized(outcome.text),
      processDiagnostic: sanitized(timeoutDiagnostic),
       publicSession: PERSISTENT_SHELL === "wsl"
         ? publicWslSessionEvidence(sessionObservation)
         : sessionObservation?.calls ?? [],
      ...(spawnObservation === undefined ? {} : {
        nativeHelpers: spawnObservation.calls.map((call) => ({
          argv: call.argv.map((value) => sanitized(value)),
          controlPipe: call.stdio?.control === "pipe",
        })),
      }),
       ...(PERSISTENT_SHELL === "git-bash" ? {
         timeoutBackgroundMsysPid,
         timeoutBackgroundPid,
         timeoutPreparedAt,
         timeoutBackground,
         observerHostAliveAfterTimeout,
         nativeManagedSettlements,
         nativeProcess: {
           managedDone: nativeManagedSettlements.length > 0
             && nativeManagedSettlements.every((entry) => entry.doneError === null && entry.done !== null),
           managedWaitForExit: nativeManagedSettlements.length > 0
             && nativeManagedSettlements.every((entry) => entry.waitError === null && entry.waitForExit === true),
           observerHostAliveAfterExit: observerHostAliveAfterTimeout,
           observationError: null,
           trees: nativeTrees.map((tree) => ({
             helperPid: tree.helperPid,
             topPid: tree.topPid,
             shellPid: tree.shellPid,
             helper: sanitizedProcessRow(tree.helperIdentity),
             top: sanitizedProcessRow(tree.topIdentity),
             shell: sanitizedProcessRow(tree.shellIdentity),
             conhost: sanitizedProcessRow(tree.conhostIdentity),
           })),
           afterDispose: nativeAfterDispose,
         },
       } : {}),
       ...(PERSISTENT_SHELL === "wsl" ? {
         managedSettlements,
         managedDone,
         managedWaitForExit,
         finalActivityCleared,
         observationError: null,
       } : {}),
      leakMarkerCreated: false,
      cleanReset: true,
      cwdReset: true,
      timeoutOwnerActivityCleared: true,
      naturalExit: true,
      naturalOwnerActivityCleared: true,
      naturalCleanReset: true,
      ...desktopPresetEvidence(),
    };
  } finally {
    sessionObservation?.restore();
    spawnObservation?.restore();
    managedObservation?.restore();
    try {
      if (handle?.dispose) await handle.dispose();
    } finally {
      for (const tree of nativeTrees) {
        try { await waitForNativeTreeGone(tree, 5_000); } catch {}
      }
      try {
        removeIfPresent(startedMarker);
      } finally {
        try {
          removeIfPresent(leakMarker);
        } finally {
          try {
            removeIfPresent(timeoutCwd);
          } finally {
            removeIfPresent(timeoutDiagnosticPath);
          }
        }
      }
    }
  }
}

async function officialPersistentOutputBound(ctx) {
  const agents = ctx.get("agents");
  if (agents === undefined || typeof agents.create !== "function") {
    throw new CaseSkip("official agents service/factory is unavailable for output bound");
  }
  let handle;
  let spawnObservation;
  let operationObservation;
  let retainedSpawnObservation;
  let diagnosticEvidence;
  try {
    handle = await createProbeAgent(ctx, { sessionId: randomUUID(), meta: { cwd: WORKSPACE } });
    const agent = handle?.agent;
    assert(agent !== undefined, "official agent factory returned no agent for output bound");
    authorizePersistentShell(agent);
    spawnObservation = PERSISTENT_SHELL === "git-bash"
      ? observeNativeSpawner(ctx)
      : observeWslManagedSubprocesses(ctx);
    operationObservation = observeTerminalOperations(ctx, agent);
    const stepRecords = [];
    const runStep = async (label, command, options = {}) => {
      const startedAt = Date.now();
      const readIntervalMs = options.readIntervalMs
        ?? (NATIVE_07_DIAGNOSTIC_ONLY ? 100 : 500);
      const terminalBefore = publicTerminalSnapshot(ctx, agent);
      const operationStartIndex = operationObservation?.calls.length ?? 0;
      const publicReads = [];
      let readBusy = false;
      const capturePublicRead = async () => {
        if (!NATIVE_07_PUBLIC_READS) return;
        if (readBusy) return;
        readBusy = true;
        try {
          const terminals = ctx.get("terminals");
          if (typeof terminals?.read !== "function") return;
          const snapshot = publicTerminalSnapshot(ctx, agent);
          for (const entry of snapshot.entries ?? []) {
            try {
              const read = await terminals.read(agent, entry.sessionId, { count: 40 });
              publicReads.push({
                at: Date.now(),
                offsetMs: Date.now() - startedAt,
                sessionId: entry.sessionId,
                status: entry.status,
                read: {
                  totalLines: read?.totalLines ?? null,
                  lineBegin: read?.lineBegin ?? null,
                  lineEnd: read?.lineEnd ?? null,
                  truncated: read?.truncated === true,
                  text: outputFragment(read?.text),
                },
              });
            } catch (error) {
              publicReads.push({
                at: Date.now(),
                offsetMs: Date.now() - startedAt,
                sessionId: entry.sessionId,
                status: entry.status,
                error: sanitized(error),
              });
            }
          }
        } finally {
          readBusy = false;
        }
      };
      await capturePublicRead();
      const readTimer = NATIVE_07_PUBLIC_READS
        ? setInterval(() => { void capturePublicRead(); }, readIntervalMs)
        : undefined;
      appendCaseDiagnostic("output-bound.step.begin", {
        label,
        command: sanitized(command),
        terminal: terminalBefore,
      });
      let outcome;
      let failure;
      try {
        outcome = await executeOfficialRaw(ctx, agent, "bash", command);
      } catch (error) {
        failure = error;
      } finally {
        if (readTimer !== undefined) clearInterval(readTimer);
        await capturePublicRead();
      }
      const terminalAfter = publicTerminalSnapshot(ctx, agent);
      const operationEndIndex = operationObservation?.calls.length
        ?? operationStartIndex;
      const operationCalls = operationObservation?.calls.slice(
        operationStartIndex,
        operationEndIndex,
      ) ?? [];
      const operationSessionId = terminalBefore.entries?.[0]?.sessionId
        ?? terminalAfter.entries?.[0]?.sessionId
        ?? operationCalls[0]?.sessionId
        ?? null;
      const record = {
        label,
        command: sanitized(command),
        elapsedMs: Date.now() - startedAt,
        terminalBefore,
        terminalAfter,
        resultIsError: outcome?.result?.isError === true,
        text: outputFragment(outcome?.text),
        error: failure === undefined ? null : sanitized(failure),
        publicReads,
        operationRange: {
          start: operationStartIndex,
          end: operationEndIndex,
          sessionId: operationSessionId,
        },
      };
      stepRecords.push(record);
      appendCaseDiagnostic("output-bound.step.end", record);
      return { outcome, failure, record, operationCalls };
    };
    const largeStep = await runStep("foreground-yes", "yes X | head -c 20000");
    const large = largeStep.outcome;
    if (largeStep.failure !== undefined) {
      const error = new Error(`official persistent large output threw: ${sanitized(largeStep.failure)}`);
      error.evidence = { steps: stepRecords };
      throw error;
    }
    assert(large.result?.isError !== true, `official persistent large output failed: ${sanitized(large.text)}`);
    assert(large.text.includes("<response clipped>"), "official persistent output did not report clipping");
    const visibleBytes = Buffer.byteLength(large.text);
    const clipOffset = large.text.lastIndexOf("<response clipped>");
    const lostPrefixOffset = large.text.indexOf(
      "<response clipped><NOTE>The beginning of this command output was dropped by the terminal scrollback limit. The following text is the earliest retained output.</NOTE>",
    );
    let payloadStart = 0;
    if (lostPrefixOffset >= 0 && lostPrefixOffset < clipOffset) {
      payloadStart = lostPrefixOffset + "<response clipped><NOTE>The beginning of this command output was dropped by the terminal scrollback limit. The following text is the earliest retained output.</NOTE>".length;
      if (large.text[payloadStart] === "\r") payloadStart += 1;
      if (large.text[payloadStart] === "\n") payloadStart += 1;
    }
    assert(clipOffset > payloadStart, "official persistent clipped output did not expose a payload segment");
    const payloadText = large.text.slice(payloadStart, clipOffset);
    const payloadBytes = Buffer.byteLength(payloadText);
    const payloadXCount = (payloadText.match(/X/g) ?? []).length;
    assert(payloadBytes > 0 && payloadBytes <= 16_000 && payloadXCount > 0 && payloadXCount <= 8_000,
      `official persistent payload exceeded its 16000-character cap or was not captured: ${payloadBytes}`);
    assert(visibleBytes <= 16_512, `official persistent rendered output exceeded its 16000-character cap plus protocol overhead: ${visibleBytes}`);
    const nextStep = await runStep("after-foreground-cap", "printf 'after-output-cap-clean\\n'");
    const next = nextStep.outcome;
    assert(nextStep.failure === undefined, `official bash after output cap threw: ${sanitized(nextStep.failure)}`);
    assert(next.result?.isError !== true, `official bash after output cap failed: ${sanitized(next.text)}`);
    assert(next.text.includes("after-output-cap-clean"), "official persistent shell did not remain usable after clipping");
    const noisyStep = await runStep(
      "background-yes-head",
      "(yes N | head -c 20000) & export DSH_CLI_NOISY_PID=$!; printf 'noisy-started\\n'",
    );
    const noisy = noisyStep.outcome;
    const noisyHealthy = noisyStep.failure === undefined
      && noisy?.result?.isError !== true
      && noisy.text.includes("noisy-started")
      && !noisyStep.record.text.timedOut;
    let noisyReapStep;
    if (noisyHealthy) {
      noisyReapStep = await runStep(
        "background-yes-head-reap",
        "wait \"$DSH_CLI_NOISY_PID\"; printf 'noisy-reaped\\n'",
      );
    } else {
      appendCaseDiagnostic("output-bound.step.skipped", {
        label: "background-yes-head-reap",
        reason: "background yes/head step did not return a healthy readiness result; persistent shell may have reset",
      });
    }
    const builtinCommand = "printf 'builtin-started\\n'; (printf '%20000s' '') & export DSH_CLI_BUILTIN_PID=$!; printf 'builtin-pid=%s\\n' \"$DSH_CLI_BUILTIN_PID\"";
    const builtinStep = await runStep("background-builtin-printf", builtinCommand);
    const builtin = builtinStep.outcome;
    const builtinHealthy = builtinStep.failure === undefined
      && builtin?.result?.isError !== true
      && builtin.text.includes("builtin-started")
      && !builtinStep.record.text.timedOut;
    let builtinReapStep;
    if (builtinHealthy) {
      builtinReapStep = await runStep(
        "background-builtin-printf-reap",
        "wait \"$DSH_CLI_BUILTIN_PID\"; printf 'builtin-reaped\\n'",
      );
    } else {
      appendCaseDiagnostic("output-bound.step.skipped", {
        label: "background-builtin-printf-reap",
        reason: "builtin printf control did not return a healthy readiness result",
      });
    }
    const noisyReapEvidence = inspectPersistentReapEvidence({
      outcome: noisyReapStep?.outcome,
      expectedMarker: "noisy-reaped",
      expectedSessionId: noisyReapStep?.record.operationRange.sessionId,
      operationCalls: noisyReapStep?.operationCalls,
      publicReads: noisyReapStep?.record.publicReads,
    });
    const builtinReapEvidence = inspectPersistentReapEvidence({
      outcome: builtinReapStep?.outcome,
      expectedMarker: "builtin-reaped",
      expectedSessionId: builtinReapStep?.record.operationRange.sessionId,
      operationCalls: builtinReapStep?.operationCalls,
      publicReads: builtinReapStep?.record.publicReads,
    });
    const persistentHandleSnapshots = spawnObservation?.calls.map((call) => ({
      argv: call.argv.map((value) => sanitized(value)),
      handle: publicSubprocessHandleSnapshot(call.handle, call.stdoutFlow),
    })) ?? [];
    retainedSpawnObservation = spawnObservation;
    spawnObservation?.restore();
    spawnObservation = undefined;
    let oneShotNative;
    let oneShotHandle;
    try {
      oneShotHandle = await createProbeAgent(ctx, { sessionId: randomUUID(), meta: { cwd: WORKSPACE } });
      const oneShotAgent = oneShotHandle?.agent;
      assert(oneShotAgent !== undefined, "official one-shot Git Bash agent factory returned no agent");
      assert(typeof ctx.get("tools")?.get === "function"
        && ctx.get("tools").get("git_bash", oneShotAgent) !== undefined,
      "official one-shot git_bash tool is not visible to the created agent");
      authorizePersistentShell(oneShotAgent);
      const oneShotBefore = publicTerminalSnapshot(ctx, oneShotAgent);
      const oneShotStartedAt = Date.now();
      let oneShotOutcome;
      let oneShotFailure;
      try {
        oneShotOutcome = await executeOfficialRaw(
          ctx,
          oneShotAgent,
          "git_bash",
          "yes N | head -c 20000",
          undefined,
          { description: "offline native Git Bash output backpressure probe" },
        );
      } catch (error) {
        oneShotFailure = error;
      }
      oneShotNative = {
        command: "yes N | head -c 20000",
        elapsedMs: Date.now() - oneShotStartedAt,
        terminalBefore: oneShotBefore,
        terminalAfter: publicTerminalSnapshot(ctx, oneShotAgent),
        resultIsError: oneShotOutcome?.result?.isError === true,
        text: outputFragment(oneShotOutcome?.text),
        error: oneShotFailure === undefined ? null : sanitized(oneShotFailure),
      };
      appendCaseDiagnostic("output-bound.one-shot", oneShotNative);
    } catch (error) {
      oneShotNative = {
        command: "yes N | head -c 20000",
        elapsedMs: null,
        terminalBefore: null,
        terminalAfter: null,
        resultIsError: null,
        text: outputFragment(""),
        error: sanitized(error),
      };
      appendCaseDiagnostic("output-bound.one-shot", oneShotNative);
    } finally {
      if (oneShotHandle?.dispose) {
        try { await oneShotHandle.dispose(); } catch (error) {
          oneShotNative ??= {};
          oneShotNative.disposeError = sanitized(error);
        }
      }
    }
    if (NATIVE_07_DIAGNOSTIC_ONLY) {
      const operationEvidence = operationObservation?.calls.map((call) => ({
        index: call.index,
        sessionId: call.sessionId,
          ownerMatches: call.ownerMatches,
        text: call.text,
        submit: call.submit,
        startedAt: call.startedAt,
        done: call.done,
        doneError: call.doneError,
        readOutputs: call.readOutputs,
      })) ?? [];
      diagnosticEvidence = {
        diagnosticOnly: true,
        activePublicReads: NATIVE_07_PUBLIC_READS,
        sequence: [
          "foreground-yes",
          "after-foreground-cap",
          "background-yes-head",
          "background-yes-head-reap",
          "background-builtin-printf",
          "background-builtin-printf-reap",
          "one-shot-native",
        ],
        persistentYesHead: {
          healthy: noisyHealthy,
          readiness: noisyStep.record,
          reap: noisyReapStep?.record ?? null,
          reapEvidence: noisyReapEvidence,
        },
        builtinPrintfControl: {
          healthy: builtinHealthy,
          readiness: builtinStep.record,
          reap: builtinReapStep?.record ?? null,
          reapEvidence: builtinReapEvidence,
        },
        oneShotNative,
        operations: operationEvidence,
        persistentHandleSnapshots,
        steps: stepRecords,
        observedAt: Date.now(),
      };
      const error = new Error(`bounded full CLI-NATIVE-07 diagnostic retained stdout, operation lifecycle, END/prompt/OSC trace, and managed stdout evidence: ${sanitized(JSON.stringify({
        yes: diagnosticEvidence.persistentYesHead,
        builtin: diagnosticEvidence.builtinPrintfControl,
        operations: diagnosticEvidence.operations,
        handles: diagnosticEvidence.persistentHandleSnapshots,
      }))}`);
      error.evidence = diagnosticEvidence;
      throw error;
    }
    const evidence = {
      requestedBytes: 20_000,
      clipped: true,
      payloadBytes,
      payloadXCount,
      visibleBytes,
      configuredMaxOutputChars: 16_000,
      nextCallClean: true,
      persistentYesHead: {
        healthy: noisyHealthy,
        readiness: noisyStep.record,
        reap: noisyReapStep?.record ?? null,
        reapEvidence: noisyReapEvidence,
      },
      builtinPrintfControl: {
        requestedBytes: 20_000,
        healthy: builtinHealthy,
        readiness: builtinStep.record,
        reap: builtinReapStep?.record ?? null,
        reapEvidence: builtinReapEvidence,
      },
      oneShotNative,
      persistentHandleSnapshots,
      steps: stepRecords,
    };
    const noisyReaped = noisyReapEvidence.ok;
    const builtinReaped = builtinReapEvidence.ok;
    evidence.noisyBackgroundStarted = noisyHealthy;
    evidence.noisyBackgroundReaped = noisyReaped;
    evidence.builtinBackgroundStarted = builtinHealthy;
    evidence.builtinBackgroundReaped = builtinReaped;
    if (!noisyHealthy || !noisyReaped) {
      const error = new Error(`official noisy background remained unhealthy; retained yes/head failure and control evidence: ${sanitized(JSON.stringify({
        yes: evidence.persistentYesHead,
        builtin: evidence.builtinPrintfControl,
        oneShot: evidence.oneShotNative,
      }))}`);
      error.evidence = evidence;
      throw error;
    }
    assert(builtinHealthy && builtinReaped,
      `builtin printf 20K control did not complete/reap: ${sanitized(JSON.stringify(evidence.builtinPrintfControl))}`);
    return evidence;
  } finally {
    operationObservation?.restore();
    spawnObservation?.restore();
    if (handle?.dispose) await handle.dispose();
    if (diagnosticEvidence !== undefined && retainedSpawnObservation !== undefined) {
      diagnosticEvidence.cleanupObservedAt = Date.now();
      try {
        diagnosticEvidence.managedSettlements = PERSISTENT_SHELL === "wsl"
          ? await settleObservedWslManagedHandles(retainedSpawnObservation, "output-bound diagnostic")
          : await settleObservedNativeHandles(retainedSpawnObservation, "output-bound diagnostic");
        diagnosticEvidence.cleanupError = null;
      } catch (error) {
        diagnosticEvidence.cleanupError = sanitized(error);
      }
      diagnosticEvidence.persistentHandleSnapshotsAfterDispose = retainedSpawnObservation.calls.map((call) => ({
        argv: call.argv.map((value) => sanitized(value)),
        handle: publicSubprocessHandleSnapshot(call.handle, call.stdoutFlow),
      }));
      diagnosticEvidence.operationsAfterCleanup = operationObservation?.calls.map((call) => ({
        index: call.index,
        done: call.done,
        doneError: call.doneError,
      })) ?? [];
    }
  }
}

async function officialInitializationCancellation(ctx) {
  const agents = ctx.get("agents");
  if (agents === undefined || typeof agents.create !== "function") {
    throw new CaseSkip("official agents service/factory is unavailable for initialization cancellation");
  }
  const terminals = ctx.get("terminals");
  const subprocess = ctx.get("subprocess");
  assert(typeof terminals?.list === "function"
    && typeof terminals?.hasOwnerActivity === "function",
  "official terminal lifecycle APIs are unavailable for initialization cancellation");
  assert(typeof subprocess?.spawn === "function",
    "official subprocess spawn API is unavailable for initialization cancellation");
  const markerPath = ownedPath(WORKSPACE, `official-init-cancel-${MODE}.marker`);
  removeIfPresent(markerPath);
  let handle;
  let operationObservation;
  let originalSpawn;
  let spawnSpyInstalled = false;
  const spawnCalls = [];
  let agent;
  let beforeTerminalCount = 0;
  let ownerActivityCleared = false;
  let evidence;
  let disposed = false;
  try {
    handle = await createProbeAgent(ctx, { sessionId: randomUUID(), meta: { cwd: WORKSPACE } });
    agent = handle?.agent;
    assert(agent !== undefined, "official agent factory returned no agent for initialization cancellation");
    authorizePersistentShell(agent);
    beforeTerminalCount = terminals.list(agent).length;
    operationObservation = observeTerminalOperations(ctx, agent);
    originalSpawn = subprocess.spawn;
    subprocess.spawn = function observedInitializationSpawn(spec) {
      spawnCalls.push({
        argv: Array.isArray(spec?.argv) ? [...spec.argv] : [],
        cwd: spec?.cwd ?? null,
      });
      return originalSpawn.call(this, spec);
    };
    spawnSpyInstalled = true;
    const controller = new AbortController();
    controller.abort(new DOMException(
      "official initialization cancellation",
      "AbortError",
    ));
    let outcome;
    let failure;
    try {
      outcome = await executeOfficialRaw(
        ctx,
        agent,
        "bash",
        `printf should-not-run > ${bashQuote(shellPath(markerPath))}`,
        controller.signal,
      );
    } catch (error) {
      failure = error;
    }
    const cancellationDiagnostic = failure === undefined
      ? `${outcome?.text ?? ""} ${outcome?.result?.error?.message ?? ""}`.trim()
      : sanitized(failure);
    const errorInfo = outcome?.result?.error?.info ?? null;
    const typedEnvelopeAbort = outcome?.result?.isError === true
      && outcome?.result?.error?.message === "tool call aborted before dispatch"
      && outcome?.result?.error?.info?.name === "AbortError"
      && outcome?.result?.error?.info?.code === "ABORTED_BEFORE_DISPATCH"
      && outcome?.text === "Error: tool call aborted before dispatch"
      && controller.signal.aborted === true
      && controller.signal.reason?.name === "AbortError";
    assert(typedEnvelopeAbort,
      `initialization cancellation did not satisfy the exact typed pre-dispatch contract: ${sanitized(JSON.stringify({
        outcome,
        failure,
        cancellationDiagnostic,
        errorInfo,
        signalAborted: controller.signal.aborted,
        signalReasonName: controller.signal.reason?.name ?? null,
      }))}`);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    ownerActivityCleared = await waitForNoOwnerActivity(terminals, agent, 5_000);
    assert(ownerActivityCleared,
      "initialization-stage cancellation left owner terminal activity registered");
    const markerCreated = existsSync(markerPath);
    const terminalCountAfter = terminals.list(agent).length;
    assert(!markerCreated, "initialization-stage cancellation sent a command");
    assert(operationObservation.calls.length === 0,
      `initialization-stage cancellation started ${operationObservation.calls.length} terminal operation(s)`);
    assert(spawnCalls.length === 0,
      `initialization-stage cancellation spawned ${spawnCalls.length} subprocess(es)`);
    assert(terminalCountAfter === beforeTerminalCount,
      `initialization-stage cancellation changed terminal count ${beforeTerminalCount} -> ${terminalCountAfter}`);
    evidence = {
      abortedBeforeCommand: true,
      cancellationDiagnostic: sanitized(cancellationDiagnostic),
      typedEnvelopeAbort,
      abortErrorInfo: errorInfo,
      abortSignal: {
        aborted: controller.signal.aborted,
        reasonName: controller.signal.reason?.name ?? null,
      },
      markerCreated: false,
      terminalOperations: operationObservation.calls.length,
      subprocessSpawns: spawnCalls.length,
      terminalCountBefore: beforeTerminalCount,
      terminalCountAfter,
      ownerActivityCleared,
      managedHandlesSpawned: 0,
      managedHandlesSettled: true,
    };
  } finally {
    try {
      assert(typeof handle?.dispose === "function",
        "official initialization cancellation handle has no dispose method");
      await handle.dispose();
      disposed = true;
    } finally {
      operationObservation?.restore();
      if (spawnSpyInstalled) subprocess.spawn = originalSpawn;
      removeIfPresent(markerPath);
    }
  }
  const ownerActivityAfterDispose = await waitForNoOwnerActivity(terminals, agent, 5_000);
  assert(ownerActivityAfterDispose,
    "initialization cancellation dispose left owner terminal activity registered");
  assert(disposed, "initialization cancellation did not dispose its owned agent");
  return {
    ...evidence,
    disposed,
    ownerActivityAfterDispose,
  };
}

async function officialPersistentSerialization(ctx) {
  const agents = ctx.get("agents");
  if (agents === undefined || typeof agents.create !== "function") {
    throw new CaseSkip("official agents service/factory is unavailable for serialization");
  }
  const logPath = ownedPath(WORKSPACE, `official-serial-${MODE}.log`);
  const log = shellPath(logPath);
  removeIfPresent(logPath);
  let handle;
  try {
    handle = await createProbeAgent(ctx, { sessionId: randomUUID(), meta: { cwd: WORKSPACE } });
    const agent = handle?.agent;
    assert(agent !== undefined, "official agent factory returned no agent for serialization");
    authorizePersistentShell(agent);
    const first = executeOfficialTool(ctx, agent, "bash", `printf first-start >> ${bashQuote(log)}; sleep 1; printf first-end >> ${bashQuote(log)}`);
    const second = executeOfficialTool(ctx, agent, "bash", `printf second >> ${bashQuote(log)}`);
    await Promise.all([first, second]);
    const content = readFileSync(logPath, "utf8");
    assert(content === "first-startfirst-endsecond", `official persistent calls were not serialized: ${JSON.stringify(content)}`);
    return { serialized: true, order: content };
  } finally {
    try {
      if (handle?.dispose) await handle.dispose();
    } finally {
      removeIfPresent(logPath);
    }
  }
}

async function nativeModePermissionFence(ctx) {
  const agents = ctx.get("agents");
  const terminals = ctx.get("terminals");
  if (agents === undefined || typeof agents.create !== "function") {
    throw new CaseSkip("official agents service/factory is unavailable for native mode permission fence");
  }
  let handle;
  const observation = observeNativeSpawner(ctx);
  try {
    handle = await createProbeAgent(ctx, { sessionId: randomUUID(), meta: { cwd: WORKSPACE } });
    const agent = handle?.agent;
    assert(agent !== undefined, "official agent factory returned no agent for native mode permission fence");
    assert(typeof terminals?.list === "function", "official terminal list API is unavailable for native mode permission fence");
    agent.session.append("sandbox/mode", { mode: "workspace-write" });
    const before = terminals.list(agent).length;
    let denial;
    try {
      denial = await executeOfficialRaw(ctx, agent, "bash", "printf should-not-run");
    } catch (error) {
      denial = { result: { isError: true }, text: sanitized(error) };
    }
    assert(denial.result?.isError === true,
      `persistent Git Bash unexpectedly ran under workspace-write: ${sanitized(denial.text)}`);
    assert(/danger-full-access|no Git Bash process was started|permission/i.test(denial.text),
      `persistent Git Bash denial did not explain the permission boundary: ${sanitized(denial.text)}`);
    assert(observation.calls.length === 0,
      `persistent Git Bash denial created ${observation.calls.length} terminal process(es)`);
    assert(terminals.list(agent).length === before,
      "persistent Git Bash denial left an owner terminal entry");
    agent.session.append("sandbox/mode", { mode: "danger-full-access" });
    return {
      restrictedMode: "workspace-write",
      denied: true,
      spawnCount: observation.calls.length,
      explicitRetryMode: "danger-full-access",
      noAutomaticUpgrade: true,
    };
  } finally {
    observation.restore();
    if (handle?.dispose) await handle.dispose();
  }
}

async function nativeModeStartupFailure(ctx) {
  const agents = ctx.get("agents");
  const terminals = ctx.get("terminals");
  if (agents === undefined || typeof agents.create !== "function") {
    throw new CaseSkip("official agents service/factory is unavailable for native startup cleanup");
  }
  const invalidCwd = ownedPath(WORKSPACE, "native-startup-missing 中文 space");
  removeIfPresent(invalidCwd);
  let handle;
  let session;
  const observation = observeNativeSpawner(ctx);
  try {
    handle = await createProbeAgent(ctx, { sessionId: randomUUID(), meta: { cwd: WORKSPACE } });
    const agent = handle?.agent;
    assert(agent !== undefined, "official agent factory returned no agent for native startup cleanup");
    authorizePersistentShell(agent);
    let failure;
    try {
      session = await terminals.spawn(agent, { type: PERSISTENT_SHELL, cwd: invalidCwd });
    } catch (error) {
      failure = error;
    }
    assert(failure !== undefined, "invalid native Git Bash cwd unexpectedly started a session");
    const commandCalls = observation.calls.filter((call) =>
      call.argv.some((value) => String(value).replaceAll("\\", "/").endsWith("/usr/bin/bwrap")));
    const canonicalProbeCalls = observation.calls.filter((call) => !commandCalls.includes(call));
    if (PERSISTENT_SHELL === "git-bash") {
      assert(observation.calls.length === 0,
        `Git Bash startup failure created ${observation.calls.length} process(es) before cwd rejection`);
    } else {
      assert(canonicalProbeCalls.length >= 1,
        "WSL startup failure did not expose its expected realpath probe process(es)");
      assert(commandCalls.length === 0,
        `WSL startup failure reached ${commandCalls.length} bwrap command process(es)`);
    }
    const probeQuiescence = [];
    for (const call of observation.calls) {
      assert(typeof call.handle?.waitForExit === "function",
        "startup failure subprocess observation did not expose waitForExit");
      probeQuiescence.push(await call.handle.waitForExit());
    }
    assert(probeQuiescence.every((value) => value === true),
      `startup failure left a realpath probe process unquiesced: ${sanitized(JSON.stringify(probeQuiescence))}`);
    assert(terminals.list(agent).length === 0, "native startup failure left a terminal entry");
    return {
      rejected: true,
      persistentShell: PERSISTENT_SHELL,
      probeSpawnCount: canonicalProbeCalls.length,
      commandSpawnCount: commandCalls.length,
      probeArgv: canonicalProbeCalls.map((call) => call.argv.map((value) => sanitized(value))),
      probeQuiescent: true,
      sessionEntryCount: 0,
    };
  } finally {
    if (session !== undefined) {
      try { await terminals.kill(handle.agent, session.sessionId, "native startup failure cleanup"); } catch {}
    }
    observation.restore();
    if (handle?.dispose) await handle.dispose();
    removeIfPresent(invalidCwd);
  }
}

async function nativeModeOwnerIsolation(ctx) {
  const agents = ctx.get("agents");
  const terminals = ctx.get("terminals");
  if (agents === undefined || typeof agents.create !== "function") {
    throw new CaseSkip("official agents service/factory is unavailable for native owner isolation");
  }
  let first;
  let second;
  let firstSession;
  let secondSession;
  const spawnObservation = PERSISTENT_SHELL === "git-bash" ? observeNativeSpawner(ctx) : undefined;
  const sessionObservation = observeTerminalSessions(ctx);
  const managedObservation = PERSISTENT_SHELL === "wsl"
    ? observeWslManagedSubprocesses(ctx)
    : undefined;
  const observerIdentity = PERSISTENT_SHELL === "git-bash"
    ? processCreationIdentity(windowsProcess(process.pid))
    : null;
  let nativeEvidence;
  try {
    first = await createProbeAgent(ctx, { sessionId: randomUUID(), meta: { cwd: WORKSPACE } });
    second = await createProbeAgent(ctx, { sessionId: randomUUID(), meta: { cwd: WORKSPACE } });
    authorizePersistentShell(first.agent);
    authorizePersistentShell(second.agent);
    firstSession = await terminals.spawn(first.agent, { type: PERSISTENT_SHELL, cwd: WORKSPACE });
    secondSession = await terminals.spawn(second.agent, { type: PERSISTENT_SHELL, cwd: WORKSPACE });
    if (spawnObservation !== undefined) {
      assert(spawnObservation.calls.length === 2 && sessionObservation?.calls.length === 2,
        `native owner isolation did not publish two helper/session pairs: ${sanitized(JSON.stringify({ spawns: spawnObservation.calls.length, sessions: sessionObservation?.calls.length }))}`);
      const processSnapshot = windowsProcessSnapshot();
      const pairs = spawnObservation.calls.map((call, index) => {
        const topPid = Number(sessionObservation.calls[index].pid);
        const topIdentity = windowsProcess(topPid);
        const topLineage = windowsLineage(topPid, (row) => /pty-helper\.js/i.test(String(row.CommandLine ?? "")));
        const helperIdentity = topLineage.find((row) => /pty-helper\.js/i.test(String(row.CommandLine ?? "")));
        const helperPid = Number(helperIdentity?.ProcessId);
        const descendants = hydrateWindowsRows(
          windowsDescendants(topPid, processSnapshot),
          `native owner top ${topPid} candidates`,
        );
        const configuredBinary = process.env.DSH_GIT_BASH_PATH ?? "C:\\Program Files\\Git\\bin\\bash.exe";
        const innerIdentity = normalizeWindowsImage(topIdentity?.ExecutablePath) === normalizeWindowsImage(configuredBinary)
          && normalizeWindowsImage(configuredBinary).endsWith("\\git\\usr\\bin\\bash.exe")
          ? topIdentity
          : descendants.find((row) => normalizeWindowsImage(row.ExecutablePath).endsWith("\\git\\usr\\bin\\bash.exe"));
        const shellPid = Number(innerIdentity?.ProcessId ?? topPid);
        return {
          helperPid,
          topPid,
          shellPid,
          helperArgv: call.argv.map((value) => sanitized(value)),
          controlPipe: call.stdio?.control === "pipe",
          helperIdentity: sanitizedProcessRow(helperIdentity),
          helperCreationIdentity: processCreationIdentity(helperIdentity),
          topIdentity: sanitizedProcessRow(topIdentity),
          topCreationIdentity: processCreationIdentity(topIdentity),
          shellIdentity: sanitizedProcessRow(innerIdentity),
          shellCreationIdentity: processCreationIdentity(innerIdentity),
          helperChildren: windowsDescendants(helperPid, processSnapshot).map(sanitizedProcessRow),
        };
      });
      for (const pair of pairs) {
        assert(String(pair.helperIdentity?.Name ?? "").toLowerCase() === "node.exe"
          && /pty-helper\.js/i.test(String(pair.helperIdentity?.CommandLine ?? "")),
        `native owner helper identity was not the expected Node helper: ${sanitized(JSON.stringify(pair))}`);
        assert(pair.controlPipe === true,
          `native owner helper did not retain its private control pipe: ${sanitized(JSON.stringify(pair))}`);
        assert(String(pair.shellIdentity?.Name ?? "").toLowerCase() === "bash.exe"
          && normalizeWindowsImage(pair.shellIdentity?.ExecutablePath).endsWith("\\git\\usr\\bin\\bash.exe"),
        `native owner shell identity was not the expected usr/bin Bash: ${sanitized(JSON.stringify(pair))}`);
        assert(normalizeWindowsImage(pair.topIdentity?.ExecutablePath) === normalizeWindowsImage(process.env.DSH_GIT_BASH_PATH ?? "C:\\Program Files\\Git\\bin\\bash.exe"),
          `native owner top image did not match configured Git executable: ${sanitized(JSON.stringify(pair))}`);
      }
      nativeEvidence = { pairs };
    }
    const rejected = [];
    for (const [name, operation] of [
      ["startSend", () => terminals.startSend(first.agent, secondSession.sessionId, { text: "printf should-not-run", submit: true })],
      ["read", () => terminals.read(first.agent, secondSession.sessionId, { count: 10 })],
      ["signal", () => terminals.signal(first.agent, secondSession.sessionId, "SIGINT")],
      ["close", () => terminals.kill(first.agent, secondSession.sessionId, "foreign native close")],
    ]) {
      let failure;
      try { await Promise.resolve(operation()); } catch (error) { failure = error; }
      assert(failure?.code === "FOREIGN_SESSION",
        `native owner ${name} was not rejected: ${sanitized(failure)}`);
      rejected.push(name);
    }
    assert(terminals.list(first.agent).every((entry) => entry.sessionId !== secondSession.sessionId),
      "native owner A could list owner B's session");
    assert(terminals.list(second.agent).some((entry) => entry.sessionId === secondSession.sessionId),
      "native owner B session disappeared after foreign operations");
    await first.dispose();
    first = undefined;
    assert(terminals.list(second.agent).some((entry) => entry.sessionId === secondSession.sessionId),
      "disposing native owner A closed owner B's session");
    const alive = terminals.startSend(second.agent, secondSession.sessionId, { text: "printf native-owner-b-alive", submit: true });
    const aliveResult = await alive.done;
    assert(aliveResult.viewport.includes("native-owner-b-alive"),
      "native owner B could not use its session after owner A disposal");
    const natural = terminals.startSend(second.agent, secondSession.sessionId, { text: "exit", submit: true });
    const naturalResult = await natural.done;
    assert(naturalResult.sessionStatus.kind === "exited", "native owner B did not report natural exit");
    if (PERSISTENT_SHELL === "wsl") {
      if (terminals.list(second.agent).some((entry) => entry.sessionId === secondSession.sessionId)) {
        await terminals.kill(second.agent, secondSession.sessionId, "WSL owner natural-exit cleanup");
      }
      const naturalOwnerActivityCleared = await waitForNoOwnerActivity(terminals, second.agent, 5_000);
      assert(naturalOwnerActivityCleared, "WSL owner B natural exit left owner activity registered");
      assert(terminals.list(second.agent).length === 0,
        "WSL owner B natural exit left an owner-visible terminal entry");
      const managedSettlements = await settleObservedWslManagedHandles(managedObservation, "owner isolation");
      const managedDone = managedSettlements.length > 0
        && managedSettlements.every((entry) => entry.doneError === null && entry.done !== null);
      const managedWaitForExit = managedSettlements.length > 0
        && managedSettlements.every((entry) => entry.waitError === null && entry.waitForExit === true);
      assert(managedDone && managedWaitForExit,
        `WSL owner managed handles did not settle cleanly: ${sanitized(JSON.stringify(managedSettlements))}`);
      return {
        rejected,
        ownerAListHiddenB: true,
        ownerADisposed: true,
        ownerBStayedAlive: true,
        naturalExit: true,
        naturalOwnerActivityCleared,
        publicSession: publicWslSessionEvidence(sessionObservation),
        managedSettlements,
        managedDone,
        managedWaitForExit,
        observationError: null,
      };
    }
    return { rejected, ownerAListHiddenB: true, ownerADisposed: true, ownerBStayedAlive: true, naturalExit: true, ...(nativeEvidence === undefined ? {} : { nativeProcess: nativeEvidence }) };
  } finally {
    if (firstSession !== undefined && first?.agent !== undefined) {
      try { await terminals.kill(first.agent, firstSession.sessionId, "native owner cleanup"); } catch {}
    }
    if (secondSession !== undefined && second?.agent !== undefined) {
      try { await terminals.kill(second.agent, secondSession.sessionId, "native owner cleanup"); } catch {}
    }
    if (first?.dispose) { try { await first.dispose(); } catch {} }
    if (second?.dispose) { try { await second.dispose(); } catch {} }
    if (nativeEvidence !== undefined) {
      const managedSettlements = await settleObservedNativeHandles(spawnObservation, "owner isolation");
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline && nativeEvidence.pairs.some((pair) =>
        processAtIdentity(pair.helperCreationIdentity) !== undefined
        || processAtIdentity(pair.topCreationIdentity) !== undefined
        || processAtIdentity(pair.shellCreationIdentity) !== undefined)) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const remaining = nativeEvidence.pairs.flatMap((pair) => [
          { pid: pair.helperPid, process: sanitizedProcessRow(processAtIdentity(pair.helperCreationIdentity)) },
          { pid: pair.topPid, process: sanitizedProcessRow(processAtIdentity(pair.topCreationIdentity)) },
          { pid: pair.shellPid, process: sanitizedProcessRow(processAtIdentity(pair.shellCreationIdentity)) },
        ]).filter((entry) => entry.process !== null);
      const helperChildren = nativeEvidence.pairs.flatMap((pair) => processAtIdentity(pair.helperCreationIdentity) === undefined
          ? []
          : windowsDescendants(pair.helperPid)).map(sanitizedProcessRow);
      nativeEvidence.afterDispose = {
        helper: remaining.find((entry) => nativeEvidence.pairs.some((pair) => pair.helperPid === entry.pid))?.process ?? null,
        top: remaining.find((entry) => nativeEvidence.pairs.some((pair) => pair.topPid === entry.pid))?.process ?? null,
        shell: remaining.find((entry) => nativeEvidence.pairs.some((pair) => pair.shellPid === entry.pid))?.process ?? null,
        remaining,
        helperChildren,
        managedSettlements,
      };
      nativeEvidence.managedSettlements = managedSettlements;
      nativeEvidence.managedDone = managedSettlements.length > 0
        && managedSettlements.every((entry) => entry.doneError === null && entry.done !== null);
      nativeEvidence.managedWaitForExit = managedSettlements.length > 0
        && managedSettlements.every((entry) => entry.waitError === null && entry.waitForExit === true);
      nativeEvidence.observerHostAliveAfterExit = observerIdentity !== null
        && processAtIdentity(observerIdentity) !== undefined;
      nativeEvidence.observationError = null;
      assert(nativeEvidence.afterDispose.remaining.length === 0
        && nativeEvidence.afterDispose.helperChildren.length === 0,
      `native owner isolation left helper/shell processes: ${sanitized(JSON.stringify(nativeEvidence.afterDispose))}`);
      assert(nativeEvidence.observerHostAliveAfterExit,
        "native owner isolation observer host exited before cleanup evidence was collected");
    }
    spawnObservation?.restore();
    sessionObservation?.restore();
    managedObservation?.restore();
  }
}

async function nativeNaturalExitBackground(ctx, noisy) {
  const agents = ctx.get("agents");
  const terminals = ctx.get("terminals");
  if (PERSISTENT_SHELL !== "git-bash") {
    throw new CaseSkip("natural native Git Bash background proof is only applicable to git-bash");
  }
  if (agents === undefined || typeof agents.create !== "function") {
    throw new CaseSkip("official agents service/factory is unavailable for native natural-exit background proof");
  }
  assert(typeof terminals?.list === "function", "official terminal list API is unavailable for native natural-exit background proof");
  const label = noisy ? "noisy" : "delayed";
  const delaySeconds = 8;
  const delayMs = delaySeconds * 1_000;
  const markerPath = ownedPath(WORKSPACE, `native-natural-${label}-leak-${MODE}.marker`);
  const diagnosticPath = ownedPath(WORKSPACE, `native-natural-${label}-diagnostic-${MODE}.log`);
  const barrierPath = ownedPath(WORKSPACE, `native-natural-${label}-barrier-${MODE}.marker`);
  const markerShell = shellPath(markerPath);
  const diagnosticShell = shellPath(diagnosticPath);
  const barrierShell = shellPath(barrierPath);
  removeIfPresent(markerPath);
  removeIfPresent(diagnosticPath);
  removeIfPresent(barrierPath);
  let handle;
  let spawnObservation;
  let sessionObservation;
  let nativeTree;
  let terminalQuery;
  const observerIdentity = windowsProcess(process.pid);
  try {
    handle = await createProbeAgent(ctx, { sessionId: randomUUID(), meta: { cwd: WORKSPACE } });
    const agent = handle?.agent;
    assert(agent !== undefined, "official agent factory returned no agent for native natural-exit background proof");
    authorizePersistentShell(agent);
    spawnObservation = observeNativeSpawner(ctx);
    sessionObservation = observeTerminalSessions(ctx);
    const ready = await executeOfficialRaw(ctx, agent, "bash", `printf 'native-${label}-ready\\n'`);
    assert(ready.result?.isError !== true && ready.text.includes(`native-${label}-ready`),
      `native ${label} background bootstrap did not return its readiness marker: ${sanitized(ready.text)}`);
    nativeTree = await waitForNativeTree(spawnObservation, sessionObservation, `${label} background`);
    terminalQuery = noisy ? await runNativeTerminalQuery(ctx, agent, nativeTree) : null;
    const backgroundCommand = noisy
      ? [
        `(while [ ! -f ${bashQuote(barrierShell)} ]; do sleep 0.01; done; printf 'noisy_release_ms=%s\\n' "$(date +%s%3N)" >> ${bashQuote(diagnosticShell)}; yes N | head -c 200000; sleep ${delaySeconds}; printf 'leak_ms=%s\\n' "$(date +%s%3N)" >> ${bashQuote(diagnosticShell)}; printf leaked > ${bashQuote(markerShell)}) & bg=$!`,
        `bg_winpid=; for attempt in 1 2 3 4 5 6 7 8 9 10; do IFS= read -r bg_winpid </proc/$bg/winpid 2>/dev/null; [ -n "$bg_winpid" ] && break; sleep 0.05; done`,
        `printf 'bg_pid=%s bg_winpid=%s prepared_ms=%s\\n' "$bg" "$bg_winpid" "$(date +%s%3N)" > ${bashQuote(diagnosticShell)}`,
        "printf 'native-noisy-prepared\\n'",
      ].join("; ")
      : [
        `(sleep ${delaySeconds}; printf 'leak_ms=%s\\n' "$(date +%s%3N)" >> ${bashQuote(diagnosticShell)}; printf leaked > ${bashQuote(markerShell)}) & bg=$!`,
        `bg_winpid=; for attempt in 1 2 3 4 5 6 7 8 9 10; do IFS= read -r bg_winpid </proc/$bg/winpid 2>/dev/null; [ -n "$bg_winpid" ] && break; sleep 0.05; done`,
        `printf 'bg_pid=%s bg_winpid=%s prepared_ms=%s\\n' "$bg" "$bg_winpid" "$(date +%s%3N)" > ${bashQuote(diagnosticShell)}`,
        "printf 'native-delayed-prepared\\n'",
      ].join("; ");
    const prepared = await executeOfficialRaw(ctx, agent, "bash", backgroundCommand);
    assert(prepared.result?.isError !== true && prepared.text.includes(`native-${label}-prepared`),
      `native ${label} background did not publish its prepared marker: ${sanitized(prepared.text)}`);
    if (terminalQuery !== null) {
      const ownerAfterPrepare = processAtIdentity(terminalQuery.ownerCreationBeforePrepare.shell);
      assert(ownerAfterPrepare !== undefined,
        `native ${label} prepare did not retain the same owner shell CreationDate: ${sanitized(JSON.stringify(terminalQuery.ownerCreationBeforePrepare))}`);
    }
    const preparedDiagnostic = existsSync(diagnosticPath) ? readFileSync(diagnosticPath, "utf8") : "";
    const pidMatch = /bg_pid=(\d+)\s+bg_winpid=(\d+)\s+prepared_ms=(\d+)/.exec(preparedDiagnostic);
    assert(pidMatch !== null,
      `native ${label} background diagnostic did not contain a real /proc/$!/winpid identity: ${sanitized(preparedDiagnostic)}`);
    const backgroundMsysPid = Number(pidMatch[1]);
    const backgroundPid = Number(pidMatch[2]);
    assert(Number.isSafeInteger(backgroundMsysPid) && backgroundMsysPid > 0,
      `native ${label} background MSYS pid was invalid: ${sanitized(preparedDiagnostic)}`);
    const backgroundRow = windowsProcess(backgroundPid);
    assert(backgroundRow !== undefined,
      `native ${label} background Windows process was not alive before natural exit: ${sanitized(JSON.stringify({ backgroundPid, preparedDiagnostic }))}`);
    const backgroundIdentity = processCreationIdentity(backgroundRow);
    assert(backgroundIdentity !== null && backgroundIdentity.creationDate.length > 0,
      `native ${label} background process had no creation identity: ${sanitized(JSON.stringify(backgroundRow))}`);
    assert(nativeTree.topDescendants.some((row) => Number(row.ProcessId) === backgroundPid)
      || Number(backgroundRow.ParentProcessId) === nativeTree.shellPid,
    `native ${label} background was not rooted in the owned Git Bash tree: ${sanitized(JSON.stringify({ backgroundRow, topDescendants: nativeTree.topDescendants }))}`);
    addNativeOwnedRows(nativeTree, [backgroundRow]);
    const preparedAt = Number(pidMatch[3]);
    assert(Number.isSafeInteger(preparedAt) && preparedAt > 0,
      `native ${label} background diagnostic had an invalid start timestamp: ${sanitized(preparedDiagnostic)}`);
    const naturalCommand = noisy
      ? `printf 'native-noisy-shell-end\\n'; printf released > ${bashQuote(barrierShell)}; exit`
      : "printf 'native-delayed-shell-end\\n'; exit";
    const natural = await executeOfficialRaw(ctx, agent, "bash", naturalCommand);
    assert(natural.text.includes(`native-${label}-shell-end`),
      `native ${label} natural exit did not retain the shell end marker: ${sanitized(natural.text)}`);
    const naturalActivityCleared = await waitForNoOwnerActivity(terminals, agent, 5_000);
    assert(naturalActivityCleared, `native ${label} natural exit left owner terminal activity registered`);
    const observerAfterExit = observerIdentity === undefined
      ? undefined
      : processAtIdentity(processCreationIdentity(observerIdentity));
    assert(observerAfterExit !== undefined,
      `native ${label} observer host exited before cleanup evidence was collected`);
    const markerDeadline = preparedAt + delayMs + 2_000;
    const waitStartedAt = Date.now();
    if (markerDeadline > waitStartedAt) {
      await new Promise((resolve) => setTimeout(resolve, markerDeadline - waitStartedAt));
    }
    const afterDelayDiagnostic = existsSync(diagnosticPath) ? readFileSync(diagnosticPath, "utf8") : "";
    const afterDelayBackground = processAtIdentity(backgroundIdentity);
    const afterDelayRows = afterDelayBackground === undefined
      ? []
      : [sanitizedProcessRow(afterDelayBackground)];
    assert(afterDelayRows.length === 0,
      `native ${label} natural exit left its owned background identity after the full delay window: ${sanitized(JSON.stringify(afterDelayRows))}`);
    assert(!existsSync(markerPath) && !/leak_ms=\d+/.test(afterDelayDiagnostic),
      `native ${label} natural exit allowed its background marker after the complete delay window: ${sanitized(afterDelayDiagnostic)}`);
    const afterDispose = await waitForNativeTreeGone(nativeTree, 5_000);
    assert(afterDispose.remaining.length === 0 && afterDispose.helperDescendants.length === 0,
      `native ${label} natural exit left owned helper/ConPTY/Bash/background processes: ${sanitized(JSON.stringify(afterDispose))}`);
    const initialDescendants = [...nativeTree.helperChildren, ...nativeTree.topDescendants]
      .filter((row, index, rows) => rows.findIndex((candidate) => Number(candidate.ProcessId) === Number(row.ProcessId)
        && String(candidate.CreationDate ?? "") === String(row.CreationDate ?? "")) === index);
    return {
      scenario: `natural-exit-${label}-background`,
      delaySeconds,
      markerCreated: false,
      delayedWriteObserved: false,
      naturalExit: {
        shellEndMarker: `native-${label}-shell-end`,
        shellEndVisible: true,
        responseIsError: natural.result?.isError === true,
        responseText: sanitized(natural.text),
        ownerActivityCleared: true,
      },
      observerHost: sanitizedProcessRow(observerIdentity),
      observerHostAliveAfterExit: true,
      observationError: null,
      terminalQuery,
      preparedDiagnostic: sanitized(preparedDiagnostic),
      afterDelayDiagnostic: sanitized(afterDelayDiagnostic),
      cleanupObservationMs: Date.now() - waitStartedAt,
      processLedger: {
        available: true,
        frame: {
          shellWinPid: nativeTree.shellPid,
          backgroundWinPid: backgroundPid,
        },
        afterDelayRows,
        remaining: afterDispose.remaining,
      },
      nativeProcess: {
        configuredBinary: sanitized(nativeTree.configuredBinary),
        helperPid: nativeTree.helperPid,
        topPid: nativeTree.topPid,
        shellPid: nativeTree.shellPid,
        backgroundMsysPid,
        backgroundPid,
        helper: sanitizedProcessRow(nativeTree.helperIdentity),
        top: sanitizedProcessRow(nativeTree.topIdentity),
        shell: sanitizedProcessRow(nativeTree.shellIdentity),
        conhost: sanitizedProcessRow(nativeTree.conhostIdentity),
        background: sanitizedProcessRow(backgroundRow),
        helperArgv: nativeTree.helperArgv.map((value) => sanitized(value)),
        helperStdio: nativeTree.helperStdio,
        initialOwnedDescendants: initialDescendants.map(sanitizedProcessRow),
        observerHostAliveAfterExit: true,
        observationError: null,
        afterDispose,
        creationIdentitiesObserved: nativeTree.ownedIdentities,
      },
    };
  } finally {
    sessionObservation?.restore();
    spawnObservation?.restore();
    try {
      if (handle?.dispose) await handle.dispose();
    } finally {
      if (nativeTree !== undefined) {
        try { await waitForNativeTreeGone(nativeTree, 5_000); } catch {}
      }
      removeIfPresent(markerPath);
      removeIfPresent(diagnosticPath);
      removeIfPresent(barrierPath);
    }
  }
}

async function nativeNaturalExitLiveBackground(ctx) {
  return nativeNaturalExitBackground(ctx, false);
}

async function nativeNaturalExitNoisyBackground(ctx) {
  return nativeNaturalExitBackground(ctx, true);
}

async function gitBashPath() {
  const candidates = [
    process.env.DSH_GIT_BASH_PATH,
    "C:\\Program Files\\Git\\bin\\bash.exe",
    "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
  ].filter((value) => typeof value === "string" && value.length > 0);
  return candidates.find((candidate) => existsSync(candidate));
}

async function main(ctx) {
  const api = await loadPluginApi();
  const services = {
    tools: ctx.get("tools"),
    terminals: ctx.get("terminals"),
    subprocess: ctx.get("subprocess"),
    policy: ctx.get("sandboxPolicy"),
    approval: ctx.get("approval"),
  };
  // The official policy service accepts an explicit per-call mode for an
  // approved operation. The isolated probe supplies the mode from its test
  // profile environment so each fresh CLI run exercises the requested
  // boundary; the plugin still receives the real policy service and workspace
  // root rather than a copied policy implementation.
  const policy = await resolveProbePolicy(ctx, services);
  const checks = [];
  const deferredDesktopCleanup = [];
  const lifecycle = { initial: contextLifecycleSnapshot(ctx) };
  checks.push(await runCase("CLI-01 official services, version, and registration", () => inspectServices(ctx, api)));

  if (SUITE === "integration") {
    lifecycle.beforeCLI02 = contextLifecycleSnapshot(ctx);
    checks.push(await runCase("CLI-02 persistent cwd/environment/function state", async () => {
      await requireWsl(api, services, policy);
        return persistentState(ctx);
    }));
    lifecycle.afterCLI02 = contextLifecycleSnapshot(ctx);
    checks.push(await runCase("CLI-03 official wsl_bash tool executes", () => officialOneShot(
      ctx,
      "wsl_bash",
      MODE,
      "export DSH_CLI_LOCAL=kept; printf 'local=中文 空格 cwd=%s env=%s\\n' \"$PWD\" \"$DSH_CLI_LOCAL\"",
      "Print local WSL readiness output",
    )));
    checks.push(await runCase("CLI-03-SEAM executeWslBash helper", async () => {
      await requireWsl(api, services, policy);
      const command = "export DSH_CLI_LOCAL=kept; printf 'local=中文 空格 cwd=%s env=%s\\n' \"$PWD\" \"$DSH_CLI_LOCAL\"";
      const { result } = await runWsl(api, services, policy, command);
      assert(result.exitCode === 0, `one-shot WSL failed: ${sanitized(result.stderr.text)}`);
      assert(result.stdout.text.includes("local=中文 空格"), "one-shot WSL output lost Unicode/space data");
      return { exitCode: result.exitCode, marker: "local=中文 空格", truncated: result.stdout.truncated };
    }));
    checks.push(await runCase("CLI-04 official git_bash tool executes", () => officialOneShot(
      ctx,
      "git_bash",
      "danger-full-access",
      "printf 'local=中文 空格 cwd=%s\\n' \"$PWD\"",
      "Print local Git Bash readiness output",
    )));
    checks.push(await runCase("CLI-04-SEAM executeGitBash helper", async () => {
      const executable = await gitBashPath();
      if (executable === undefined) throw new CaseSkip("Git for Windows bash.exe was not found");
      const calls = [];
      const result = await api.executeGitBash(
        {
          command: "printf 'git=中文 空格 cwd=%s\\n' \"$PWD\"",
          description: "offline Git Bash CLI probe",
          workdir: WORKSPACE,
        },
        {
          // Git Bash is deliberately denied for read-only/workspace-write.
          // Exercise its native execution only under the explicit full-access
          // test mode; restricted denial and exact-retry zero-spawn are covered
          // separately in SEC-07/08.
          policy: { mode: "danger-full-access" },
          executable,
          platform: "win32",
          subprocess: observedSubprocess(services.subprocess, calls),
          memoryLimit: 16 * 1024,
          spillLimit: 64 * 1024,
        },
      );
      assert(result.exitCode === 0, `Git Bash failed: ${sanitized(result.stderr.text)}`);
      assert(result.stdout.text.includes("git=中文 空格"), "Git Bash output lost Unicode/space data");
      return { executable: executable.replaceAll(PROBE_ROOT, "<test-root>"), exitCode: result.exitCode, spawnCount: calls.length };
    }));
    checks.push(await runCase(
      "CLI-13 registered Git Bash workspace-root cwd regression",
      () => officialGitBashWorkdirDefaultsV2(ctx),
    ));
    checks.push(await runCase("CLI-05 persistent cancellation followed by explicit reaping", async () => {
      return officialPersistentCancellation(ctx);
    }));
    lifecycle.beforeCLI10 = contextLifecycleSnapshot(ctx);
    checks.push(await runCase("CLI-10 persistent timeout resets and next call is clean", async () => {
      return officialPersistentTimeoutReset(ctx);
    }));
    lifecycle.afterCLI10 = contextLifecycleSnapshot(ctx);
    checks.push(await runCase("CLI-11 official wsl_bash canonical cwd and invalid path zero-spawn boundary", async () => {
      return officialWslWorkdirBoundary(ctx, services);
    }));
    checks.push(await runCase("CLI-12 persistent output cap and next call remain usable", async () => {
      return officialPersistentOutputBound(ctx);
    }));
    checks.push(await runCase("CLI-06 concurrent persistent sends are serialized", async () => {
      return officialPersistentSerialization(ctx);
    }));
    lifecycle.beforeCLI07 = contextLifecycleSnapshot(ctx);
    checks.push(await runCase("CLI-07 preserved PowerShell tool executes", () => powerShellTool(ctx)));
    lifecycle.afterCLI07 = contextLifecycleSnapshot(ctx);
    checks.push(await runCase("CLI-08 Windows doctor is read-only", () => doctorReadOnly(api, ctx)));
    checks.push(await runCase("CLI-09 initialization cancellation sends zero commands", () => officialInitializationCancellation(ctx)));
  } else if (SUITE === "native-modes") {
    checks.push(await runCase("CLI-NATIVE-01 persistent service registration", () => inspectServices(ctx, api)));
    if (PERSISTENT_SHELL === "git-bash") {
      checks.push(await runCase("CLI-NATIVE-02 Git Bash restricted mode denies before spawn", () => nativeModePermissionFence(ctx)));
    }
    if (NATIVE_TIMEOUT_ONLY) {
      checks.push(await runCase("CLI-NATIVE-06 persistent timeout, exit, and reset cleanup", () => officialPersistentTimeoutReset(ctx)));
    } else {
      checks.push(await runCase("CLI-NATIVE-03 persistent state, cwd, function, and native argv", () => persistentState(ctx)));
      checks.push(await runCase("CLI-NATIVE-04 owner isolation and disposal", () => nativeModeOwnerIsolation(ctx)));
      checks.push(await runCase("CLI-NATIVE-05 persistent cancellation resets and reaps", () => officialPersistentCancellation(ctx)));
      checks.push(await runCase("CLI-NATIVE-06 persistent timeout, exit, and reset cleanup", () => officialPersistentTimeoutReset(ctx)));
      checks.push(await runCase("CLI-NATIVE-07 persistent output cap remains usable", () => officialPersistentOutputBound(ctx)));
      checks.push(await runCase("CLI-NATIVE-08 persistent calls serialize", () => officialPersistentSerialization(ctx)));
      checks.push(await runCase("CLI-NATIVE-09 startup failure leaves zero terminal state", () => nativeModeStartupFailure(ctx)));
      if (PERSISTENT_SHELL === "git-bash") {
        checks.push(await runCase("CLI-NATIVE-10 natural exit reaps delayed background", () => nativeNaturalExitLiveBackground(ctx)));
        checks.push(await runCase("CLI-NATIVE-11 natural exit reaps continuous noisy background", () => nativeNaturalExitNoisyBackground(ctx)));
      }
    }
  } else if (SUITE === "output-cap") {
    checks.push(await runCase(
      "CLI-OUTPUT-CAP-01 registered wsl_bash and git_bash cap malformed UTF-8",
      () => officialRegisteredMalformedUtf8Cap(ctx),
    ));
  } else if (SUITE === "git-workdir") {
    checks.push(await runCase(
      "CLI-GIT-WORKDIR-01 registered Git Bash omitted and relative cwd use the agent workspace",
      () => officialGitBashWorkdirDefaultsV2(ctx),
    ));
  } else {
    checks.push(await runCase("SEC-01 WSL capability preflight", () => requireWsl(api, services, policy).then(() => ({ available: true }))));
    checks.push(await runCase("SEC-02 sandbox mode write boundary", async () => {
      await requireWsl(api, services, policy);
      const path = ownedPath(WORKSPACE, `inside-${MODE}.marker`);
      const inside = wslPath(path);
      removeIfPresent(path);
      const { result } = await runWsl(api, services, policy, `printf 'inside-${MODE}' > ${bashQuote(inside)}`);
      const exists = existsSync(path);
      const expected = MODE === "read-only" ? false : true;
      assert(exists === expected, `workspace write expectation mismatch for ${MODE}: ${exists}`);
      if (MODE === "read-only") assert(result.exitCode !== 0, "read-only write unexpectedly returned success");
      else assert(result.exitCode === 0, `writable mode write failed: ${sanitized(result.stderr.text)}`);
      removeIfPresent(path);
      return { mode: MODE, exitCode: result.exitCode, markerCreated: exists, expectedMarker: expected };
    }));
    checks.push(await runCase("SEC-03 external fixture write remains outside the restricted bind", async () => {
      await requireWsl(api, services, policy);
      const path = marker(`external-${MODE}`);
      const external = wslPath(path);
      removeIfPresent(path);
      const { result } = await runWsl(api, services, policy, `printf 'external-${MODE}' > ${bashQuote(external)}`);
      const exists = existsSync(path);
      const expected = MODE === "danger-full-access";
      assert(exists === expected, `external marker expectation mismatch for ${MODE}: ${exists}`);
      if (expected) assert(result.exitCode === 0, "danger-full-access could not write the adjacent fixture");
      else assert(!exists, "restricted mode wrote outside the policy workspace");
      removeIfPresent(path);
      return { mode: MODE, exitCode: result.exitCode, markerCreated: exists, expectedMarker: expected };
    }));
    checks.push(await runCase("SEC-04 restricted WSL interop marker boundary", async () => {
      await requireWsl(api, services, policy);
      const path = marker(`interop-${MODE}`);
      const markerName = `interop-${MODE}.marker`;
      // Let Bash resolve the Unicode/space-bearing outside directory, then
      // give Windows CMD an ASCII-relative target. Passing the full Chinese
      // Windows path as a CMD /c argument is code-page sensitive and can turn
      // a valid fixture into a false "filename syntax" failure.
      const command = `cd ${bashQuote(wslPath(OUTSIDE))} && cmd.exe /d /c ${bashQuote(`echo dsh-interop > ${markerName}`)}`;
      removeIfPresent(path);
      const { result } = await runWsl(api, services, policy, command);
      const exists = existsSync(path);
      if (MODE === "danger-full-access") {
        if (result.exitCode !== 0 && /cmd\.exe: command not found/i.test(result.stderr.text)) {
          throw new CaseSkip("WSL cmd.exe interop executable is unavailable; full-access marker assertion cannot be exercised");
        }
        assert(result.exitCode === 0, `full-access Windows/WSL interop command failed: exit=${result.exitCode}, stdout=${sanitized(result.stdout.text)}, stderr=${sanitized(result.stderr.text)}`);
        assert(exists, `danger-full-access did not create the local interop fixture marker (exit=${result.exitCode}, stdout=${sanitized(result.stdout.text)}, stderr=${sanitized(result.stderr.text)})`);
      } else {
        // The same suite's danger-full-access case is the positive interop
        // control.  In a restricted mode, an interop command may be rejected
        // by the sandbox (including an exec-format/cannot-execute diagnostic),
        // but that is still the security boundary under test.  Do not turn
        // the expected denial into a capability skip; require both rejection
        // and absence of the outside marker.
        assert(!exists, "restricted WSL created a Windows-side marker through interop");
        assert(result.exitCode !== 0, "restricted WSL interop command unexpectedly succeeded");
      }
      removeIfPresent(path);
      return { mode: MODE, exitCode: result.exitCode, markerCreated: exists, markerPath: "<outside-fixture>" };
    }));
    checks.push(await runCase("SEC-05 symlink/junction escape is denied outside restricted workspace", async () => {
      await requireWsl(api, services, policy);
      const link = join(WORKSPACE, `link-${MODE}`);
      const targetMarker = marker(`symlink-${MODE}`);
      removeIfPresent(link);
      removeIfPresent(targetMarker);
      try {
        symlinkSync(OUTSIDE, link, "junction");
      } catch (error) {
        throw new CaseSkip(`Windows junction creation is unavailable: ${sanitized(error)}`);
      }
      try {
        const target = wslPath(join(link, `symlink-${MODE}.marker`));
        const { result } = await runWsl(api, services, policy, `printf symlink > ${bashQuote(target)}`);
        const exists = existsSync(targetMarker);
        const expected = MODE === "danger-full-access";
        assert(exists === expected, `symlink marker expectation mismatch for ${MODE}: ${exists}`);
        if (!expected) assert(result.exitCode !== 0, "restricted symlink write unexpectedly succeeded");
        return { mode: MODE, exitCode: result.exitCode, markerCreated: exists, expectedMarker: expected };
      } finally {
        removeIfPresent(link);
        removeIfPresent(targetMarker);
      }
    }));
    checks.push(await runCase("SEC-06 invalid workdir/path forms fail before command spawn", async () => {
      const config = api.resolveConfig({ wslExecutable: "wsl.exe", distro: process.env.DSH_WSL_DISTRO ?? "Ubuntu" });
      const invalid = [
        join(WORKSPACE, "..", "outside fixture 中文 space"),
        "\\\\server\\share",
        "\\\\?\\C:\\outside",
        "C:\\",
      ];
      const outcomes = [];
     for (const workdir of invalid) {
        const calls = [];
        const result = await api.executeWslBash(
          { command: "printf should-not-run", description: "invalid path zero-spawn probe", workdir },
          {
            policy,
            executable: "wsl.exe",
            distro: process.env.DSH_WSL_DISTRO ?? "Ubuntu",
            subprocess: observedSubprocess(services.subprocess, calls),
          },
        );
        const commandSpawnCount = calls.filter((call) => call.argv.includes("/usr/bin/bwrap")).length;
        assert(result.exitCode === null, `invalid workdir unexpectedly returned exit=${result.exitCode}`);
        assert(commandSpawnCount === 0, `invalid workdir launched ${commandSpawnCount} managed command(s)`);
        outcomes.push({ workdirKind: workdir.startsWith("C:\\") ? "drive-or-UNC" : "outside", failure: result.failure?.kind ?? null, observedSpawnCount: calls.length, commandSpawnCount });
     }
      return { rejected: outcomes.length, commandSpawnCount: 0, outcomes };
    }));
    checks.push(await runCase("SEC-06 official wsl_bash canonical cwd and zero-spawn boundary", async () => {
      return officialWslWorkdirBoundary(ctx, services);
    }));
    checks.push(await runCase("SEC-07 Git Bash restricted rejection starts zero children", async () => {
      const calls = [];
      const result = await api.executeGitBash(
        { command: "printf should-not-run", description: "restricted zero-spawn probe" },
        {
          policy: { mode: "workspace-write" },
          executable: "C:\\invalid\\missing\\bash.exe",
          platform: "win32",
          subprocess: observedSubprocess(services.subprocess, calls),
        },
      );
     assert(result.sandbox.denied === true, "restricted Git Bash was not denied");
     assert(calls.length === 0, `restricted Git Bash created ${calls.length} child process(es)`);
      return { denied: true, spawnCount: calls.length, failure: result.failure?.kind };
   }));
    const runSec08 = () => runCase("SEC-08 approval guard and official danger retry start zero children", async () => {
      const approvalTiming = { startedAt: Date.now() };
      const calls = [];
      const result = await api.executeGitBash(
        {
          command: "printf should-not-run",
          description: "rejected exact retry",
          sandbox_permissions: "workspace-write",
          justification: "test rejection",
        },
        {
          policy: { mode: "read-only" },
          executable: "C:\\invalid\\missing\\bash.exe",
          platform: "win32",
          approvalContext: {
            approver: services.approval,
            agent: { id: "cli-probe-agent" },
            callId: `reject-${process.pid}`,
            toolName: "git_bash",
            signal: new AbortController().signal,
          },
          subprocess: observedSubprocess(services.subprocess, calls),
        },
      );
      assert(result.sandbox.denied === true, "inexact approval retry was not denied");
      assert(calls.length === 0, `rejected retry created ${calls.length} child process(es)`);
      const agents = ctx.get("agents");
      if (agents === undefined || typeof agents.create !== "function") {
        throw new CaseSkip("official agent factory is unavailable for approval rejection");
      }
      let handle;
      try {
        handle = await createProbeAgent(ctx, { sessionId: randomUUID(), meta: { cwd: WORKSPACE } });
        const approvalSession = handle.agent.session;
        if (approvalSession === undefined || typeof approvalSession.append !== "function" || typeof approvalSession.snapshotEvents !== "function") {
          throw new CaseSkip("official approval policy/session audit API is unavailable");
        }
        approvalSession.append("turn/start", { turn: 1 });
        const neverPolicy = await setOfficialApprovalPolicy(ctx, handle.agent, "never");
        const effectiveMode = MODE === "danger-full-access" ? "workspace-write" : MODE;
        const officialCalls = [];
        const neverCallStartedAt = Date.now();
        const official = await api.executeGitBash(
          {
            command: "printf should-not-run",
            description: "official approval rejection zero-spawn probe",
            sandbox_permissions: "danger-full-access",
            justification: "prove official approval rejection is fail-closed",
          },
          {
            policy: { mode: effectiveMode },
            executable: "C:\\invalid\\missing\\bash.exe",
            platform: "win32",
            approvalContext: {
              approver: services.approval,
              agent: handle.agent,
              callId: randomUUID(),
              toolName: "git_bash",
              signal: new AbortController().signal,
            },
            subprocess: observedSubprocess(services.subprocess, officialCalls),
          },
        );
        approvalTiming.neverCallMs = Date.now() - neverCallStartedAt;
        const approvalDiagnostic = `${official.failure?.message ?? ""} ${official.stderr.text}`;
       assert(official.sandbox.denied === true, "official danger-full-access approval was not denied");
       assert(/approval|unavailable|rejected|open turn/i.test(approvalDiagnostic), `official approval path had no rejection/unavailable diagnostic: ${sanitized(approvalDiagnostic)}`);
       assert(officialCalls.length === 0, `official rejected approval created ${officialCalls.length} child process(es)`);
        const neverDecisions = approvalSession.snapshotEvents().filter((event) => event.type === "approval/decided");
        assert(neverDecisions.at(-1)?.data?.outcome === "rejected", `official never policy did not audit rejected: ${sanitized(neverDecisions.at(-1))}`);
        approvalSession.append("turn/end", { turn: 1, reason: { kind: "completed" } });
        approvalSession.append("turn/start", { turn: 2 });
        const askPolicy = await setOfficialApprovalPolicy(ctx, handle.agent, "ask");
        const askCalls = [];
        const askCallStartedAt = Date.now();
        const ask = await api.executeGitBash(
          {
            command: "printf should-not-run",
            description: "official ask unavailable zero-spawn probe",
            sandbox_permissions: "danger-full-access",
            justification: "prove ask without an answerer fails closed",
          },
          {
            policy: { mode: effectiveMode },
            executable: "C:\\invalid\\missing\\bash.exe",
            platform: "win32",
            approvalContext: {
              approver: services.approval,
              agent: handle.agent,
              callId: randomUUID(),
              toolName: "git_bash",
              signal: new AbortController().signal,
            },
            subprocess: observedSubprocess(services.subprocess, askCalls),
          },
        );
        approvalTiming.askCallMs = Date.now() - askCallStartedAt;
        const askDiagnostic = `${ask.failure?.message ?? ""} ${ask.stderr.text}`;
        assert(ask.sandbox.denied === true, "official ask approval was not denied");
        assert(/approval|unavailable|rejected/i.test(askDiagnostic), `official ask had no fail-closed diagnostic: ${sanitized(askDiagnostic)}`);
        assert(askCalls.length === 0, `official ask rejection created ${askCalls.length} child process(es)`);
        const askDecisions = approvalSession.snapshotEvents().filter((event) => event.type === "approval/decided");
        assert(askDecisions.at(-1)?.data?.outcome === "unavailable", `official ask did not audit unavailable: ${sanitized(askDecisions.at(-1))}`);
        approvalSession.append("turn/end", { turn: 2, reason: { kind: "completed" } });
        approvalTiming.turnEndMs = Date.now() - approvalTiming.startedAt;
        return {
          guard: { denied: true, spawnCount: calls.length, failure: result.failure?.kind },
          officialApproval: {
            requestedMode: "danger-full-access",
            effectiveMode,
            neverOutcome: neverDecisions.at(-1)?.data?.outcome,
            askOutcome: askDecisions.at(-1)?.data?.outcome,
            auditPairs: true,
            denied: true,
            diagnostic: sanitized(`${approvalDiagnostic} ${askDiagnostic}`),
            spawnCount: officialCalls.length + askCalls.length,
            policySetup: { never: neverPolicy, ask: askPolicy },
            timingMs: approvalTiming,
          },
        };
      } finally {
        if (handle?.dispose) {
          const ownedHandle = handle;
          const disposeApprovalAgent = async () => {
            const disposeStartedAt = Date.now();
            await ownedHandle.dispose();
            approvalTiming.disposeMs = Date.now() - disposeStartedAt;
          };
          if (process.env.DSH_DESKTOP_PROBE === "1") {
            // In the Desktop composition, disposing this policy-mutated child
            // immediately can retire the probe's own scoped services. Keep the
            // owner alive until every security assertion has consumed those
            // services, then dispose it before returning structured evidence.
            deferredDesktopCleanup.push(disposeApprovalAgent);
          } else {
            try { await disposeApprovalAgent(); } catch {}
          }
        }
      }
    });
    checks.push(await runCase("SEC-09 missing sandbox dependency fails closed", async () => {
      const calls = [];
      const result = await api.executeWslBash(
        { command: "printf should-not-run", description: "missing bwrap fixture", workdir: WORKSPACE },
        {
          policy,
          executable: "wsl.exe",
          distro: process.env.DSH_WSL_DISTRO ?? "Ubuntu",
          probeRuntime: async () => ({ ok: false, message: "bwrap/script fixture unavailable" }),
          subprocess: observedSubprocess(services.subprocess, calls),
        },
      );
      assert(result.failure?.kind === "sandbox-unavailable", `unexpected failure kind: ${result.failure?.kind}`);
      assert(!calls.some((call) => call.argv.includes("/usr/bin/bwrap")), "missing sandbox preflight reached bwrap command spawn");
      return { failure: result.failure.kind, commandSpawned: false, canonicalizationCalls: calls.length };
    }));
    checks.push(await runCase("SEC-10 timeout cancels and reaps a one-shot process tree", async () => {
      await requireWsl(api, services, policy);
      const readOnly = MODE === "read-only";
      const leakMarker = ownedPath(WORKSPACE, `timeout-child-${MODE}.marker`);
      removeIfPresent(leakMarker);
      let readinessPromise;
      const command = readOnly
        ? "printf started; sleep 5"
        : `(printf started; (sleep 5; printf leaked > ${bashQuote(wslPath(leakMarker))}) & child=$!; wait "$child")`;
      const timed = await runWsl(api, services, policy, command, {
        timeoutMs: 2_000,
        onSpawn: (spec, handle) => {
          if (spec.argv.includes("/usr/bin/bwrap")) readinessPromise = waitForCollectedOutput(handle, "started", 1_500);
        },
      });
      const readiness = await (readinessPromise ?? { ready: false, text: "" });
      assert(readiness.ready, "timeout probe did not reach its bounded stdout readiness barrier");
      assert(timed.calls.some((call) => call.argv.includes("/usr/bin/bwrap")), "timeout probe did not spawn the managed WSL command");
      assert(timed.result.timedOut === true, "one-shot timeout did not report timedOut=true");
      assert(timed.result.failure?.kind === "timeout", "one-shot timeout did not report failure.kind=timeout");
      if (readOnly) assert(timed.result.stdout.text.includes("started"), "read-only timeout did not reach its stdout readiness marker");
      for (const handle of timed.handles) assert(await handle.waitForExit(), "timed-out managed process did not report quiescence");
      await new Promise((resolve) => setTimeout(resolve, 2_500));
      if (!readOnly) assert(!existsSync(leakMarker), "timed-out child remained alive long enough to write its marker");
      removeIfPresent(leakMarker);
      return { timedOut: true, failure: timed.result.failure.kind, ready: "stdout", readinessBarrierMs: "<=1500", spawnCount: timed.handles.length, managedWaitForExit: true, managedQuiescent: true, tree: "reaped" };
    }));
    checks.push(await runCase("SEC-11 caller cancellation aborts and reaps a one-shot process", async () => {
      const readOnly = MODE === "read-only";
      const leakMarker = ownedPath(WORKSPACE, `cancel-child-${MODE}.marker`);
      removeIfPresent(leakMarker);
      const controller = new AbortController();
      let commandSpawned = false;
      let readinessPromise;
      const command = readOnly
        ? "printf started; sleep 2"
        : `(printf started; (sleep 2; printf leaked > ${bashQuote(wslPath(leakMarker))}) & child=$!; wait "$child")`;
      const pending = runWsl(api, services, policy, command, {
        signal: controller.signal,
        timeoutMs: 30_000,
        onSpawn: (spec, handle) => {
          if (!commandSpawned && spec.argv.includes("/usr/bin/bwrap")) {
            commandSpawned = true;
            readinessPromise = waitForCollectedOutput(handle, "started").then((readiness) => {
              controller.abort(new Error("CLI probe cancellation"));
              return readiness;
            });
          }
        },
      });
      const cancelled = await pending;
      const readiness = await (readinessPromise ?? { ready: false, text: "" });
      assert(commandSpawned, "cancellation probe did not spawn the managed WSL command");
      assert(readiness.ready, "cancellation probe did not reach its bounded stdout readiness barrier");
      assert(cancelled.result.aborted === true, "caller cancellation did not report aborted=true");
      assert(cancelled.result.failure?.kind === "aborted", "caller cancellation did not report failure.kind=aborted");
      if (readOnly) assert(cancelled.result.stdout.text.includes("started"), "read-only cancellation did not reach its stdout readiness marker");
      for (const handle of cancelled.handles) assert(await handle.waitForExit(), "cancelled managed process did not report quiescence");
      await new Promise((resolve) => setTimeout(resolve, 2_500));
      if (!readOnly) assert(!existsSync(leakMarker), "cancelled child remained alive long enough to write its marker");
      removeIfPresent(leakMarker);
      return { aborted: true, failure: cancelled.result.failure.kind, ready: "stdout", readinessBarrierMs: "<=5000", spawnCount: cancelled.handles.length, managedWaitForExit: true, managedQuiescent: true, tree: "reaped" };
    }));
    checks.push(await runCase("SEC-12 captured output is explicitly bounded", async () => {
      await requireWsl(api, services, policy);
      const { result } = await runWsl(api, services, policy, "yes X | head -c 8192", { memoryLimit: 1024, spillLimit: 2048 });
      assert(result.stdout.truncated === true, "large output was not marked truncated");
      assert((result.stdout.totalBytes ?? 0) >= 8192, "captured output did not expose the full stream cursor");
      const visibleBytes = Buffer.byteLength(result.stdout.text);
      assert(visibleBytes <= 1024, `captured output exceeded the 1024-byte visible cap: ${visibleBytes}`);
      return { truncated: result.stdout.truncated, totalBytes: result.stdout.totalBytes ?? null, visibleBytes };
    }));
    lifecycle.beforeSEC13 = contextLifecycleSnapshot(ctx);
    checks.push(await runCase("SEC-13 owner isolation covers read/signal/close/dispose/natural exit", async () => {
      const agents = ctx.get("agents");
      if (agents === undefined || typeof agents.create !== "function") {
        throw new CaseSkip("official agents service/factory is unavailable in this CLI composition");
      }
      let first;
      let second;
      let firstSession;
      let secondSession;
      let firstDisposed = false;
      try {
        first = await createProbeAgent(ctx, { sessionId: randomUUID(), meta: { cwd: WORKSPACE } });
        second = await createProbeAgent(ctx, { sessionId: randomUUID(), meta: { cwd: WORKSPACE } });
        firstSession = await services.terminals.spawn(first.agent, { type: "wsl", cwd: WORKSPACE });
        secondSession = await services.terminals.spawn(second.agent, { type: "wsl", cwd: WORKSPACE });
        const attempts = [
          ["startSend", () => services.terminals.startSend(first.agent, secondSession.sessionId, { text: "printf should-not-run", submit: true })],
          ["read", () => services.terminals.read(first.agent, secondSession.sessionId, { count: 10 })],
          ["signal", () => services.terminals.signal(first.agent, secondSession.sessionId, "SIGINT")],
          ["close", () => services.terminals.kill(first.agent, secondSession.sessionId, "foreign close probe")],
        ];
        const rejected = [];
        for (const [name, attempt] of attempts) {
          let foreignError;
          try {
            await Promise.resolve(attempt());
          } catch (error) {
            foreignError = error;
          }
          assert(foreignError !== undefined, `Agent A ${name} unexpectedly operated Agent B's session`);
          assert(foreignError.code === "FOREIGN_SESSION", `unexpected ${name} owner-fence error: ${sanitized(foreignError)}`);
          rejected.push(name);
        }
        assert(services.terminals.list(first.agent).every((entry) => entry.sessionId !== secondSession.sessionId), "Agent A could list Agent B's session");
        assert(services.terminals.list(second.agent).some((entry) => entry.sessionId === secondSession.sessionId), "Agent B session did not remain alive after foreign attempts");
        await first.dispose();
        firstDisposed = true;
        assert(services.terminals.list(second.agent).some((entry) => entry.sessionId === secondSession.sessionId), "Agent A dispose closed Agent B's session");
        const alive = services.terminals.startSend(second.agent, secondSession.sessionId, { text: "printf owner-b-alive", submit: true });
        const aliveResult = await alive.done;
        assert(aliveResult.viewport.includes("owner-b-alive"), "Agent B could not send after Agent A dispose");
        const natural = services.terminals.startSend(second.agent, secondSession.sessionId, { text: "exit", submit: true });
        const naturalResult = await natural.done;
        assert(naturalResult.sessionStatus.kind === "exited", `Agent B did not report natural exit: ${sanitized(naturalResult.sessionStatus)}`);
        if (services.terminals.list(second.agent).some((entry) => entry.sessionId === secondSession.sessionId)) {
          await services.terminals.kill(second.agent, secondSession.sessionId, "natural exit cleanup");
        }
        const naturalActivityCleared = await waitForNoOwnerActivity(services.terminals, second.agent);
        assert(naturalActivityCleared, "natural exit left Agent B terminal activity registered");
        assert(services.terminals.list(second.agent).length === 0, "natural exit left an owner-visible terminal entry");
        return {
          foreignOperationsRejected: rejected,
          ownerAListHiddenB: true,
          ownerADisposed: firstDisposed,
          ownerBStayedAlive: true,
          ownerBNaturalExit: true,
          naturalExitStatus: naturalResult.sessionStatus.kind,
          ownerBNaturalCloseAwaited: true,
          ownerBNaturalActivityCleared: true,
          ownerBNaturalListEmpty: true,
        };
      } catch (error) {
        if (error?.code === "NO_FACTORY" || /no agent factory|agent factory/i.test(String(error?.message))) {
          throw new CaseSkip(`agent factory is unavailable: ${sanitized(error)}`);
        }
        throw error;
      } finally {
        if (firstSession !== undefined) {
          try { await services.terminals.kill(first.agent, firstSession.sessionId, "owner isolation finally"); } catch {}
        }
        if (secondSession !== undefined) {
          try { await services.terminals.kill(second.agent, secondSession.sessionId, "owner isolation finally"); } catch {}
        }
        if (first?.dispose) {
          try { await first.dispose(); } catch {}
        }
        if (second?.dispose) {
          try { await second.dispose(); } catch {}
        }
      }
    }));
    lifecycle.afterSEC13 = contextLifecycleSnapshot(ctx);
    lifecycle.beforeSEC14 = contextLifecycleSnapshot(ctx);
    checks.push(await runCase("SEC-14 live persistent mode mutation remains fail-closed", async () => {
      const agents = ctx.get("agents");
      if (agents === undefined || typeof agents.create !== "function") {
        throw new CaseSkip("official agents service/factory is unavailable in this CLI composition");
      }
      let handle;
      let terminalSession;
      try {
        handle = await createProbeAgent(ctx, { sessionId: randomUUID(), meta: { cwd: WORKSPACE } });
        const agent = handle.agent;
        terminalSession = await services.terminals.spawn(agent, { type: "wsl", cwd: WORKSPACE });
        const session = agent.session;
        if (session === undefined || typeof session.append !== "function" || typeof session.snapshotEvents !== "function") {
          throw new CaseSkip("real Agent session append/snapshot API is unavailable");
        }
        const nextMode = MODE === "danger-full-access" ? "workspace-write" : "danger-full-access";
        const beforeSeq = session.seq;
        let mutationError;
        try {
          session.append("sandbox/mode", { mode: nextMode });
        } catch (error) {
          mutationError = error;
        }
        assert(mutationError !== undefined, "live session mode mutation was accepted while a persistent terminal was active");
        assert(/cannot change sandbox mode|persistent terminal sessions are open/i.test(String(mutationError)), `unexpected live mode fence error: ${sanitized(mutationError)}`);
        assert(session.seq === beforeSeq, "rejected live mode mutation changed the session log");
        await services.terminals.kill(agent, terminalSession.sessionId, "mode fence probe");
        let afterCloseError;
        try {
          session.append("sandbox/mode", { mode: nextMode });
        } catch (error) {
          afterCloseError = error;
        }
        assert(afterCloseError === undefined, `mode mutation stayed blocked after terminal close: ${sanitized(afterCloseError)}`);
        return { activeMutationRejected: true, sessionLogUnchanged: true, mutationAfterCloseAccepted: true };
      } catch (error) {
        if (error?.code === "NO_FACTORY" || /no agent factory|agent factory/i.test(String(error?.message))) {
          throw new CaseSkip(`agent factory is unavailable: ${sanitized(error)}`);
        }
        throw error;
      } finally {
        if (terminalSession !== undefined && handle?.agent !== undefined) {
          try { await services.terminals.kill(handle.agent, terminalSession.sessionId, "mode fence finally"); } catch {}
        }
        if (handle?.dispose) {
          try { await handle.dispose(); } catch {}
        }
      }
    }));
    lifecycle.afterSEC14 = contextLifecycleSnapshot(ctx);
    checks.push(await runCase("SEC-15 WSL command framing and metadata special characters", async () => {
      await requireWsl(api, services, policy);
      const literal = "literal $(printf injected) ; & | >";
      const command = `printf '%s' ${bashQuote(literal)}`;
      const description = "description $(touch should-not-run) ; & | >";
      const { result, calls } = await runWsl(api, services, policy, command, { description });
      assert(result.exitCode === 0, `special-character WSL command failed: ${sanitized(result.stderr.text)}`);
      assert(result.stdout.text.includes(literal), "WSL command text was not preserved as one shell command");
      const encodedCommand = Buffer.from(command, "utf8").toString("base64");
      const encodedArgCount = calls.flatMap((call) => call.argv).filter((arg) => arg === encodedCommand).length;
      assert(encodedArgCount === 1, `WSL command was not one encoded argv value: count=${encodedArgCount}`);
      return { exitCode: result.exitCode, encodedArgCount, stdoutLiteral: true, descriptionSpecialCharacters: true };
    }));
    checks.push(await runCase("SEC-16 Git Bash timeout/cancellation reaping", async () => {
      const executable = await gitBashPath();
      if (executable === undefined) throw new CaseSkip("Git for Windows bash.exe was not found");
      const timedCalls = [];
      const timedHandles = [];
      const timed = await api.executeGitBash(
        { command: "printf started; sleep 5", description: "Git Bash timeout lifecycle", workdir: WORKSPACE, timeoutMs: 1_500 },
        {
          policy: { mode: "danger-full-access" },
          executable,
          platform: "win32",
          subprocess: observedSubprocess(services.subprocess, timedCalls, timedHandles),
        },
      );
     assert(timed.timedOut === true && timed.failure?.kind === "timeout", "Git Bash timeout was not classified");
      assert(timed.stdout.text.includes("started"), "Git Bash timeout did not reach its stdout readiness marker");
     for (const handle of timedHandles) assert(await handle.waitForExit(), "Git Bash timeout handle did not quiesce");
      const controller = new AbortController();
      const cancelCalls = [];
      const cancelHandles = [];
      let readinessPromise;
      const pending = api.executeGitBash(
        { command: "printf started; sleep 5", description: "Git Bash cancellation lifecycle", workdir: WORKSPACE, timeoutMs: 30_000 },
        {
          policy: { mode: "danger-full-access" },
          executable,
          platform: "win32",
          signal: controller.signal,
          subprocess: observedSubprocess(services.subprocess, cancelCalls, cancelHandles, (spec, handle) => {
            if (spec.argv.includes("-c")) {
              readinessPromise = waitForCollectedOutput(handle, "started", 1_500).then((readiness) => {
                controller.abort(new Error("Git Bash cancellation probe"));
                return readiness;
              });
            }
          }),
        },
      );
      const cancelled = await pending;
      const readiness = await (readinessPromise ?? { ready: false, text: "" });
      assert(readiness.ready, "Git Bash cancellation did not reach its bounded stdout readiness barrier");
      assert(cancelled.aborted === true && cancelled.failure?.kind === "aborted", "Git Bash cancellation was not classified");
      for (const handle of cancelHandles) assert(await handle.waitForExit(), "Git Bash cancellation handle did not quiesce");
      return {
        timeout: { timedOut: true, failure: timed.failure?.kind, ready: "stdout", spawnCount: timedHandles.length, managedWaitForExit: true, managedQuiescent: true, tree: "reaped" },
        cancellation: { aborted: true, failure: cancelled.failure?.kind, readinessBarrierMs: "<=1500", spawnCount: cancelHandles.length, managedWaitForExit: true, managedQuiescent: true, tree: "reaped" },
      };
    }));
    // The real Desktop `ask` path may wait for its bounded no-answerer timeout
    // and retire this probe's scoped services. Run that exact zero-spawn check
    // last so the timeout cannot prevent the other required security controls
    // from executing; CLI still runs the same assertion and cleanup.
    lifecycle.beforeSEC08 = contextLifecycleSnapshot(ctx);
    checks.push(await runSec08());
    lifecycle.afterSEC08 = contextLifecycleSnapshot(ctx);
  }
  for (const cleanup of deferredDesktopCleanup) {
    try {
      await cleanup();
    } catch (error) {
      checks.push({
        id: "SEC-08 desktop deferred approval owner cleanup",
        status: "FAIL",
        detail: sanitized(error?.stack ?? error),
        durationMs: 0,
      });
    }
  }
  return {
    schemaVersion: 1,
    suite: SUITE,
    mode: MODE,
    status: checks.some((check) => check.status === "FAIL") ? "FAIL" : checks.some((check) => check.status === "SKIP") ? "SKIP" : "PASS",
    checks,
    lifecycle,
  };
}

export const name = "dsh-cli-probe";
export const inject = [
  "tools",
  "terminals",
  "subprocess",
  "sandboxPolicy",
  "approval",
  "profileContext",
  "appExit",
  "agents",
];

export function apply(ctx) {
  queueMicrotask(async () => {
    let evidence;
    try {
      evidence = await main(ctx);
    } catch (error) {
      evidence = {
        schemaVersion: 1,
        suite: SUITE,
        mode: MODE,
        status: "FAIL",
        checks: [{ id: "CLI-PROBE-STARTUP", status: "FAIL", detail: sanitized(error?.stack ?? error) }],
      };
    }
    const resultFile = process.env.DSH_PROBE_RESULT_FILE;
    if (resultFile !== undefined) {
      try { writeFileSync(resultFile, `${JSON.stringify(evidence)}\n`, "utf8"); } catch {}
    }
    process.stdout.write(`DSH_CLI_PROBE_RESULT ${JSON.stringify(evidence)}\n`);
    // The real Desktop host owns shutdown for this validation child. Keep the
    // actual appExit service injected and suppress only this probe's terminal
    // exit request; the Windows CLI path retains its normal appExit lifecycle.
    if (process.env.DSH_DESKTOP_PROBE === "1") return;
    const exit = ctx.get("appExit");
    if (typeof exit === "function") exit(evidence.status === "FAIL" ? 1 : 0);
    else process.exitCode = evidence.status === "FAIL" ? 1 : 0;
  });
}
