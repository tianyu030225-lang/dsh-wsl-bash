import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import { resolveConfig } from "../../../src/config.js";
import {
  WslPtySession,
  type WslPtyForeground,
  type WslPtyTransport,
} from "../../../src/terminal/session.js";

const OSC_PROMPT = "\u001b]133;D;0\u0007";
const CONTROLLED_PROMPT = "__DSH_PERSISTENT_BASH_PROMPT__ ";
const COMPLETE_PROMPT = `${OSC_PROMPT}${CONTROLLED_PROMPT}`;
const NATIVE_PROMPT_TEXT = "__DSH_PERSISTENT_BASH_PROMPT__";
const NATIVE_CONTROL_TEXT = NATIVE_PROMPT_TEXT;
const NATIVE_CONPTY_STARTUP =
  `${OSC_PROMPT}\u001b[2J\u001b[m\u001b[H${NATIVE_PROMPT_TEXT}`
  + "\u001b[1C\u001b]0;Git Bash\u0007";

function nativeControl(status: number | string = 0, text = NATIVE_CONTROL_TEXT): string {
  return `\u001b]133;D;${status};${text}\u0007`;
}

function nativeSessionOptions(
  overrides: SessionOptions = {},
): SessionOptions {
  return {
    promptText: NATIVE_PROMPT_TEXT,
    promptControlText: NATIVE_CONTROL_TEXT,
    protectPrompt: false,
    inferIdle: false,
    ...overrides,
  };
}

interface ProtocolEmulator {
  write(data: string, callback: () => void): void;
  onData(listener: (data: string) => void): { dispose(): void };
  dispose(): void;
}

interface SessionOptions {
  emulator?: ProtocolEmulator;
  promptText?: string;
  promptControlText?: string;
  protectPrompt?: boolean;
  inferIdle?: boolean;
}

interface FakePipe {
  output: PassThrough;
  transport: WslPtyTransport;
  write: ReturnType<typeof vi.fn>;
  inspectForeground: ReturnType<typeof vi.fn>;
  terminate: ReturnType<typeof vi.fn>;
  releaseWrites(): void;
}

interface PipeOptions {
  failWriteAfter?: number;
  holdWriteWhen?: (data: string) => boolean;
}

function createPipe(
  inspectForeground: () => Promise<WslPtyForeground | undefined> = async () => undefined,
  options: PipeOptions = {},
): FakePipe {
  const output = new PassThrough();
  let finish!: () => void;
  const done = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      finish = () => resolve({ exitCode: null, signal: "SIGTERM" });
    },
  );
  const pendingWrites: Array<() => void> = [];
  let writeCount = 0;
  const write = vi.fn((data: string) => {
    writeCount += 1;
    if (options.failWriteAfter !== undefined && writeCount > options.failWriteAfter) {
      return Promise.reject(new Error("provider write failed"));
    }
    if (options.holdWriteWhen?.(data) === true) {
      return new Promise<void>((resolve) => pendingWrites.push(resolve));
    }
    return Promise.resolve();
  });
  const terminate = vi.fn(async () => {
    finish();
    output.end();
  });
  const inspect = vi.fn(inspectForeground);
  const transport: WslPtyTransport = {
    output,
    done,
    write,
    inspectForeground: inspect,
    signalForeground: vi.fn(async () => 101),
    terminate,
  };
  return {
    output,
    transport,
    write,
    inspectForeground: inspect,
    terminate,
    releaseWrites: () => pendingWrites.splice(0).forEach((resolve) => resolve()),
  };
}

function createSession(
  pipe: FakePipe,
  options: SessionOptions = {},
): WslPtySession {
  return new WslPtySession(
    pipe.transport,
    resolveConfig({
      pollIntervalMs: 5,
      idleSilenceMs: 25,
      timeoutMs: 90,
      maxReadBytes: 4096,
      scrollbackMaxBytes: 4096,
    }),
    options,
  );
}

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 250;
  while (!condition() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  expect(condition()).toBe(true);
}

async function closeSession(session: WslPtySession): Promise<void> {
  await session.close("terminal protocol contract cleanup");
}

async function closeSessionExpectingFailure(
  session: WslPtySession,
  pattern: RegExp,
): Promise<void> {
  const error = await session.close("terminal protocol expected failure cleanup")
    .then(() => undefined, (reason: unknown) => reason);
  expect(error).toBeInstanceOf(Error);
  expect(String((error as Error).message)).toMatch(pattern);
}

function outputEnded(pipe: FakePipe): Promise<void> {
  return new Promise((resolve) => pipe.output.once("end", resolve));
}

async function settleWithin<T>(promise: Promise<T>, timeoutMs = 160): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error("operation did not settle in time")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function createEmulator({
  holdFirstWrite = false,
  holdWriteNumbers = [],
  failWrite = false,
  asyncCallback = false,
  failOnDataRegistration = false,
}: {
  holdFirstWrite?: boolean;
  holdWriteNumbers?: number[];
  failWrite?: boolean;
  asyncCallback?: boolean;
  failOnDataRegistration?: boolean;
} = {}) {
  const listeners = new Set<(data: string) => void>();
  const pendingCallbacks: Array<() => void> = [];
  const completedWrites = vi.fn();
  const heldWriteNumbers = new Set(holdWriteNumbers);
  let writeNumber = 0;
  const write = vi.fn((data: string, callback: () => void) => {
    writeNumber += 1;
    if (failWrite) throw new Error("emulator write failed");
    if (data.includes("\u001b[6n")) {
      for (const listener of listeners) listener("\u001b[1;1R");
    }
    if (data.includes("\u001b[c")) {
      for (const listener of listeners) listener("\u001b[?1;2c");
    }
    if ((holdFirstWrite && writeNumber === 1) || heldWriteNumbers.has(writeNumber)) {
      pendingCallbacks.push(callback);
      return;
    }
    const finish = () => {
      completedWrites();
      callback();
    };
    if (asyncCallback) setImmediate(finish);
    else finish();
  });
  const onData = vi.fn((listener: (data: string) => void) => {
    if (failOnDataRegistration) throw new Error("emulator onData registration failed");
    listeners.add(listener);
    return { dispose: vi.fn(() => listeners.delete(listener)) };
  });
  const dispose = vi.fn(() => listeners.clear());
  return {
    write,
    completedWrites,
    onData,
    dispose,
    emitData: (data: string) => listeners.forEach((listener) => listener(data)),
    pendingReplyCount: () => pendingCallbacks.length,
    releaseNextPendingReply: (before?: () => void) => {
      before?.();
      pendingCallbacks.shift()?.();
    },
    releasePendingReply: () => pendingCallbacks.splice(0).forEach((callback) => callback()),
  } satisfies ProtocolEmulator & {
    pendingReplyCount(): number;
    releaseNextPendingReply(before?: () => void): void;
    releasePendingReply(): void;
    completedWrites: ReturnType<typeof vi.fn>;
    emitData(data: string): void;
  };
}

describe("shared PTY protocol-emulator readiness contract", () => {
  it("keeps a complete prompt prefix and settles during a real continuous background stream", async () => {
    const pipe = createPipe();
    const emulator = createEmulator({ asyncCallback: true });
    const session = createSession(pipe, {
      emulator,
      protectPrompt: false,
      inferIdle: false,
    });
    try {
      const operation = session.startSend({ text: "background", submit: true });
      await waitFor(() => pipe.write.mock.calls.length === 1);
      // First drain real async DSR/DA replies through the emulator before the
      // controlled prompt and the continuous background stream begin.
      pipe.output.write("\u001b[6n\u001b[c");
      await waitFor(() => pipe.write.mock.calls.some(([data]) => data === "\u001b[1;1R"));
      await waitFor(() => pipe.write.mock.calls.some(([data]) => data === "\u001b[?1;2c"));
      await waitFor(() => emulator.completedWrites.mock.calls.length === 1);
      pipe.output.write(COMPLETE_PROMPT);
      pipe.output.write("background-0 ");
      let liveTicks = 0;
      const interval = setInterval(() => {
        liveTicks += 1;
        pipe.output.write("background-live ");
      }, 1);
      try {
        await waitFor(() => liveTicks >= 2);
        expect(liveTicks).toBeGreaterThanOrEqual(2);
        const result = await settleWithin(operation.done);
        expect(result.waitReason).toBe("stdin_read");
        expect(result.viewport).toContain(CONTROLLED_PROMPT);
        expect(emulator.write).toHaveBeenCalled();
      } finally {
        clearInterval(interval);
      }
      expect(session.read({ offset: 0, count: 500 }).text).toContain("background-0");
    } finally {
      await closeSession(session);
    }
  });

  it("batches multiple small PTY chunks without pausing below the high-water mark", async () => {
    const pipe = createPipe();
    const emulator = createEmulator({ asyncCallback: true });
    const pause = vi.spyOn(pipe.output, "pause");
    const chunks = Array.from({ length: 32 }, (_, index) => `chunk-${index};`);
    const session = createSession(pipe, {
      emulator,
      protectPrompt: false,
      inferIdle: false,
    });
    try {
      const operation = session.startSend({ text: "batch-small", submit: true });
      await waitFor(() => pipe.write.mock.calls.length === 1);
      for (const chunk of chunks) pipe.output.emit("data", chunk);
      await waitFor(() => emulator.completedWrites.mock.calls.length >= 2);
      expect(emulator.write.mock.calls.length).toBeLessThan(chunks.length);
      expect(emulator.write.mock.calls.map(([data]) => data).join(""))
        .toBe(chunks.join(""));
      expect(pause).not.toHaveBeenCalled();
    } finally {
      await closeSession(session);
    }
  });

  it("pauses at 256 KiB and resumes at 128 KiB after the in-flight batch drains", async () => {
    const pipe = createPipe();
    const emulator = createEmulator({ holdWriteNumbers: [1] });
    const pause = vi.spyOn(pipe.output, "pause");
    const resume = vi.spyOn(pipe.output, "resume");
    const session = createSession(pipe, {
      emulator,
      protectPrompt: false,
      inferIdle: false,
    });
    try {
      const operation = session.startSend({ text: "watermark", submit: true });
      await waitFor(() => pipe.write.mock.calls.length === 1);
      pipe.output.emit("data", "a".repeat(128 * 1024));
      await waitFor(() => emulator.write.mock.calls.length === 1);
      pipe.output.emit("data", "b".repeat(128 * 1024));
      await waitFor(() => pause.mock.calls.length > 0);
      expect(emulator.pendingReplyCount()).toBe(1);
      expect(emulator.write.mock.calls).toHaveLength(1);
      const resumesBeforeDrain = resume.mock.calls.length;
      emulator.releaseNextPendingReply();
      await waitFor(() => emulator.write.mock.calls.length === 2);
      expect(emulator.write.mock.calls).toHaveLength(2);
      expect(emulator.write.mock.calls.at(1)?.[0]).toBe("b".repeat(128 * 1024));
      expect(resume.mock.calls.length).toBeGreaterThan(resumesBeforeDrain);
    } finally {
      await closeSession(session);
    }
  });

  it("counts an in-flight parser write toward the 1 MiB hard cap", async () => {
    const pipe = createPipe();
    const emulator = createEmulator({ holdWriteNumbers: [1] });
    const session = createSession(pipe, {
      emulator,
      protectPrompt: false,
      inferIdle: false,
    });
    const ended = outputEnded(pipe);
    try {
      const operation = session.startSend({ text: "inflight-bound", submit: true });
      await waitFor(() => pipe.write.mock.calls.length === 1);
      pipe.output.emit("data", "a".repeat(900 * 1024));
      await waitFor(() => emulator.write.mock.calls.length === 1);
      // This second already-emitted chunk must be counted with the held first
      // write, even though the stream has crossed its pause watermark.
      pipe.output.emit("data", "b".repeat(128 * 1024));
      await expect(operation.done).rejects.toThrow(/input limit exceeded/);
      await settleWithin(ended, 250);
      expect(pipe.terminate).toHaveBeenCalledTimes(1);
      expect(emulator.dispose).toHaveBeenCalledTimes(1);
    } finally {
      await closeSessionExpectingFailure(session, /input limit exceeded/);
    }
  });

  it("settles the captured prompt prefix while a future background write remains pending", async () => {
    let inspectCalls = 0;
    let releaseInspect!: () => void;
    const inspectGate = new Promise<void>((resolve) => {
      releaseInspect = resolve;
    });
    const pipe = createPipe(async () => {
      inspectCalls += 1;
      if (inspectCalls >= 2) await inspectGate;
      return undefined;
    }, {
      holdWriteWhen: (data) => data === "captured-prefix\r",
    });
    const emulator = createEmulator({ holdWriteNumbers: [1, 2] });
    const session = createSession(pipe, {
      emulator,
      protectPrompt: false,
      inferIdle: false,
    });
    try {
      const operation = session.startSend({ text: "captured-prefix", submit: true });
      await waitFor(() => pipe.write.mock.calls.length === 1);
      pipe.output.emit("data", COMPLETE_PROMPT);
      await waitFor(() => emulator.write.mock.calls.length === 1);
      expect(emulator.pendingReplyCount()).toBe(1);
      pipe.releaseWrites();
      await new Promise((resolve) => setTimeout(resolve, 0));
      // Release the captured prefix while the post-barrier foreground check is
      // held. The later pure background chunk is then queued after the
      // captured sequence has been selected, but its parser callback remains
      // pending. Readiness must not wait for that future callback.
      emulator.releaseNextPendingReply();
      await waitFor(() => pipe.inspectForeground.mock.calls.length >= 2);
      pipe.output.emit("data", "future-background");
      await waitFor(() => emulator.write.mock.calls.length === 2);
      expect(emulator.pendingReplyCount()).toBe(1);
      releaseInspect();
      expect((await settleWithin(operation.done)).waitReason).toBe("stdin_read");
    } finally {
      await closeSession(session);
    }
  });

  it("does not settle on a fresh prompt until its parser callback and reply drain complete", async () => {
    vi.useFakeTimers();
    let releasePollInspect!: () => void;
    let inspectCalls = 0;
    let holdProtocolReply = false;
    const inspectGate = new Promise<void>((resolve) => {
      releasePollInspect = resolve;
    });
    const pipe = createPipe(async () => {
      inspectCalls += 1;
      if (inspectCalls === 2) await inspectGate;
      return undefined;
    }, {
      holdWriteWhen: (data) => data === "sequence-guard\r"
        || (holdProtocolReply && data === "\u001b[1;1R"),
    });
    const emulator = createEmulator({ holdWriteNumbers: [2] });
    let session: WslPtySession | undefined;
    let settled = false;
    try {
      session = createSession(pipe, {
        emulator,
        protectPrompt: false,
        inferIdle: false,
      });
      // Complete the normal send's first foreground inspection and hold only
      // its command write. The old prompt is parsed before pollReadiness can
      // capture its sequence, so the second inspection must capture seq1.
      const operation = session.startSend({ text: "sequence-guard", submit: true });
      void operation.done.then(
        () => { settled = true; },
        () => { settled = true; },
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(inspectCalls).toBe(1);
      expect(pipe.write.mock.calls.at(0)?.[0]).toBe("sequence-guard\r");

      pipe.output.write(COMPLETE_PROMPT);
      await vi.advanceTimersByTimeAsync(0);
      expect(emulator.write.mock.calls.length).toBe(1);
      expect(emulator.pendingReplyCount()).toBe(0);
      pipe.releaseWrites();
      await vi.advanceTimersByTimeAsync(0);
      expect(inspectCalls).toBe(2);

      // The poll has captured seq1 and is now held in its foreground check.
      // Queue a fresh prompt whose parser callback is not yet complete.
      pipe.output.write(COMPLETE_PROMPT);
      await vi.advanceTimersByTimeAsync(0);
      expect(emulator.write.mock.calls.length).toBe(2);
      expect(emulator.pendingReplyCount()).toBe(1);

      releasePollInspect();
      await vi.advanceTimersByTimeAsync(5);
      expect(settled).toBe(false);
      expect(emulator.pendingReplyCount()).toBe(1);
      expect(pipe.write.mock.calls.some(([data]) => data === "\u001b[1;1R"))
        .toBe(false);

      // Parsing the fresh prompt advances the sequence barrier, but a later
      // real DSR response is now held by the provider transport.
      emulator.releaseNextPendingReply();
      holdProtocolReply = true;
      pipe.output.write("\u001b[6n");
      await vi.advanceTimersByTimeAsync(0);
      expect(pipe.write.mock.calls.some(([data]) => data === "\u001b[1;1R"))
        .toBe(true);
      await vi.advanceTimersByTimeAsync(5);
      expect(settled).toBe(false);
      expect(emulator.pendingReplyCount()).toBe(0);

      pipe.releaseWrites();
      await vi.advanceTimersByTimeAsync(5);
      const result = await operation.done;
      expect(result.waitReason).toBe("stdin_read");
      expect(settled).toBe(true);
    } finally {
      // Promise/queue gate release is idempotent; drain every held path before
      // closing so an assertion failure cannot retain the fake transport.
      try {
        try {
          releasePollInspect();
        } finally {
          try {
            pipe.releaseWrites();
          } finally {
            emulator.releasePendingReply();
          }
        }
      } finally {
        try {
          if (session !== undefined) await closeSession(session);
        } finally {
          vi.useRealTimers();
        }
      }
    }
  });

  it("accepts a prompt split across chunks without requiring a second prompt", async () => {
    const pipe = createPipe();
    const session = createSession(pipe, { protectPrompt: false, inferIdle: false });
    try {
      const operation = session.startSend({ text: "split", submit: true });
      await waitFor(() => pipe.write.mock.calls.length === 1);
      pipe.output.write(OSC_PROMPT + CONTROLLED_PROMPT.slice(0, 11));
      pipe.output.write(CONTROLLED_PROMPT.slice(11));
      expect((await settleWithin(operation.done)).waitReason).toBe("stdin_read");
    } finally {
      await closeSession(session);
    }
  });

  it("accepts the native ConPTY startup frame with the exact no-space sentinel", async () => {
    const pipe = createPipe();
    const emulator = createEmulator({ asyncCallback: true });
    const session = createSession(pipe, {
      emulator,
      promptText: NATIVE_PROMPT_TEXT,
      protectPrompt: false,
      inferIdle: false,
    });
    try {
      const operation = session.startSend({ text: "native-startup", submit: true });
      await waitFor(() => pipe.write.mock.calls.length === 1);
      pipe.output.write("\u001b[6n\u001b[c");
      await waitFor(() => emulator.completedWrites.mock.calls.length === 1);
      expect(emulator.write).toHaveBeenCalledWith(
        "\u001b[6n\u001b[c",
        expect.any(Function),
      );
      // This is the observed rc.2 ConPTY startup shape: clear/render CSI
      // sequences and a title OSC surround the visible no-space sentinel.
      pipe.output.write(NATIVE_CONPTY_STARTUP);
      expect((await settleWithin(operation.done)).waitReason).toBe("stdin_read");
      expect(pipe.write.mock.calls).toContainEqual(["\u001b[1;1R"]);
      expect(pipe.write.mock.calls).toContainEqual(["\u001b[?1;2c"]);
    } finally {
      await closeSession(session);
    }
  });

  it("settles native readiness while a 1 ms background stream continues after the sentinel", async () => {
    const pipe = createPipe();
    const emulator = createEmulator({ asyncCallback: true });
    const session = createSession(pipe, {
      emulator,
      promptText: NATIVE_PROMPT_TEXT,
      protectPrompt: false,
      inferIdle: false,
    });
    try {
      const operation = session.startSend({ text: "native-noise", submit: true });
      await waitFor(() => pipe.write.mock.calls.length === 1);
      pipe.output.write("\u001b[6n\u001b[c");
      await waitFor(() => emulator.completedWrites.mock.calls.length === 1);
      pipe.output.write(NATIVE_CONPTY_STARTUP);
      let liveTicks = 0;
      const interval = setInterval(() => {
        liveTicks += 1;
        pipe.output.write("native-background-live ");
      }, 1);
      try {
        await waitFor(() => liveTicks >= 2);
        expect(liveTicks).toBeGreaterThanOrEqual(2);
        expect((await settleWithin(operation.done)).waitReason).toBe("stdin_read");
      } finally {
        clearInterval(interval);
      }
      expect(session.read({ offset: 0, count: 500 }).text).toContain(
        "native-background-live",
      );
    } finally {
      await closeSession(session);
    }
  });

  it("reproduces the rc.2 native OSC-before-body reorder timeout", async () => {
    const pipe = createPipe();
    const emulator = createEmulator({ asyncCallback: true });
    const session = createSession(pipe, {
      emulator,
      promptText: NATIVE_PROMPT_TEXT,
      protectPrompt: false,
      inferIdle: false,
    });
    try {
      const operation = session.startSend({ text: "native-reordered", submit: true });
      await waitFor(() => pipe.write.mock.calls.length === 1);
      pipe.output.write("\u001b[6n\u001b[c");
      await waitFor(() => emulator.completedWrites.mock.calls.length === 1);
      // This is the focused 691 raw shape: a real producer OSC is followed by
      // visible foreground output and display CSI before the later sentinel.
      // CSI is removable paint state; the ordinary body is not prompt text.
      pipe.output.write(
        "\u001b]133;D;0\u0007"
        + "new-mode-owner-a"
        + "\u001b[48X "
        + "__DSH_PERSISTENT_BASH_END_fixture:0 "
        + NATIVE_PROMPT_TEXT,
      );
      const result = await operation.done;
      expect(result.waitReason).toBe("timeout");
      expect(result.viewport).toContain("new-mode-owner-a");
      expect(result.viewport).toContain(NATIVE_PROMPT_TEXT);
    } finally {
      await closeSession(session);
    }
  });

  it.each([0, 1, 130, 255])(
    "accepts native full-control plus later visible sentinel for status %s",
    async (status) => {
      const pipe = createPipe();
      const session = createSession(pipe, nativeSessionOptions());
      try {
        const operation = session.startSend({ text: `native-status-${status}`, submit: true });
        await waitFor(() => pipe.write.mock.calls.length === 1);
        pipe.output.write(`${nativeControl(status)}ordinary-body`);
        pipe.output.write("\u001b[2J\u001b[m");
        pipe.output.write(NATIVE_PROMPT_TEXT.slice(0, 9));
        pipe.output.write(`${NATIVE_PROMPT_TEXT.slice(9)} native-tail `);
        expect((await settleWithin(operation.done)).waitReason).toBe("stdin_read");
        expect(session.read({ offset: 0, count: 500 }).text).toContain("ordinary-body");
      } finally {
        await closeSession(session);
      }
    },
  );

  it("accepts split ESC/OSC/BEL control and a visible sentinel split across chunks", async () => {
    const pipe = createPipe();
    const session = createSession(pipe, nativeSessionOptions());
    try {
      const operation = session.startSend({ text: "native-split", submit: true });
      await waitFor(() => pipe.write.mock.calls.length === 1);
      pipe.output.write("\u001b");
      pipe.output.write("]133;D;130;" + NATIVE_CONTROL_TEXT);
      pipe.output.write("\u0007");
      pipe.output.write(NATIVE_PROMPT_TEXT.slice(0, 3));
      pipe.output.write(NATIVE_PROMPT_TEXT.slice(3, 15));
      pipe.output.write(NATIVE_PROMPT_TEXT.slice(15));
      expect((await settleWithin(operation.done)).waitReason).toBe("stdin_read");
    } finally {
      await closeSession(session);
    }
  });

  it.each([
    ["control-only", nativeControl(0)],
    ["token-only", NATIVE_PROMPT_TEXT],
    ["bare 133D", `\u001b]133;D\u0007${NATIVE_PROMPT_TEXT}`],
    ["invalid status 256", `${nativeControl(256)}${NATIVE_PROMPT_TEXT}`],
    ["invalid status nonnumeric", `${nativeControl("x")}${NATIVE_PROMPT_TEXT}`],
    ["invalid status negative", `${nativeControl("-1")}${NATIVE_PROMPT_TEXT}`],
    ["invalid status leading zero", `${nativeControl("01")}${NATIVE_PROMPT_TEXT}`],
    ["extra OSC field", `\u001b]133;D;0;${NATIVE_CONTROL_TEXT};extra\u0007${NATIVE_PROMPT_TEXT}`],
    ["empty control text", "\u001b]133;D;0;\u0007" + NATIVE_PROMPT_TEXT],
    ["wrong control text", `${nativeControl(0, "other-marker")}${NATIVE_PROMPT_TEXT}`],
    ["missing BEL", `\u001b]133;D;0;${NATIVE_CONTROL_TEXT}${NATIVE_PROMPT_TEXT}`],
    ["ST terminator", `\u001b]133;D;0;${NATIVE_CONTROL_TEXT}\u001b\\${NATIVE_PROMPT_TEXT}`],
    ["wrong visible marker", `${nativeControl(0)}__DSH_PERSISTENT_BASH_PROMPT_X__`],
  ])("does not ready on native %s", async (_name, output) => {
    const pipe = createPipe();
    const session = createSession(pipe, nativeSessionOptions());
    try {
      const operation = session.startSend({ text: "native-invalid", submit: true });
      await waitFor(() => pipe.write.mock.calls.length === 1);
      pipe.output.write(output);
      expect((await operation.done).waitReason).toBe("timeout");
    } finally {
      await closeSession(session);
    }
  });

  it("does not let a WSL ordinary body gap satisfy its strict visible prefix", async () => {
    const pipe = createPipe();
    const session = createSession(pipe, { protectPrompt: false, inferIdle: false });
    try {
      const operation = session.startSend({ text: "wsl-body-gap", submit: true });
      await waitFor(() => pipe.write.mock.calls.length === 1);
      pipe.output.write(`${COMPLETE_PROMPT.slice(0, OSC_PROMPT.length)}ordinary-body${CONTROLLED_PROMPT}`);
      expect((await operation.done).waitReason).toBe("timeout");
    } finally {
      await closeSession(session);
    }
  });

  it("keeps native readiness after a visible sentinel's background suffix", async () => {
    const pipe = createPipe();
    const session = createSession(pipe, nativeSessionOptions());
    try {
      const operation = session.startSend({ text: "native-suffix", submit: true });
      await waitFor(() => pipe.write.mock.calls.length === 1);
      pipe.output.write(`${nativeControl(0)}${NATIVE_PROMPT_TEXT} background-after-visible `);
      expect((await settleWithin(operation.done)).waitReason).toBe("stdin_read");
    } finally {
      await closeSession(session);
    }
  });

  it("keeps the native visible-marker rolling tail bounded across a long body", async () => {
    const pipe = createPipe();
    const session = createSession(pipe, nativeSessionOptions());
    try {
      const operation = session.startSend({ text: "native-long-body", submit: true });
      await waitFor(() => pipe.write.mock.calls.length === 1);
      pipe.output.write(nativeControl(0) + "body-fragment ".repeat(10_000));
      pipe.output.write(NATIVE_PROMPT_TEXT);
      expect((await settleWithin(operation.done)).waitReason).toBe("stdin_read");
    } finally {
      await closeSession(session);
    }
  });

  it("resets a stale native control pair between operations and recovers on a fresh pair", async () => {
    const pipe = createPipe();
    const session = createSession(pipe, nativeSessionOptions());
    try {
      const first = session.startSend({ text: "stale-first", submit: true });
      await waitFor(() => pipe.write.mock.calls.length === 1);
      pipe.output.write(nativeControl(0));
      expect((await first.done).waitReason).toBe("timeout");

      const second = session.startSend({ text: "stale-second", submit: true });
      await waitFor(() => pipe.write.mock.calls.some(([data]) => data === "stale-second\r"));
      pipe.output.write(NATIVE_PROMPT_TEXT);
      expect((await second.done).waitReason).toBe("timeout");

      const third = session.startSend({ text: "fresh-third", submit: true });
      await waitFor(() => pipe.write.mock.calls.some(([data]) => data === "fresh-third\r"));
      pipe.output.write(`${nativeControl(0)}${NATIVE_PROMPT_TEXT}`);
      expect((await settleWithin(third.done)).waitReason).toBe("stdin_read");
    } finally {
      await closeSession(session);
    }
  });

  it("does not re-settle a cancelled operation from a late native pair and supports a new session", async () => {
    const firstPipe = createPipe();
    const firstSession = createSession(firstPipe, nativeSessionOptions());
    try {
      const operation = firstSession.startSend({ text: "cancel-native", submit: true });
      await waitFor(() => firstPipe.write.mock.calls.length === 1);
      firstPipe.output.write(nativeControl(0));
      expect(operation.cancel()).toBe(true);
      expect((await operation.done).waitReason).toBe("timeout");
      const lateVisible = firstSession.startSend({ text: "late-visible", submit: true });
      await waitFor(() => firstPipe.write.mock.calls.some(([data]) => data === "late-visible\r"));
      firstPipe.output.write(NATIVE_PROMPT_TEXT);
      expect((await lateVisible.done).waitReason).toBe("timeout");
    } finally {
      await closeSession(firstSession);
    }

    const secondPipe = createPipe();
    const secondSession = createSession(secondPipe, nativeSessionOptions());
    try {
      const operation = secondSession.startSend({ text: "new-session", submit: true });
      await waitFor(() => secondPipe.write.mock.calls.length === 1);
      secondPipe.output.write(`${nativeControl(1)}${NATIVE_PROMPT_TEXT}`);
      expect((await settleWithin(operation.done)).waitReason).toBe("stdin_read");
    } finally {
      await closeSession(secondSession);
    }
  });

  it.each([
    ["incomplete prompt", OSC_PROMPT + CONTROLLED_PROMPT.slice(0, -1)],
    ["wrong prompt prefix", OSC_PROMPT + "__DSH_PERSISTENT_BASH_PROMPT__X"],
    [
      "background token inserted before the WSL trailing space",
      OSC_PROMPT + "__DSH_PERSISTENT_BASH_PROMPT__X ",
    ],
    ["native no-space sentinel", NATIVE_CONPTY_STARTUP],
  ])("does not complete on %s", async (_name, output) => {
    const pipe = createPipe();
    const session = createSession(pipe, { protectPrompt: false, inferIdle: false });
    try {
      const operation = session.startSend({ text: "invalid", submit: true });
      await waitFor(() => pipe.write.mock.calls.length === 1);
      pipe.output.write(output);
      expect((await operation.done).waitReason).toBe("timeout");
    } finally {
      await closeSession(session);
    }
  });

  it("does not complete when the verified foreground changes after the prompt starts", async () => {
    const inspectForeground = vi.fn()
      .mockResolvedValueOnce({ processGroupId: 101, inputWaiting: false })
      .mockResolvedValueOnce({ processGroupId: 101, inputWaiting: false })
      .mockResolvedValue({ processGroupId: 202, inputWaiting: false });
    const pipe = createPipe(inspectForeground);
    const session = createSession(pipe, { protectPrompt: false, inferIdle: false });
    try {
      const operation = session.startSend({ text: "wrong-fg", submit: true });
      await waitFor(() => pipe.write.mock.calls.length === 1);
      pipe.output.write(OSC_PROMPT + CONTROLLED_PROMPT.slice(0, 9));
      await waitFor(() => pipe.inspectForeground.mock.calls.length >= 2);
      pipe.output.write(CONTROLLED_PROMPT.slice(9));
      expect((await operation.done).waitReason).toBe("timeout");
    } finally {
      await closeSession(session);
    }
  });

  it("does not add prompt protection when the shared session is configured for Git", async () => {
    const pipe = createPipe();
    const session = createSession(pipe, { protectPrompt: false, inferIdle: false });
    try {
      const initializing = session.initialize().then(() => true, () => false);
      // The unsubmitted empty startup send is an internal readiness operation;
      // it does not write to the PTY.  Git relies on the host emulator and
      // therefore must not receive the WSL prompt-protection command.
      await waitFor(() => pipe.inspectForeground.mock.calls.length >= 1);
      pipe.output.write(COMPLETE_PROMPT);
      expect(await initializing).toBe(true);
      expect(pipe.write).not.toHaveBeenCalled();
    } finally {
      await closeSession(session);
    }
  });

  it("writes DSR/DA emulator replies and waits for pending protocol delivery before the next send", async () => {
    const pipe = createPipe();
    const emulator = createEmulator({ holdFirstWrite: true });
    const session = createSession(pipe, {
      emulator,
      protectPrompt: false,
      inferIdle: false,
    });
    try {
      const first = session.startSend({ text: "query", submit: true });
      await waitFor(() => pipe.write.mock.calls.length === 1);
      pipe.output.write(`\u001b[6n\u001b[c${COMPLETE_PROMPT}`);
      await waitFor(() => pipe.write.mock.calls.some(([data]) => data === "\u001b[1;1R"));
      await new Promise((resolve) => setTimeout(resolve, 15));
      expect(emulator.write).toHaveBeenCalled();
      expect(pipe.write.mock.calls.filter(([data]) => data === "second\r")).toHaveLength(0);
      let settled = false;
      void first.done.finally(() => { settled = true; });
      expect(settled).toBe(false);
      emulator.releasePendingReply();
      expect((await settleWithin(first.done)).waitReason).toBe("stdin_read");

      const second = session.startSend({ text: "second", submit: true });
      await waitFor(() => pipe.write.mock.calls.some(([data]) => data === "second\r"));
      pipe.output.write(COMPLETE_PROMPT);
      expect((await settleWithin(second.done)).waitReason).toBe("stdin_read");
    } finally {
      await closeSession(session);
    }
  });

  it("does not start the next send while a provider reply is still pending", async () => {
    const pipe = createPipe(undefined, {
      holdWriteWhen: (data) => data === "\u001b[1;1R",
    });
    const emulator = createEmulator();
    const session = createSession(pipe, {
      emulator,
      protectPrompt: false,
      inferIdle: false,
    });
    try {
      const first = session.startSend({ text: "provider-reply", submit: true });
      await waitFor(() => pipe.write.mock.calls.length === 1);
      pipe.output.write(`${COMPLETE_PROMPT}\u001b[6n`);
      await waitFor(() => pipe.write.mock.calls.some(([data]) => data === "\u001b[1;1R"));
      await new Promise((resolve) => setTimeout(resolve, 15));
      let settled = false;
      void first.done.then(() => { settled = true; }, () => { settled = true; });
      expect(settled).toBe(false);
      expect(() => session.startSend({ text: "blocked", submit: true }))
        .toThrow(/already has an active send/i);
      pipe.releaseWrites();
      expect((await settleWithin(first.done)).waitReason).toBe("stdin_read");
      const second = session.startSend({ text: "after-reply", submit: true });
      await waitFor(() => pipe.write.mock.calls.some(([data]) => data === "after-reply\r"));
      pipe.output.write(COMPLETE_PROMPT);
      expect((await settleWithin(second.done)).waitReason).toBe("stdin_read");
    } finally {
      pipe.releaseWrites();
      await closeSession(session);
    }
  });

  it("does not write a command after startup protocol drain outlives the deadline", async () => {
    const pipe = createPipe();
    const emulator = createEmulator({ holdFirstWrite: true });
    const session = createSession(pipe, {
      emulator,
      protectPrompt: false,
      inferIdle: false,
    });
    try {
      // Hold a real emulator write before the operation starts.  The deadline
      // must retain ownership until this drain completes, but must not let the
      // timed-out operation publish its original input afterward.
      pipe.output.write("\u001b[6n");
      await waitFor(() => emulator.write.mock.calls.length === 1);
      const operation = session.startSend({ text: "late-startup", submit: true });
      expect((await settleWithin(operation.done, 180)).waitReason).toBe("timeout");
      expect(pipe.write.mock.calls.some(([data]) => data === "late-startup\r")).toBe(false);

      emulator.releasePendingReply();
      await waitFor(() => pipe.inspectForeground.mock.calls.length >= 1);

      let next: ReturnType<WslPtySession["startSend"]> | undefined;
      await waitFor(() => {
        if (next !== undefined) return true;
        try {
          next = session.startSend({ text: "after-startup-timeout", submit: true });
          return true;
        } catch {
          return false;
        }
      });
      await waitFor(() => pipe.write.mock.calls.some(
        ([data]) => data === "after-startup-timeout\r",
      ));
      pipe.output.write(COMPLETE_PROMPT);
      expect((await settleWithin(next!.done)).waitReason).toBe("stdin_read");
    } finally {
      emulator.releasePendingReply();
      await closeSession(session);
    }
  });

  it("drains a held output-stage protocol reply before releasing the timed-out slot", async () => {
    const pipe = createPipe();
    const emulator = createEmulator({ holdFirstWrite: true });
    const session = createSession(pipe, {
      emulator,
      protectPrompt: false,
      inferIdle: false,
    });
    try {
      const operation = session.startSend({ text: "output-stage", submit: true });
      await waitFor(() => pipe.write.mock.calls.some(([data]) => data === "output-stage\r"));
      pipe.output.write(`${COMPLETE_PROMPT}\u001b[6n`);
      await waitFor(() => emulator.write.mock.calls.length === 1);
      expect((await settleWithin(operation.done, 180)).waitReason).toBe("timeout");
      expect(() => session.startSend({ text: "premature", submit: true }))
        .toThrow(/already has an active send/i);

      emulator.releasePendingReply();
      await waitFor(() => pipe.inspectForeground.mock.calls.length >= 2);
      let next: ReturnType<WslPtySession["startSend"]> | undefined;
      await waitFor(() => {
        if (next !== undefined) return true;
        try {
          next = session.startSend({ text: "after-output-timeout", submit: true });
          return true;
        } catch {
          return false;
        }
      });
      await waitFor(() => pipe.write.mock.calls.some(
        ([data]) => data === "after-output-timeout\r",
      ));
      pipe.output.write(COMPLETE_PROMPT);
      expect((await settleWithin(next!.done)).waitReason).toBe("stdin_read");
      expect(pipe.write.mock.calls.filter(([data]) => data === "output-stage\r"))
        .toHaveLength(1);
    } finally {
      emulator.releasePendingReply();
      await closeSession(session);
    }
  });

  it("keeps a cancelled timeout owned while protocol is pending, then closes cleanly", async () => {
    const pipe = createPipe();
    const emulator = createEmulator({ holdFirstWrite: true });
    const session = createSession(pipe, {
      emulator,
      protectPrompt: false,
      inferIdle: false,
    });
    const ended = outputEnded(pipe);
    try {
      const operation = session.startSend({ text: "cancel-pending", submit: true });
      await waitFor(() => pipe.write.mock.calls.some(([data]) => data === "cancel-pending\r"));
      pipe.output.write(`${COMPLETE_PROMPT}\u001b[6n`);
      await waitFor(() => emulator.write.mock.calls.length === 1);
      expect(operation.cancel()).toBe(true);
      expect((await settleWithin(operation.done, 180)).waitReason).toBe("timeout");
      expect(() => session.startSend({ text: "before-close", submit: true }))
        .toThrow(/already has an active send/i);

      await settleWithin(session.close("cancelled pending protocol cleanup"), 250);
      await settleWithin(ended, 250);
      expect(pipe.terminate).toHaveBeenCalledTimes(1);
      expect(emulator.dispose).toHaveBeenCalledTimes(1);
      const writesBeforeLateCallback = emulator.write.mock.calls.length;
      emulator.releasePendingReply();
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(emulator.write).toHaveBeenCalledTimes(writesBeforeLateCallback);
      expect(emulator.dispose).toHaveBeenCalledTimes(1);
    } finally {
      emulator.releasePendingReply();
      await closeSession(session);
    }
  });

  it("fails closed when pending emulator input exceeds 1 MiB", async () => {
    const pipe = createPipe();
    const emulator = createEmulator({ holdFirstWrite: true });
    const session = createSession(pipe, {
      emulator,
      protectPrompt: false,
      inferIdle: false,
    });
    const ended = outputEnded(pipe);
    try {
      const operation = session.startSend({ text: "input-bound", submit: true });
      await waitFor(() => pipe.write.mock.calls.length === 1);
      pipe.output.write("x".repeat(1024 * 1024 + 1));
      await expect(operation.done).rejects.toThrow(/input limit exceeded/);
      await settleWithin(ended, 250);
      expect(pipe.terminate).toHaveBeenCalledTimes(1);
      expect(emulator.dispose).toHaveBeenCalledTimes(1);
    } finally {
      await closeSessionExpectingFailure(session, /input limit exceeded/);
    }
  });

  it("fails closed when more than 256 provider replies are pending", async () => {
    const pipe = createPipe();
    const emulator = createEmulator();
    const session = createSession(pipe, {
      emulator,
      protectPrompt: false,
      inferIdle: false,
    });
    const ended = outputEnded(pipe);
    try {
      const operation = session.startSend({ text: "reply-count-bound", submit: true });
      await waitFor(() => pipe.write.mock.calls.length === 1);
      for (let index = 0; index < 257; index += 1) emulator.emitData(`reply-${index}`);
      await expect(operation.done).rejects.toThrow(/reply limit exceeded/);
      await settleWithin(ended, 250);
      expect(pipe.terminate).toHaveBeenCalledTimes(1);
      expect(emulator.dispose).toHaveBeenCalledTimes(1);
    } finally {
      await closeSessionExpectingFailure(session, /reply limit exceeded/);
    }
  });

  it("fails closed when one provider reply exceeds 4096 bytes", async () => {
    const pipe = createPipe();
    const emulator = createEmulator();
    const session = createSession(pipe, {
      emulator,
      protectPrompt: false,
      inferIdle: false,
    });
    const ended = outputEnded(pipe);
    try {
      const operation = session.startSend({ text: "reply-size-bound", submit: true });
      await waitFor(() => pipe.write.mock.calls.length === 1);
      emulator.emitData("r".repeat(4097));
      await expect(operation.done).rejects.toThrow(/reply limit exceeded/);
      await settleWithin(ended, 250);
      expect(pipe.terminate).toHaveBeenCalledTimes(1);
      expect(emulator.dispose).toHaveBeenCalledTimes(1);
    } finally {
      await closeSessionExpectingFailure(session, /reply limit exceeded/);
    }
  });

  it("cleans up exactly once when emulator onData registration fails", () => {
    const pipe = createPipe();
    const emulator = createEmulator({ failOnDataRegistration: true });
    expect(() => createSession(pipe, { emulator })).toThrow(/onData registration failed/);
    expect(emulator.onData).toHaveBeenCalledTimes(1);
    expect(emulator.dispose).toHaveBeenCalledTimes(1);
    expect(pipe.terminate).not.toHaveBeenCalled();
  });

  it("rejects an empty prompt option and disposes its emulator exactly once", () => {
    const pipe = createPipe();
    const emulator = createEmulator();
    expect(() => createSession(pipe, { emulator, promptText: "" })).toThrow(
      /controlled prompt must not be empty/i,
    );
    expect(emulator.dispose).toHaveBeenCalledTimes(1);
    expect(pipe.terminate).not.toHaveBeenCalled();

    const controlEmulator = createEmulator();
    expect(() => createSession(pipe, {
      emulator: controlEmulator,
      promptControlText: "",
    })).toThrow(/controlled prompt must not be empty/i);
    expect(controlEmulator.dispose).toHaveBeenCalledTimes(1);
  });

  it("fails and closes exactly once when the provider rejects an emulator reply write", async () => {
    const pipe = createPipe(undefined, { failWriteAfter: 1 });
    const emulator = createEmulator();
    const session = createSession(pipe, {
      emulator,
      protectPrompt: false,
      inferIdle: false,
    });
    const ended = outputEnded(pipe);
    try {
      const operation = session.startSend({ text: "provider-write-bound", submit: true });
      await waitFor(() => pipe.write.mock.calls.length === 1);
      pipe.output.write(`${COMPLETE_PROMPT}\u001b[6n`);
      await expect(operation.done).rejects.toThrow(/provider write failed/);
      await settleWithin(ended, 250);
      expect(pipe.terminate).toHaveBeenCalledTimes(1);
      expect(emulator.dispose).toHaveBeenCalledTimes(1);
    } finally {
      await closeSessionExpectingFailure(session, /provider write failed/);
    }
  });

  it("resumes a paused output stream on a timeout with a pending emulator callback", async () => {
    const pipe = createPipe();
    const emulator = createEmulator({ holdFirstWrite: true });
    const session = createSession(pipe, {
      emulator,
      protectPrompt: false,
      inferIdle: false,
    });
    const ended = outputEnded(pipe);
    try {
      const operation = session.startSend({ text: "pending-timeout", submit: true });
      await waitFor(() => pipe.write.mock.calls.length === 1);
      pipe.output.write(`${COMPLETE_PROMPT}\u001b[6n`);
      await waitFor(() => emulator.write.mock.calls.length === 1);
      expect((await settleWithin(operation.done, 250)).waitReason).toBe("timeout");

      await settleWithin(session.close("pending emulator timeout cleanup"), 250);
      await settleWithin(ended, 250);
      expect(pipe.terminate).toHaveBeenCalledTimes(1);
      expect(emulator.dispose).toHaveBeenCalledTimes(1);

      // A provider callback arriving after owner close must not re-enter the
      // parser or schedule another reply/dispose path.
      const writesBeforeLateCallback = emulator.write.mock.calls.length;
      emulator.releasePendingReply();
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(emulator.write).toHaveBeenCalledTimes(writesBeforeLateCallback);
      expect(emulator.dispose).toHaveBeenCalledTimes(1);
    } finally {
        await closeSession(session);
    }
  });

  it("resumes a paused output stream when cancellation closes a pending emulator callback", async () => {
    const pipe = createPipe();
    const emulator = createEmulator({ holdFirstWrite: true });
    const session = createSession(pipe, {
      emulator,
      protectPrompt: false,
      inferIdle: false,
    });
    const ended = outputEnded(pipe);
    try {
      const operation = session.startSend({ text: "pending-cancel", submit: true });
      await waitFor(() => pipe.write.mock.calls.length === 1);
      pipe.output.write(`${COMPLETE_PROMPT}\u001b[6n`);
      await waitFor(() => emulator.write.mock.calls.length === 1);
      expect(operation.cancel()).toBe(true);
      await settleWithin(session.close("pending emulator cancellation cleanup"), 250);
      await settleWithin(ended, 250);
      expect(pipe.terminate).toHaveBeenCalledTimes(1);
      expect(emulator.dispose).toHaveBeenCalledTimes(1);

      const writesBeforeLateCallback = emulator.write.mock.calls.length;
      emulator.releasePendingReply();
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(emulator.write).toHaveBeenCalledTimes(writesBeforeLateCallback);
      expect(emulator.dispose).toHaveBeenCalledTimes(1);
    } finally {
        await closeSession(session);
    }
  });

  it("closes a paused stream on transport failure and ignores the late emulator callback", async () => {
    const pipe = createPipe();
    const emulator = createEmulator({ holdFirstWrite: true });
    const session = createSession(pipe, {
      emulator,
      protectPrompt: false,
      inferIdle: false,
    });
    const ended = outputEnded(pipe);
    try {
      const operation = session.startSend({ text: "pending-failure", submit: true });
      await waitFor(() => pipe.write.mock.calls.length === 1);
      pipe.output.write(`${COMPLETE_PROMPT}\u001b[6n`);
      await waitFor(() => emulator.write.mock.calls.length === 1);
      pipe.output.emit("error", new Error("transport stream failed"));
      const outcome = await Promise.race([
        operation.done.then(() => "resolved" as const, () => "rejected" as const),
        new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 300)),
      ]);
      expect(outcome).toBe("rejected");
      await settleWithin(ended, 250);
      expect(pipe.terminate).toHaveBeenCalledTimes(1);
      expect(emulator.dispose).toHaveBeenCalledTimes(1);

      const writesBeforeLateCallback = emulator.write.mock.calls.length;
      emulator.releasePendingReply();
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(emulator.write).toHaveBeenCalledTimes(writesBeforeLateCallback);
      expect(emulator.dispose).toHaveBeenCalledTimes(1);
    } finally {
        await closeSessionExpectingFailure(session, /transport stream failed/);
    }
  });

  it("cleans up exactly once when emulator write fails", async () => {
    const pipe = createPipe();
    const emulator = createEmulator({ failWrite: true });
    const session = createSession(pipe, {
      emulator,
      protectPrompt: false,
      inferIdle: false,
    });
    const ended = outputEnded(pipe);
    try {
      const operation = session.startSend({ text: "emulator-failure", submit: true });
      await waitFor(() => pipe.write.mock.calls.length === 1);
      pipe.output.write(COMPLETE_PROMPT);
      const outcome = await Promise.race([
        operation.done.then(() => "resolved" as const, () => "rejected" as const),
        new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 300)),
      ]);
      // A protocol write failure must reject the active operation.  The
      // timeout branch deliberately keeps this negative contract bounded so
      // a paused output stream cannot hide a cleanup regression behind Vitest's
      // global timeout.
      expect(outcome).toBe("rejected");
      await settleWithin(ended, 250);
      expect(emulator.dispose).toHaveBeenCalledTimes(1);
      expect(pipe.terminate).toHaveBeenCalledTimes(1);
    } finally {
      await closeSessionExpectingFailure(session, /emulator write failed/);
    }
  });
});
