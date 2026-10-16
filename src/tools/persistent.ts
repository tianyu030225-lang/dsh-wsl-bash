/**
 * Persistent tool adapted from the MIT-licensed DeepSeek
 * dsh-tool-bash-persistent 0.2.0-rc.2 / 0.2.1-alpha.1, Copyright (c) 2026 DeepSeek.
 * Both supported hosts ship identical tool code. Keep its public ownership,
 * initialization, serialization, deadline and reset contract; additionally use
 * real incremental completion frames and bound the fallback accumulator.
 */
import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { defineTool, type ToolRunContext } from "@deepseek-ai/dsh-tools";
import type {} from "@deepseek-ai/dsh-terminal";
import { createDshHostRequire } from "../runtime.js";

type Owner = NonNullable<ToolRunContext["agent"]>;
type SessionId = Awaited<ReturnType<Context["terminals"]["spawn"]>>["sessionId"];
type Snapshot = { text: string; truncated: boolean };
type Capture = { text: string; incomplete: boolean; exitCode?: number };
type Markers = { start: string; end: string };
interface PersistentConfig {
  backendType: string;
  timeoutMs: number;
  maxOutputChars: number;
  description: string;
}
interface DeadlineApi {
  deadline(signal: AbortSignal, milliseconds: number, code: string): {
    signal: AbortSignal;
    [Symbol.dispose](): void;
  };
  timeoutOf(signal: AbortSignal, code: string): { timeoutMs: number } | undefined;
}
interface RetentionApi {
  truncateWithoutSplittingSurrogatePair(text: string, limit: number): string;
}

const DEFAULT_DESCRIPTION = "Run commands in a persistent bash shell. State, including the current directory and exported environment variables, persists across calls for this agent.";
const CLIPPED = "<response clipped><NOTE>To save on context only part of this file has been shown to you. You should retry this tool after you have searched inside the file with \u0060grep -n\u0060 in order to find the line numbers of what you are looking for.</NOTE>";
const LOST_PREFIX = "<response clipped><NOTE>The beginning of this command output was dropped by the terminal scrollback limit. The following text is the earliest retained output.</NOTE>\n";
const RESET_MESSAGE = "The persistent bash shell was reset; the next bash call starts from the workspace with a fresh current directory and environment.";
const TIMEOUT_CODE = "PERSISTENT_BASH_TIMEOUT";
const PAGE_LINES = 1000;
const MAX_FALLBACK_BYTES = 262_144;

function quoteForBash(value: string): string {
  return "$'" + value.replaceAll("\\", "\\\\").replaceAll("'", "\\'").replaceAll("\r", "\\r").replaceAll("\n", "\\n") + "'";
}

function commandOutput(snapshot: Snapshot, marker: Markers): Capture | undefined {
  const end = snapshot.text.lastIndexOf(marker.end);
  if (end < 0) return undefined;
  const status = /^(\d+)\r?\n/.exec(snapshot.text.slice(end + marker.end.length))?.[1];
  if (status === undefined) return undefined;
  const exitCode = Number(status);
  if (!Number.isSafeInteger(exitCode) || exitCode < 0 || exitCode > 255) return undefined;
  const startMarker = snapshot.text.lastIndexOf(marker.start, end);
  const start = startMarker < 0 ? 0 : startMarker + marker.start.length;
  return {
    text: snapshot.text.slice(start, end).replace(/^\r?\n/, "").replace(/(?:\r?\n)+$/, ""),
    incomplete: startMarker < 0,
    exitCode,
  };
}

function boundedFallback(text: string, truncated: boolean): Snapshot {
  if (Buffer.byteLength(text) <= MAX_FALLBACK_BYTES) return { text, truncated };
  const bytes = Buffer.from(text);
  let offset = bytes.length - MAX_FALLBACK_BYTES;
  while (offset < bytes.length && (bytes[offset]! & 0xc0) === 0x80) offset += 1;
  return { text: bytes.subarray(offset).toString("utf8"), truncated: true };
}

function partialOutput(snapshot: Snapshot, marker: Markers, fallback: Snapshot): Capture {
  const start = snapshot.text.lastIndexOf(marker.start);
  if (start >= 0) return {
    text: snapshot.text.slice(start + marker.start.length).replace(/^\r?\n/, "").replace(/(?:\r?\n)+$/, ""),
    incomplete: false,
  };
  const fallbackStart = fallback.text.lastIndexOf(marker.start);
  const afterStart = fallbackStart < 0 ? fallback.text : fallback.text.slice(fallbackStart + marker.start.length).replace(/^\r?\n/, "");
  const end = afterStart.lastIndexOf(marker.end);
  return {
    text: (end < 0 ? afterStart : afterStart.slice(0, end)).replace(/(?:\r?\n)+$/, ""),
    incomplete: fallback.truncated || fallbackStart < 0,
  };
}

export const name = "bash-wsl-persistent-tool";
export const inject = ["tools", "terminals", "profileContext"] as const;
export const Config = z.object({
  backendType: z.string().default("wsl"),
  timeoutMs: z.number().default(300_000),
  maxOutputChars: z.number().default(16_000),
  description: z.string().default(DEFAULT_DESCRIPTION),
});

export async function apply(ctx: Context, config: Partial<PersistentConfig> = {}): Promise<void> {
  const resolved: PersistentConfig = {
    backendType: config.backendType ?? "wsl",
    timeoutMs: config.timeoutMs ?? 300_000,
    maxOutputChars: config.maxOutputChars ?? 16_000,
    description: config.description ?? DEFAULT_DESCRIPTION,
  };
  if (resolved.backendType.trim().length === 0 || resolved.description.trim().length === 0
    || !Number.isSafeInteger(resolved.timeoutMs) || resolved.timeoutMs <= 0
    || !Number.isSafeInteger(resolved.maxOutputChars) || resolved.maxOutputChars <= 0) {
    throw new Error("bash-wsl-persistent-tool: invalid configuration");
  }
  const anchor = ctx.profileContext?.installAnchor;
  if (typeof anchor !== "string" || anchor.length === 0) throw new Error("Persistent Bash requires the actual host installAnchor");
  const hostRequire = createDshHostRequire(anchor);
  const [timeouts, retention] = await Promise.all([
    import(pathToFileURL(hostRequire.resolve("@deepseek-ai/dsh-timeout")).href) as Promise<DeadlineApi>,
    import(pathToFileURL(hostRequire.resolve("@deepseek-ai/dsh-output-retention")).href) as Promise<RetentionApi>,
  ]);
  if (typeof timeouts.deadline !== "function" || typeof timeouts.timeoutOf !== "function"
    || typeof retention.truncateWithoutSplittingSurrogatePair !== "function") {
    throw new Error("Persistent Bash host deadline/output services are unavailable");
  }
  const render = (capture: Capture): string => {
    const clipped = capture.text.length > resolved.maxOutputChars || capture.incomplete;
    const text = retention.truncateWithoutSplittingSurrogatePair(capture.text, resolved.maxOutputChars) + (clipped ? CLIPPED : "");
    const prefix = capture.incomplete && capture.text.length > 0 ? LOST_PREFIX : "";
    return prefix + text + (capture.exitCode === undefined ? "" : (text.length > 0 ? "\n" : "") + "[Command finished with exit code " + capture.exitCode + "]");
  };
  const scrollback = (owner: Owner, id: SessionId): Snapshot => {
    const latest = ctx.terminals.read(owner, id, { offset: 0, count: PAGE_LINES });
    const pages = latest.text.length === 0 ? [] : [latest.text];
    let offset = latest.lineEnd;
    let truncated = latest.truncated;
    while (offset < latest.totalLines) {
      const page = ctx.terminals.read(owner, id, { offset, count: PAGE_LINES });
      truncated ||= page.truncated;
      if (page.text.length > 0) pages.unshift(page.text);
      if (page.text.length === 0 || page.lineEnd <= offset || page.lineEnd >= page.totalLines) break;
      offset = page.lineEnd;
    }
    return { text: pages.join("\n"), truncated };
  };
  const pending = new WeakMap<Owner, Promise<SessionId>>();
  const live = new Map<Owner, SessionId>();
  const creating = new Set<Promise<SessionId>>();
  const ownerCleanup = new WeakSet<Owner>();
  const lifecycle = new AbortController();
  const close = async (owner: Owner, id: SessionId, reason: string): Promise<void> => {
    if (ctx.terminals.list(owner).some((row) => row.sessionId === id)) await ctx.terminals.kill(owner, id, reason);
  };
  ctx.effect(() => async () => {
    lifecycle.abort(new Error("persistent Bash disposed during shell creation"));
    await Promise.allSettled([...creating]);
    await Promise.all([...live].map(([owner, id]) => close(owner, id, "persistent Bash disposed")));
    live.clear();
  }, "bash-wsl persistent shell cleanup");
  const reset = async (owner: Owner, reason: string): Promise<void> => {
    pending.delete(owner);
    const id = live.get(owner);
    live.delete(owner);
    if (id !== undefined) await close(owner, id, reason);
  };
  const get = (owner: Owner, signal: AbortSignal): Promise<SessionId> => {
    const existing = pending.get(owner);
    if (existing !== undefined) return existing;
    const combinedSignal = AbortSignal.any([signal, lifecycle.signal]);
    const tracked = (async () => {
      try {
        const cwd = owner.session.header.cwd;
        const spawned = await ctx.terminals.spawn(owner, { type: resolved.backendType, ...(cwd === undefined ? {} : { cwd }) }, combinedSignal);
        live.set(owner, spawned.sessionId);
        if (!ownerCleanup.has(owner)) {
          ownerCleanup.add(owner);
          owner.ctx.effect(() => () => { pending.delete(owner); live.delete(owner); }, "bash-wsl persistent owner cache cleanup");
        }
        const result = await ctx.terminals.startSend(owner, spawned.sessionId, { text: "stty -echo", submit: true, signal: combinedSignal }).done;
        if (result.sessionStatus.kind === "exited" || result.waitReason === "timeout") throw new Error("persistent Bash did not accept initialization");
        return spawned.sessionId;
      } catch (error) {
        await reset(owner, "persistent Bash initialization failed");
        throw error;
      }
    })().finally(() => { creating.delete(tracked); });
    creating.add(tracked);
    pending.set(owner, tracked);
    return tracked;
  };
  const execute = async (owner: Owner, command: string, upstream: AbortSignal): Promise<string> => {
    const commandDeadline = timeouts.deadline(upstream, resolved.timeoutMs, TIMEOUT_CODE);
    let cancellationCleanup: Promise<void> | undefined;
    const onCancellation = (): void => {
      // A foreground interrupt may leave operation.done waiting for background
      // output. Start owner-scoped termination without waiting for that handoff.
      cancellationCleanup ??= reset(owner, "persistent Bash command aborted");
      cancellationCleanup.catch(() => {});
    };
    upstream.addEventListener("abort", onCancellation, { once: true });
    try {
      if (upstream.aborted) { onCancellation(); return ""; }
      let id: SessionId;
      try { id = await get(owner, commandDeadline.signal); }
      catch (error) { if (upstream.aborted && error === upstream.reason) return ""; throw error; }
      if (upstream.aborted) {
        await reset(owner, "persistent Bash cancelled during shell creation");
        return "";
      }
      const nonce = randomUUID();
      const marker = { start: "__DSH_PERSISTENT_BASH_START_" + nonce + "__", end: "__DSH_PERSISTENT_BASH_END_" + nonce + ":" };
      const wrapped = "printf '%s\\n' " + quoteForBash(marker.start) + "; eval -- " + quoteForBash(command)
        + "; __dsh_persistent_bash_status=$?; printf '%s%s\\n' " + quoteForBash(marker.end) + " \"$__dsh_persistent_bash_status\"";
      let first = true;
      let fallback: Snapshot = { text: "", truncated: false };
      const timedOutResult = async (timeout: { timeoutMs: number }): Promise<string> => {
        const partial = render(partialOutput(scrollback(owner, id), marker, fallback));
        await reset(owner, "persistent Bash command timed out");
        return "Your command timed out after " + Math.round(timeout.timeoutMs / 1000) + " seconds or experienced an OOM error. Below is partial output:\n"
          + partial + (partial.length > 0 ? "\n" : "") + "[Command timed out or OOM]\n" + RESET_MESSAGE;
      };
      const exited = async (status: { exitCode: number | null; signal: string | null }): Promise<string> => {
        const partial = render(partialOutput(scrollback(owner, id), marker, fallback));
        await reset(owner, "persistent Bash shell exited");
        const statusText = status.signal !== null ? "[shell killed by signal: " + status.signal + "]"
          : status.exitCode !== null ? "[shell exited: code " + status.exitCode + "]" : "[shell exited]";
        return (partial.length > 0 ? partial + "\n" : "") + statusText + "\n" + RESET_MESSAGE;
      };
      for (;;) {
        if (upstream.aborted) return "";
        const timedOutBeforeSend = timeouts.timeoutOf(commandDeadline.signal, TIMEOUT_CODE);
        if (timedOutBeforeSend !== undefined) return await timedOutResult(timedOutBeforeSend);
        const status = ctx.terminals.list(owner).find((row) => row.sessionId === id)?.status;
        if (status?.kind === "exited") return await exited(status);
        let operation;
        let result;
        try {
          operation = ctx.terminals.startSend(owner, id, { text: first ? wrapped : "", submit: first, signal: commandDeadline.signal });
          first = false;
          result = await operation.done;
        } catch (error) {
          if (upstream.aborted) return "";
          const timedOutDuringSend = timeouts.timeoutOf(commandDeadline.signal, TIMEOUT_CODE);
          if (timedOutDuringSend !== undefined) return await timedOutResult(timedOutDuringSend);
          await reset(owner, "persistent Bash send failed");
          throw error;
        }
        if (upstream.aborted) return "";
        const incremental = operation.readOutput();
        const fromIncremental = commandOutput({ text: incremental.delta, truncated: incremental.truncated }, marker);
        fallback = boundedFallback(incremental.delta.length > 0 ? fallback.text + incremental.delta
          : fallback.text.length > 0 ? fallback.text : result.viewport,
          fallback.truncated || incremental.truncated || result.truncated);
        const latest = ctx.terminals.read(owner, id, { offset: 0, count: PAGE_LINES });
        const timedOut = timeouts.timeoutOf(commandDeadline.signal, TIMEOUT_CODE);
        if (timedOut !== undefined) return await timedOutResult(timedOut);
        if (commandDeadline.signal.aborted) { await reset(owner, "persistent Bash command aborted"); return ""; }
        // The newest scrollback page may already have lost the real END frame
        // to background output. Preserve completion from the operation itself.
        const fromFallback = commandOutput(fallback, marker);
        const fromScrollback = latest.text.includes(marker.end) ? commandOutput(scrollback(owner, id), marker) : undefined;
        // Prefer a capture containing START as well as END, so a split operation
        // cannot discard an earlier output prefix merely because its final delta
        // contains a complete END frame. A clipped capture remains explicit.
        const complete = fromScrollback !== undefined && !fromScrollback.incomplete ? fromScrollback
          : fromFallback !== undefined && !fromFallback.incomplete ? fromFallback
            : fromIncremental !== undefined && !fromIncremental.incomplete ? fromIncremental
              : fromScrollback ?? fromFallback ?? fromIncremental;
        if (complete !== undefined) return render(complete);
        if (result.sessionStatus.kind === "exited") return await exited(result.sessionStatus);
        if (result.waitReason === "stdin_read") return render(partialOutput(scrollback(owner, id), marker, fallback));
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
      }
    } finally {
      upstream.removeEventListener("abort", onCancellation);
      commandDeadline[Symbol.dispose]();
      if (cancellationCleanup !== undefined) await cancellationCleanup;
    }
  };
  const queues = new WeakMap<Owner, Promise<void>>();
  ctx.tools.register(defineTool({
    name: "bash",
    description: resolved.description,
    parameters: { command: { type: "string", required: true, description: "The bash command to run. Relative path is preferred in the command." } },
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: value }] },
    async execute(args, exec) {
      if (args.command.trim().length === 0) throw new Error("command must be a non-empty string");
      const owner = exec.agent;
      if (owner === undefined) throw new Error("bash requires an owning agent session");
      const run = (queues.get(owner) ?? Promise.resolve()).then(
        () => exec.signal.aborted ? "" : execute(owner, args.command, exec.signal),
        () => exec.signal.aborted ? "" : execute(owner, args.command, exec.signal),
      );
      const tail = run.then(() => undefined, () => undefined);
      queues.set(owner, tail);
      try { return await run; }
      finally { if (queues.get(owner) === tail) queues.delete(owner); }
    },
    presentCall: (args) => ({ card: "terminal", title: args.command }),
  }));
}
