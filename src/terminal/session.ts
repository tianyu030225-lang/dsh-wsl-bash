/**
 * Bounded PTY session state machine adapted from the MIT-licensed
 * `@deepseek-ai/dsh-terminal-bash@0.1.0-rc.6` implementation.
 * Native terminal-protocol reply/drain handling also follows the MIT-licensed
 * 0.2.0-rc.2 / 0.2.1-alpha.1 implementation, Copyright (c) 2026 DeepSeek.
 *
 * The transport differs deliberately: Windows DSH owns an ordinary managed
 * `wsl.exe` process while util-linux `script` allocates the actual Linux PTY
 * inside WSL. Readiness requires the controlled shell prompt; when a richer
 * terminal provider publishes foreground facts, the session also checks that
 * process group. The pipe adapter has no such public fact and therefore
 * uses the complete controlled prompt without manufacturing a Linux pgid.
 * Native Git Bash reuses this bounded state machine through the official
 * session factory, retaining the host's terminal-protocol emulator.
 */

import { Buffer } from "node:buffer";
import { PassThrough } from "node:stream";
import type { Readable, Writable } from "node:stream";

import {
  TerminalError,
  type TerminalBackendSession,
  type TerminalReadRequest,
  type TerminalReadResult,
  type TerminalSendOperation,
  type TerminalSendRead,
  type TerminalSendRequest,
  type TerminalSendResult,
  type TerminalSessionStatus,
  type TerminalSignal,
  type TerminalSignalResult,
  type TerminalWaitReason,
} from "@deepseek-ai/dsh-terminal";
import type {
  SubprocessHandle,
  SubprocessOutcome,
} from "@deepseek-ai/dsh-subprocess";

import type { ResolvedPluginConfig } from "../types.js";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  let rejectPromise!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

export interface WslPtyForeground {
  processGroupId: number;
  /** Whether the provider can prove that the group is waiting on terminal input. */
  inputWaiting?: boolean;
}

export interface WslPtyTransport {
  readonly pid?: number;
  readonly output: Readable;
  readonly done: Promise<SubprocessOutcome>;
  write(data: string): Promise<void>;
  inspectForeground(): Promise<WslPtyForeground | undefined>;
  signalForeground(signal: TerminalSignal): Promise<number | undefined>;
  terminate(): Promise<void>;
}

/** Public @xterm/headless seam supplied by the actual native host. */
export interface TerminalProtocolEmulator {
  onData(listener: (data: string) => void): { dispose(): void };
  write(data: string, callback: () => void): void;
  dispose(): void;
}

interface PtySessionOptions {
  emulator?: TerminalProtocolEmulator;
  /** ConPTY may render trailing spaces as cursor movement, not literal bytes. */
  promptText?: string;
  /** Native readiness requires this exact OSC identity and later visible text. */
  promptControlText?: string;
  protectPrompt?: boolean;
  /** A Windows shell pid is not proof of POSIX foreground idleness. */
  inferIdle?: boolean;
}

interface SourceListeners {
  readonly data: (chunk: Buffer | string) => void;
  readonly end: () => void;
  readonly error: (error: unknown) => void;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

async function writePipe(stdin: Writable | undefined, data: string): Promise<void> {
  if (stdin === undefined || stdin.destroyed || stdin.writableEnded) {
    throw new Error("dsh-plugin-bash-wsl: subprocess stdin pipe is unavailable");
  }
  await new Promise<void>((resolve, reject) => {
    let callbackDone = false;
    let drainDone = false;
    let settled = false;
    const cleanup = (): void => {
      stdin.off("drain", onDrain);
      stdin.off("error", onError);
      stdin.off("close", onClose);
    };
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error === undefined) resolve();
      else reject(error);
    };
    const maybeFinish = (): void => {
      if (callbackDone && drainDone) finish();
    };
    const onDrain = (): void => {
      drainDone = true;
      maybeFinish();
    };
    const onError = (error: unknown): void => {
      finish(asError(error));
    };
    const onClose = (): void => {
      finish(new Error("dsh-plugin-bash-wsl: subprocess stdin closed while writing"));
    };
    stdin.once("error", onError);
    stdin.once("close", onClose);
    try {
      const accepted = stdin.write(data, (error?: Error | null) => {
        if (error != null) {
          finish(asError(error));
          return;
        }
        callbackDone = true;
        maybeFinish();
      });
      drainDone = accepted;
      if (!accepted) stdin.once("drain", onDrain);
      maybeFinish();
    } catch (error) {
      finish(asError(error));
    }
  });
}

/**
 * Adapt an ordinary managed pipe handle to the terminal session seam.
 *
 * `SubprocessHandle` intentionally has no PTY foreground inspector or signal
 * primitive. The WSL command line therefore uses util-linux `script` as the
 * PTY owner: control bytes written to its stdin are delivered by the Linux
 * line discipline, while hard signals use the official tree termination verb.
 * We never manufacture a foreground process group id from the Windows pid.
 */
export class WslPtyTransportAdapter implements WslPtyTransport {
  // The 0.2 pipe seam hides process identity. Never invent a Linux pid from
  // undocumented Windows provider metadata.
  public readonly pid?: number;
  public readonly output: PassThrough;
  public readonly done: Promise<SubprocessOutcome>;

  private readonly sources: Readable[];
  private readonly listeners = new Map<Readable, SourceListeners>();
  private readonly stdinError: (error: unknown) => void;
  private readonly stdinClose: () => void;
  private endedSources = 0;
  private processDone = false;
  private outputFinished = false;
  private closed = false;
  private terminatePromise: Promise<void> | undefined;

  public constructor(private readonly handle: SubprocessHandle) {
    if (handle.stdin === undefined || handle.stdout === undefined || handle.stderr === undefined) {
      throw new Error(
        "dsh-plugin-bash-wsl: WSL PTY subprocess requires stdin, stdout, and stderr pipes",
      );
    }
    this.output = new PassThrough();
    this.done = handle.done;
      this.stdinError = (error: unknown): void => {
        if (!this.closed && !this.output.destroyed) this.output.destroy(asError(error));
      };
      this.stdinClose = (): void => {
        // A managed child may close stdin immediately before its normal `done`
        // settlement. An active write has its own close listener and rejects;
        // outside a write, close alone is not a transport fault. Any later send
        // still fails through writePipe's closed/destroyed guard.
        handle.stdin?.off("error", this.stdinError);
      };
      handle.stdin.on("error", this.stdinError);
      handle.stdin.once("close", this.stdinClose);
    this.sources = [handle.stdout, handle.stderr];
    for (const source of this.sources) this.attachSource(source);
    void this.done.then(
      () => {
        this.processDone = true;
        this.finishOutput();
      },
      (error: unknown) => {
        this.processDone = true;
        if (!this.output.destroyed) this.output.destroy(asError(error));
      },
    );
  }

  public write(data: string): Promise<void> {
    if (this.closed) throw new Error("dsh-plugin-bash-wsl: WSL PTY transport is closed");
    return writePipe(this.handle.stdin, data);
  }

  public async inspectForeground(): Promise<WslPtyForeground | undefined> {
    // SubprocessHandle exposes no process-group inspection. Returning
    // undefined forces the session's prompt/idle handoff path instead of
    // claiming that the Windows subprocess pid is a Linux foreground pgid.
    return undefined;
  }

  public async signalForeground(signal: TerminalSignal): Promise<number | undefined> {
    if (this.closed) throw new Error("dsh-plugin-bash-wsl: WSL PTY transport is closed");
    if (signal === "SIGINT") {
      await this.write("\u0003");
      return this.pid;
    }
    if (signal === "SIGTSTP") {
      await this.write("\u001a");
      return this.pid;
    }
    // The ordinary subprocess seam cannot target a Linux foreground group.
    // Its only supported signal operation is tree-scoped termination; use it
    // for hard signals; there is no verified foreground group receipt.
    this.handle.terminate();
    return this.pid;
  }

  public terminate(): Promise<void> {
    if (this.terminatePromise !== undefined) return this.terminatePromise;
    this.closed = true;
    this.terminatePromise = this.terminateOnce();
    return this.terminatePromise;
  }

  private attachSource(source: Readable): void {
    const listeners: SourceListeners = {
      data: (chunk: Buffer | string): void => {
        if (!this.output.destroyed) this.output.write(chunk);
      },
      end: (): void => {
        this.endedSources += 1;
        this.finishOutput();
      },
      error: (error: unknown): void => {
        if (!this.output.destroyed) this.output.destroy(asError(error));
      },
    };
    this.listeners.set(source, listeners);
    source.on("data", listeners.data);
    source.once("end", listeners.end);
    source.once("error", listeners.error);
  }

  private finishOutput(): void {
    if (
      this.outputFinished ||
      !this.processDone ||
      this.endedSources !== this.sources.length
    ) {
      return;
    }
    this.outputFinished = true;
    this.output.end();
    this.detachSources();
      this.detachStdin();
  }

  private detachSources(): void {
    for (const [source, listeners] of this.listeners) {
      source.off("data", listeners.data);
      source.off("end", listeners.end);
      source.off("error", listeners.error);
    }
    this.listeners.clear();
  }

  private detachStdin(): void {
    const stdin = this.handle.stdin;
    if (stdin === undefined || stdin.closed !== true) return;
    stdin.off("error", this.stdinError);
    stdin.off("close", this.stdinClose);
  }

  private async terminateOnce(): Promise<void> {
    const errors: unknown[] = [];
    try {
      this.handle.terminate();
    } catch (error) {
      errors.push(error);
    }
    try {
      const exited = await this.handle.waitForExit();
      if (!exited) {
        errors.push(new Error("dsh-plugin-bash-wsl: subprocess exit wait was aborted"));
      }
    } catch (error) {
      errors.push(error);
    }
    try {
      await this.handle.done;
    } catch (error) {
      errors.push(error);
    } finally {
      this.detachSources();
        this.detachStdin();
      if (!this.output.destroyed && !this.outputFinished) {
        this.outputFinished = true;
        this.output.end();
      }
    }
    if (errors.length === 1) throw asError(errors[0]);
    if (errors.length > 1) throw new AggregateError(errors, "WSL PTY cleanup failed");
  }
}

export function createWslPtyTransport(handle: SubprocessHandle): WslPtyTransport {
  return new WslPtyTransportAdapter(handle);
}

function normalizeTerminalText(text: string): string {
  return text.replaceAll("\r\n", "\n").replaceAll("\r", "\n").replaceAll("\x07", "");
}

const CONTROLLED_PROMPT = "__DSH_PERSISTENT_BASH_PROMPT__ ";

/** Strip CSI/OSC escape sequences while preserving split-sequence carry. */
class TerminalSanitizer {
  private pending = "";
  private discardMode: "csi" | "osc" | undefined;
  private discardOscEscape = false;
  private trailingCarriageReturn = false;
  private trackingPromptTail = false;

  public constructor(
    private readonly maxPendingBytes: number,
    private readonly promptControlText?: string,
  ) {}

  public push(chunk: string): { text: string; prompt: boolean; controlPrompt: boolean; promptTail?: string } {
    this.pending += this.discardPrefix(chunk);
    let text = "";
    let prompt = false;
    let controlPrompt = false;
    let includePromptTail = this.trackingPromptTail;
    let promptTail = "";
    let index = 0;

    const appendText = (value: string): void => {
      text += value;
      if (this.trackingPromptTail) promptTail += value;
    };

    while (index < this.pending.length) {
      const escape = this.pending.indexOf("\x1b", index);
      if (escape < 0) {
        appendText(this.pending.slice(index));
        index = this.pending.length;
        break;
      }
      appendText(this.pending.slice(index, escape));
      if (escape + 1 >= this.pending.length) {
        index = escape;
        break;
      }
      const kind = this.pending[escape + 1];
      if (kind === "]") {
        const bel = this.pending.indexOf("\x07", escape + 2);
        const stringTerminator = this.pending.indexOf("\x1b\\", escape + 2);
        let end = -1;
        if (bel >= 0 && stringTerminator >= 0) end = Math.min(bel + 1, stringTerminator + 2);
        else if (bel >= 0) end = bel + 1;
        else if (stringTerminator >= 0) end = stringTerminator + 2;
        if (end < 0) {
          index = escape;
          break;
        }
        const terminatorBytes = this.pending[end - 1] === "\x07" ? 1 : 2;
        const payload = this.pending.slice(escape + 2, end - terminatorBytes);
        if (payload.startsWith("133;D;")) {
          prompt = true;
          const fields = payload.split(";");
          controlPrompt = this.promptControlText !== undefined && terminatorBytes === 1
            && fields.length === 4 && /^(?:0|[1-9]\d{0,2})$/.test(fields[2] ?? "")
            && Number(fields[2]) <= 255 && fields[3] === this.promptControlText;
          this.trackingPromptTail = true;
          includePromptTail = true;
          promptTail = "";
        }
        index = end;
        continue;
      }
      if (kind === "[") {
        let end = escape + 2;
        while (end < this.pending.length) {
          const code = this.pending.charCodeAt(end);
          if (code >= 64 && code <= 126) break;
          end += 1;
        }
        if (end >= this.pending.length) {
          index = escape;
          break;
        }
        index = end + 1;
        continue;
      }
      index = escape + 2;
    }

    this.pending = this.pending.slice(index);
    this.enforcePendingBound();
    return {
      text: this.normalize(text),
      prompt,
      controlPrompt,
      ...(includePromptTail ? { promptTail } : {}),
    };
  }

  public flush(): string {
    const text = this.pending.startsWith("\x1b") ? "" : this.pending;
    this.pending = "";
    this.discardMode = undefined;
    this.discardOscEscape = false;
    this.trackingPromptTail = false;
    const normalized = this.normalize(text);
    if (!this.trailingCarriageReturn) return normalized;
    this.trailingCarriageReturn = false;
    return `${normalized}\n`;
  }

  private normalize(text: string): string {
    let complete = this.trailingCarriageReturn ? `\r${text}` : text;
    this.trailingCarriageReturn = false;
    if (complete.endsWith("\r")) {
      complete = complete.slice(0, -1);
      this.trailingCarriageReturn = true;
    }
    return normalizeTerminalText(complete);
  }

  private enforcePendingBound(): void {
    if (Buffer.byteLength(this.pending) <= this.maxPendingBytes) return;
    this.discardMode = this.pending[1] === "]" ? "osc" : "csi";
    this.pending = "";
  }

  private discardPrefix(chunk: string): string {
    if (this.discardMode === undefined) return chunk;
    if (this.discardMode === "csi") {
      for (let index = 0; index < chunk.length; index += 1) {
        const code = chunk.charCodeAt(index);
        if (code >= 64 && code <= 126) {
          this.discardMode = undefined;
          return chunk.slice(index + 1);
        }
      }
      return "";
    }
    let index = 0;
    if (this.discardOscEscape) {
      this.discardOscEscape = false;
      if (chunk.startsWith("\\")) {
        this.discardMode = undefined;
        return chunk.slice(1);
      }
    }
    while (index < chunk.length) {
      if (chunk[index] === "\x07") {
        this.discardMode = undefined;
        return chunk.slice(index + 1);
      }
      if (chunk[index] === "\x1b") {
        if (chunk[index + 1] === "\\") {
          this.discardMode = undefined;
          return chunk.slice(index + 2);
        }
        if (index + 1 === chunk.length) this.discardOscEscape = true;
      }
      index += 1;
    }
    return "";
  }
}

function utf8Tail(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text) <= maxBytes) return { text, truncated: false };
  const chars = Array.from(text);
  let bytes = 0;
  let start = chars.length;
  while (start > 0) {
    const next = chars[start - 1];
    if (next === undefined) break;
    const nextBytes = Buffer.byteLength(next);
    if (bytes + nextBytes > maxBytes) break;
    bytes += nextBytes;
    start -= 1;
  }
  return { text: chars.slice(start).join(""), truncated: true };
}

class BoundedTextBuffer {
  private value = "";
  private dropped = false;

  public constructor(
    private readonly maxBytes: number,
    private readonly maxLines?: number,
  ) {}

  public append(text: string): void {
    if (text.length === 0) return;
    this.value += text;
    if (this.maxLines !== undefined) {
      const lines = this.value.split("\n");
      if (lines.length > this.maxLines) {
        this.value = lines.slice(lines.length - this.maxLines).join("\n");
        this.dropped = true;
      }
    }
    const tail = utf8Tail(this.value, this.maxBytes);
    this.value = tail.text;
    this.dropped ||= tail.truncated;
  }

  public consume(): TerminalSendRead {
    const delta = this.value;
    const truncated = this.dropped;
    this.value = "";
    this.dropped = false;
    return { delta, truncated };
  }

  public snapshot(): { text: string; truncated: boolean } {
    return { text: this.value, truncated: this.dropped };
  }
}

class WslSendOperation implements TerminalSendOperation {
  private readonly output: BoundedTextBuffer;
  private readonly result = deferred<TerminalSendResult>();
  private finished = false;
  private cancellationRequested = false;
  private initialForegroundPgid: number | undefined;
  private initialForegroundLeftWait = true;

  public constructor(
    maxBytes: number,
    public readonly startedAt: number,
    private readonly onCancel: () => void,
  ) {
    this.output = new BoundedTextBuffer(maxBytes);
  }

  public get done(): Promise<TerminalSendResult> {
    return this.result.promise;
  }

  public get settled(): boolean {
    return this.finished;
  }

  public get cancelRequested(): boolean {
    return this.cancellationRequested;
  }

  public append(text: string): void {
    if (!this.finished) this.output.append(text);
  }

  public settle(
    waitReason: TerminalWaitReason,
    sessionStatus: TerminalSessionStatus,
    inheritedTruncation: boolean,
  ): void {
    if (this.finished) return;
    this.finished = true;
    const read = this.output.snapshot();
    this.result.resolve({
      viewport: read.text,
      waitReason,
      sessionStatus,
      truncated: read.truncated || inheritedTruncation,
    });
  }

  public fail(error: unknown): void {
    if (this.finished) return;
    this.finished = true;
    this.result.reject(error);
  }

  public readOutput(): TerminalSendRead {
    return this.output.consume();
  }

  public setInitialForeground(foreground: WslPtyForeground | undefined): void {
    this.initialForegroundPgid = foreground?.processGroupId;
    this.initialForegroundLeftWait = foreground?.inputWaiting !== true;
  }

  public acceptsStdinWait(pgid: number, waiting: boolean | undefined): boolean {
    if (pgid !== this.initialForegroundPgid) return waiting === true;
    if (!waiting) this.initialForegroundLeftWait = true;
    return waiting === true && this.initialForegroundLeftWait;
  }

  public cancel(): boolean {
    if (this.finished) return false;
    this.cancellationRequested = true;
    this.onCancel();
    return true;
  }
}

export class WslPtySession implements TerminalBackendSession {
  public motd = "";
  public readonly pid?: number;

  private readonly decoder = new TextDecoder();
  private readonly sanitizer: TerminalSanitizer;
  private readonly scrollback: BoundedTextBuffer;
  private readonly outputEnded = deferred<void>();
  private readonly completion: Promise<void>;
  private statusValue: TerminalSessionStatus = { kind: "running" };
  private active: WslSendOperation | undefined;
  private activeTimer: NodeJS.Timeout | undefined;
  private activeDeadlineTimer: NodeJS.Timeout | undefined;
  private activeAbort: (() => void) | undefined;
  private activeWrite: Promise<boolean> | undefined;
  private interrupting: WslSendOperation | undefined;
  private polling = false;
  private promptSeen = false;
  private promptTextSeen = false;
  private promptReadyAt: number | undefined;
  private promptEmulatorSequence = 0;
  private promptTail = "";
  private shellPgid: number | undefined;
  private initializing = false;
  private lastOutputAt = Date.now();
  private closing = false;
  private closePromise: Promise<void> | undefined;
  private transportFailure: Error | undefined;
  private emulatorData: { dispose(): void } | undefined;
  private emulatorBuffer = "";
  private emulatorPendingBytes = 0;
  private emulatorQueuedSequence = 0;
  private emulatorParsedSequence = 0;
  private readonly emulatorBarriers = new Map<number, Deferred<void>>();
  private emulatorOutputPaused = false;
  private emulatorWriting = false;
  private emulatorWritingSequence = 0;
  private responseWrites = Promise.resolve();
  private readonly responseWritesBySequence = new Map<number, Promise<void>>();
  private pendingResponseWrites = 0;
  private emulatorClosed = false;

  public constructor(
    private readonly terminal: WslPtyTransport,
    private readonly config: ResolvedPluginConfig,
    private readonly options: PtySessionOptions = {},
  ) {
    if (terminal.pid !== undefined) this.pid = terminal.pid;
    if (options.promptText === "" || options.promptControlText === "") {
      this.closeEmulator();
      throw new Error("PTY controlled prompt must not be empty");
    }
    if (options.emulator !== undefined) {
      try {
        this.emulatorData = options.emulator.onData((data) => {
          if (this.emulatorClosed || this.closing) return;
          if (this.pendingResponseWrites >= 256 || Buffer.byteLength(data) > 4096) {
            this.onTransportFailure(new Error("PTY terminal-protocol reply limit exceeded"));
            return;
          }
          this.pendingResponseWrites += 1;
          const responseSequence = this.emulatorWritingSequence || this.emulatorQueuedSequence;
          const response = this.responseWrites.then(async () => {
            if (!this.emulatorClosed && !this.closing) await this.terminal.write(data);
          });
          const settled = response.then(() => {
            this.pendingResponseWrites -= 1;
          }, (error: unknown) => {
            this.pendingResponseWrites -= 1;
            if (!this.emulatorClosed && !this.closing) this.onTransportFailure(error);
          });
          this.responseWrites = settled;
          this.responseWritesBySequence.set(responseSequence, settled);
          void settled.finally(() => {
            if (this.responseWritesBySequence.get(responseSequence) === settled) {
              this.responseWritesBySequence.delete(responseSequence);
            }
          });
        });
      } catch (error) {
        this.closeEmulator();
        throw error;
      }
    }
    this.sanitizer = new TerminalSanitizer(config.maxReadBytes, options.promptControlText);
    this.scrollback = new BoundedTextBuffer(config.scrollbackMaxBytes, config.scrollbackLines);
    terminal.output.on("data", this.onTerminalData);
    terminal.output.once("end", this.onTerminalEnd);
    terminal.output.once("error", this.onTerminalError);
    this.completion = terminal.done.then(
      async (outcome) => this.onExit(outcome),
      (error: unknown) => this.onTransportFailure(error),
    );
  }

  public async initialize(signal?: AbortSignal): Promise<void> {
    this.initializing = true;
    try {
      signal?.throwIfAborted();
      const result = await this.startSend({
        text: "",
        submit: false,
        ...(signal === undefined ? {} : { signal }),
      }).done;
      if (result.waitReason === "session_exit") {
        throw new Error("WSL PTY shell exited during startup");
      }
      if (result.waitReason === "timeout") throw new Error("WSL PTY shell did not reach readiness before startup timeout");
      if (this.options.protectPrompt === false) {
        this.motd = result.viewport;
        return;
      }
      // The prompt marker is the only completion fact available from the
      // ordinary pipe adapter. Protect its producer before exposing the
      // persistent session to the official terminal tool. PS1 remains
      // writable because controlled PROMPT_COMMAND clears it and emits the
      // complete marker/text frame itself; the prompt must not be split across
      // two writers. This keeps the official tool's PS1 assignment quiet.
      const guard = await this.startSend({
        text: `stty rows ${this.config.rows} cols ${this.config.cols}; readonly PROMPT_COMMAND`,
        submit: true,
        ...(signal === undefined ? {} : { signal }),
      }).done;
      if (guard.waitReason === "session_exit") {
        throw new Error("WSL PTY shell exited while protecting startup prompt");
      }
      if (guard.waitReason === "timeout") {
        throw new Error("WSL PTY shell did not accept startup prompt protection");
      }
      this.motd = result.viewport;
    } finally {
      this.initializing = false;
    }
  }

  public startSend(request: TerminalSendRequest): TerminalSendOperation {
    if (this.closing) throw new Error("WSL PTY session is closing");
    if (this.statusValue.kind === "exited") throw new Error("WSL PTY session has exited");
    if (this.active !== undefined) {
      throw new TerminalError("WSL PTY session already has an active send", "SEND_ACTIVE");
    }
    if (request.signal?.aborted === true) throw new Error("WSL PTY send aborted before write");

    const operation = new WslSendOperation(this.config.maxReadBytes, Date.now(), () => {
      this.interrupt(operation);
    });
    this.active = operation;
    this.resetReadinessEvidence();

    if (request.signal !== undefined) {
      const onAbort = (): void => {
        operation.cancel();
      };
      request.signal.addEventListener("abort", onAbort, { once: true });
      this.activeAbort = () => request.signal?.removeEventListener("abort", onAbort);
    }
    this.activeDeadlineTimer = setTimeout(() => {
      if (this.active === operation) {
        this.settleActive("timeout", this.activeWrite !== undefined || this.interrupting === operation
          || this.emulatorPendingBytes > 0 || this.pendingResponseWrites > 0);
      }
    }, this.config.timeoutMs);
    void this.beginSend(operation, request);
    return operation;
  }

  public read(request: TerminalReadRequest): TerminalReadResult {
    const snapshot = this.scrollback.snapshot();
    const lines = snapshot.text.split("\n");
    const totalLines = snapshot.text.length === 0 ? 0 : lines.length;
    const offset = request.offset ?? 0;
    const count = request.count ?? 500;
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new Error("WSL PTY read offset must be a non-negative safe integer");
    }
    if (!Number.isSafeInteger(count) || count <= 0) {
      throw new Error("WSL PTY read count must be a positive safe integer");
    }
    if (offset >= totalLines) {
      return { text: "", totalLines, lineBegin: offset, lineEnd: offset, truncated: snapshot.truncated };
    }
    const end = totalLines - offset;
    const start = Math.max(0, end - count);
    const bounded = utf8Tail(lines.slice(start, end).join("\n"), this.config.maxReadBytes);
    const returnedLines = bounded.text.length === 0 ? 0 : bounded.text.split("\n").length;
    return {
      text: bounded.text,
      totalLines,
      lineBegin: offset,
      lineEnd: offset + returnedLines,
      truncated: snapshot.truncated || bounded.truncated,
    };
  }

  public async signal(signal: TerminalSignal): Promise<TerminalSignalResult> {
    if (this.closing) throw new Error("WSL PTY session is closing");
    if (this.statusValue.kind === "exited") throw new Error("WSL PTY session has exited");
    // Registry signals require an exact group receipt. The WSL pipe can send
    // control bytes for cancellation but cannot verify that group. Refuse an
    // explicit signal before side effects instead of fabricating its receipt.
    if (await this.terminal.inspectForeground() === undefined) {
      throw new Error("WSL PTY foreground process group cannot be verified; use cancellation or close the owner shell");
    }
    const targetPgid = await this.terminal.signalForeground(signal);
    if (targetPgid === undefined) throw new Error("WSL PTY signal did not publish a verified target group");
    return { delivered: true, targetPgid };
  }

  public status(): TerminalSessionStatus {
    return this.statusValue;
  }

  public close(reason: string): Promise<void> {
    this.closing = true;
    if (this.closePromise !== undefined) return this.closePromise;
    this.closePromise = this.closeOnce(reason).catch((error: unknown) => {
      this.closePromise = undefined;
      this.failActive(error);
      throw error;
    });
    return this.closePromise;
  }

  private readonly onTerminalData = (chunk: string | Buffer): void => {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    const data = this.decoder.decode(bytes, { stream: true });
    this.queueEmulatorData(data);
    this.onData(data);
  };

  private readonly onTerminalEnd = (): void => {
    this.onData(this.decoder.decode());
    this.appendOutput(this.sanitizer.flush());
    this.closeEmulator();
    this.outputEnded.resolve();
  };

  private readonly onTerminalError = (error: unknown): void => {
    this.closeEmulator();
    this.onTransportFailure(error);
    this.outputEnded.resolve();
  };

  private async beginSend(operation: WslSendOperation, request: TerminalSendRequest): Promise<void> {
    let foreground: WslPtyForeground | undefined;
    try {
      foreground = await this.inspectForegroundAfterProtocol();
      if (this.active !== operation || this.closing || this.interrupting === operation) return;
      // A protocol drain can outlive this operation's deadline. Never publish
      // its original input after the already-returned timeout result.
      if (operation.settled) { this.clearActive(); return; }
      operation.setInitialForeground(foreground);
      const input = `${request.text}${request.submit ? "\r" : ""}`;
      if (input.length > 0 && !operation.cancelRequested) {
        this.resetReadinessEvidence();
        const write = this.terminal.write(input);
        this.activeWrite = write.then(() => true, () => false);
        try {
          await write;
        } finally {
          this.activeWrite = undefined;
        }
      }
      if (operation.cancelRequested) return;
      if (this.active === operation && !this.closing) this.schedulePoll(operation, 0);
    } catch (error) {
      if (this.active === operation && !this.closing) this.failActive(error);
    }
  }

  private resetReadinessEvidence(): void {
    this.lastOutputAt = Date.now();
    this.promptSeen = false;
    this.promptTextSeen = false;
    this.promptReadyAt = undefined;
    this.promptEmulatorSequence = 0;
    this.promptTail = "";
  }

  private onData(data: string): void {
    const sanitized = this.sanitizer.push(data);
    this.appendOutput(sanitized.text);
    if (sanitized.prompt) {
      this.promptSeen = this.options.promptControlText === undefined || sanitized.controlPrompt;
      this.promptTextSeen = false;
      this.promptTail = "";
      this.promptReadyAt = undefined;
      this.lastOutputAt = Date.now();
    }
    if (this.promptSeen && sanitized.promptTail !== undefined) {
      const controlledPrompt = this.options.promptText ?? CONTROLLED_PROMPT;
      if (this.options.promptControlText !== undefined) {
        // Native ConPTY can forward this complete OSC before repainting the
        // command's body. Require its later exact visible sentinel too, but do
        // not mistake the intervening body for an incomplete prompt prefix.
        if (!this.promptTextSeen) {
          const tail = this.promptTail + sanitized.promptTail;
          this.promptTextSeen = tail.includes(controlledPrompt);
          this.promptTail = this.promptTextSeen ? controlledPrompt
            : tail.slice(Math.max(0, tail.length - controlledPrompt.length + 1));
        }
      } else {
        const remaining = Math.max(0, controlledPrompt.length - this.promptTail.length);
        this.promptTail += sanitized.promptTail.slice(0, remaining);
        this.promptTextSeen = this.promptTail === controlledPrompt;
      }
      // Retain the complete bounded prompt prefix. Background output can follow
      // it in the same read or a later read without revoking shell readiness.
      if (this.promptTextSeen && this.promptReadyAt === undefined) {
        this.promptReadyAt = Date.now();
        this.promptEmulatorSequence = this.emulatorQueuedSequence;
      }
    }
  }

  private appendOutput(text: string): void {
    if (text.length === 0) return;
    this.lastOutputAt = Date.now();
    this.scrollback.append(text);
    this.active?.append(text);
  }

  private schedulePoll(operation: WslSendOperation, delayMs = this.config.pollIntervalMs): void {
    if (this.active !== operation || this.interrupting === operation || this.polling) return;
    if (this.activeTimer !== undefined) clearTimeout(this.activeTimer);
    this.activeTimer = setTimeout(() => {
      this.activeTimer = undefined;
      void this.pollReadiness(operation);
    }, delayMs);
  }

  private async pollReadiness(operation: WslSendOperation): Promise<void> {
    if (this.active !== operation || this.polling) return;
    this.polling = true;
    try {
      if (this.statusValue.kind === "exited") {
        this.settleActive("session_exit");
        return;
      }
        let protocolSequence = this.promptSeen
          ? this.promptEmulatorSequence
          : this.emulatorQueuedSequence;
        let foreground = await this.inspectForegroundAfterProtocol(protocolSequence);
        if (this.promptSeen && this.promptEmulatorSequence > protocolSequence) {
          protocolSequence = this.promptEmulatorSequence;
          foreground = await this.inspectForegroundAfterProtocol(protocolSequence);
        }
      if (this.active !== operation || this.closing || this.interrupting === operation) return;
      if (operation.settled) { this.clearActive(); return; }
      const idleFor = Date.now() - this.lastOutputAt;
      if (this.promptSeen && foreground !== undefined && this.shellPgid === undefined) {
        this.shellPgid = foreground.processGroupId;
      }
      if (
        this.promptSeen &&
        this.promptTextSeen &&
        this.promptReadyAt !== undefined &&
        this.promptEmulatorSequence <= this.emulatorParsedSequence &&
          this.pendingResponseWrites === 0 &&
        Date.now() - this.promptReadyAt >= this.config.pollIntervalMs &&
        (foreground === undefined || foreground.processGroupId === this.shellPgid)
      ) {
        this.settleActive("stdin_read");
        return;
      }
      const elapsed = Date.now() - operation.startedAt;
      const startupHasOutput = !this.initializing || this.scrollback.snapshot().text.length > 0;
      const acceptsStdinWait =
        startupHasOutput &&
        foreground !== undefined &&
        operation.acceptsStdinWait(foreground.processGroupId, foreground.inputWaiting);
      if (elapsed >= this.config.pollIntervalMs && acceptsStdinWait) {
        this.settleActive("stdin_read");
        return;
      }
      const handoffGrace = this.promptSeen ? this.config.pollIntervalMs : 0;
      // An ordinary managed subprocess pipe cannot publish the Linux foreground
      // process group. Without that fact, silence is not evidence that a
      // foreground command has returned control to Bash: `sleep 5` would be
      // mistaken for an idle shell and the next send could interleave with it.
      // The controlled OSC prompt path above remains authoritative; otherwise
      // wait for a real prompt, session exit, or the operation deadline.
      if (
        startupHasOutput &&
        foreground !== undefined &&
        foreground.processGroupId === this.shellPgid &&
        this.options.inferIdle !== false &&
        idleFor >= this.config.idleSilenceMs + handoffGrace
      ) {
        this.settleActive("inferred_idle");
      }
    } catch (error) {
      if (this.active === operation && !this.closing && this.interrupting !== operation) this.failActive(error);
    } finally {
      this.polling = false;
      if (this.active === operation) this.schedulePoll(operation);
    }
  }

  /** Drain the captured input prefix, not an unending future background stream. */
  private async inspectForegroundAfterProtocol(
    throughSequence = this.emulatorQueuedSequence,
  ): Promise<WslPtyForeground | undefined> {
    if (this.options.emulator === undefined) return this.terminal.inspectForeground();
    const sequence = throughSequence;
    if (sequence > this.emulatorParsedSequence) {
      let barrier = this.emulatorBarriers.get(sequence);
      if (barrier === undefined) {
        barrier = deferred<void>();
        this.emulatorBarriers.set(sequence, barrier);
      }
      await barrier.promise;
    }
    // Await replies already emitted by parsed input, including a terminal query
    // that arrived immediately after the prompt. Do not wait for an unparsed
    // future background chunk merely because it has a later input sequence.
    const responseWrites = [...this.responseWritesBySequence.values()];
    await Promise.all(responseWrites);
    if (this.transportFailure !== undefined) throw this.transportFailure;
    return this.terminal.inspectForeground();
  }

  private queueEmulatorData(data: string): void {
    if (this.options.emulator === undefined || this.emulatorClosed || data.length === 0) return;
    const bytes = Buffer.byteLength(data);
    // Include the in-flight write in the hard bound. Allow small reads to batch
    // instead of serializing every PTY packet on the emulator's async callback.
    if (this.emulatorPendingBytes + bytes > 1024 * 1024) {
      this.onTransportFailure(new Error("PTY terminal-protocol input limit exceeded"));
      return;
    }
    this.emulatorPendingBytes += bytes;
    this.emulatorQueuedSequence += 1;
    this.emulatorBuffer += data;
    if (!this.emulatorOutputPaused && this.emulatorPendingBytes >= 256 * 1024) {
      this.terminal.output.pause();
      this.emulatorOutputPaused = true;
    }
    this.pumpEmulator();
  }

  private pumpEmulator(): void {
    if (this.emulatorWriting || this.emulatorClosed || this.options.emulator === undefined) return;
    if (this.emulatorBuffer.length === 0) {
      return;
    }
    const data = this.emulatorBuffer;
    const bytes = Buffer.byteLength(data);
    const sequence = this.emulatorQueuedSequence;
    this.emulatorBuffer = "";
    this.emulatorWriting = true;
      this.emulatorWritingSequence = sequence;
    try {
      this.options.emulator.write(data, () => {
        if (this.emulatorClosed) return;
        this.emulatorWriting = false;
          this.emulatorWritingSequence = 0;
        this.emulatorPendingBytes -= bytes;
        this.emulatorParsedSequence = sequence;
        for (const [target, barrier] of this.emulatorBarriers) {
          if (target <= sequence) {
            this.emulatorBarriers.delete(target);
            barrier.resolve();
          }
        }
        if (this.emulatorOutputPaused && this.emulatorPendingBytes <= 128 * 1024 && !this.closing) {
          this.emulatorOutputPaused = false;
          this.terminal.output.resume();
        }
        this.pumpEmulator();
      });
    } catch (error) {
        this.emulatorWritingSequence = 0;
      this.onTransportFailure(error);
    }
  }

  private closeEmulator(): void {
    if (this.emulatorClosed) return;
    this.emulatorClosed = true;
    this.emulatorBuffer = "";
    this.emulatorPendingBytes = 0;
    this.emulatorWriting = false;
    this.emulatorWritingSequence = 0;
    this.responseWritesBySequence.clear();
    for (const barrier of this.emulatorBarriers.values()) barrier.resolve();
    this.emulatorBarriers.clear();
    this.emulatorOutputPaused = false;
    try {
      this.emulatorData?.dispose();
    } catch (error) {
      this.transportFailure ??= asError(error);
    }
    try {
      this.options.emulator?.dispose();
    } catch (error) {
      this.transportFailure ??= asError(error);
    }
    // A parser may have paused the stream. Drain remaining bounded output so
    // Readable can publish end and owner cleanup can await actual quiescence.
    if (this.options.emulator !== undefined) this.terminal.output.resume();
  }

  private settleActive(waitReason: TerminalWaitReason, retainOwnership = false): void {
    const operation = this.active;
    if (operation === undefined) return;
    const truncated = this.scrollback.snapshot().truncated;
    if (retainOwnership) {
      this.stopPolling();
      this.activeAbort?.();
      this.activeAbort = undefined;
    } else {
      this.clearActive();
    }
    operation.settle(waitReason, this.statusValue, truncated);
  }

  private stopPolling(): void {
    if (this.activeTimer !== undefined) clearTimeout(this.activeTimer);
    if (this.activeDeadlineTimer !== undefined) clearTimeout(this.activeDeadlineTimer);
    this.activeTimer = undefined;
    this.activeDeadlineTimer = undefined;
  }

  private clearActive(): void {
    const operation = this.active;
    this.stopPolling();
    this.activeAbort?.();
    this.activeAbort = undefined;
    if (this.interrupting === operation) this.interrupting = undefined;
    this.active = undefined;
  }

  private failActive(error: unknown): void {
    const operation = this.active;
    if (operation === undefined) return;
    this.clearActive();
    operation.fail(error);
  }

  private interrupt(operation: WslSendOperation): void {
    if (this.active !== operation) return;
    this.interrupting = operation;
    if (this.activeTimer !== undefined) clearTimeout(this.activeTimer);
    this.activeTimer = undefined;
    void this.interruptOnce(operation);
  }

  private async interruptOnce(operation: WslSendOperation): Promise<void> {
    try {
      const activeWrite = this.activeWrite;
      if (activeWrite !== undefined && !await activeWrite) return;
      await this.terminal.signalForeground("SIGINT");
    } catch (error) {
      if (this.active === operation && !this.closing) this.onTransportFailure(error);
      return;
    } finally {
      if (this.interrupting === operation) this.interrupting = undefined;
    }
    if (this.active === operation && !this.closing) this.schedulePoll(operation, 0);
  }

  private async onExit(outcome: SubprocessOutcome): Promise<void> {
    await this.outputEnded.promise;
    if (this.transportFailure !== undefined) return;
    this.statusValue = { kind: "exited", exitCode: outcome.exitCode, signal: outcome.signal };
    this.settleActive("session_exit");
  }

  private onTransportFailure(error: unknown): void {
    const failure = error instanceof Error ? error : new Error(String(error));
    this.transportFailure ??= failure;
    this.statusValue = { kind: "exited", exitCode: null, signal: null };
    this.closeEmulator();
    this.failActive(failure);
    void this.terminal.terminate().catch(() => undefined);
  }

  private async closeOnce(reason: string): Promise<void> {
    this.stopPolling();
    this.closeEmulator();
    try {
      await this.terminal.terminate();
    } catch (error) {
      throw new Error(`WSL PTY cleanup failed (${reason})`, { cause: error });
    }
    this.settleActive("session_exit");
    await this.completion;
    this.terminal.output.off("data", this.onTerminalData);
    this.terminal.output.off("end", this.onTerminalEnd);
    this.terminal.output.off("error", this.onTerminalError);
    if (this.transportFailure !== undefined) throw this.transportFailure;
  }
}
