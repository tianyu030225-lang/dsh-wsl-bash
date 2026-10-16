import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import { resolveConfig } from "../../../src/config.js";
import {
  WslPtySession,
  type WslPtyForeground,
  type WslPtyTransport,
} from "../../../src/terminal/session.js";

const CONTROLLED_PROMPT =
  "\u001b]133;D;0\u0007__DSH_PERSISTENT_BASH_PROMPT__ ";

type LivePipe = {
  output: PassThrough;
  transport: WslPtyTransport;
  inspectForeground: ReturnType<typeof vi.fn>;
  terminate: ReturnType<typeof vi.fn>;
  write: ReturnType<typeof vi.fn>;
};

function livePipeTransport(
  inspectForeground: () => Promise<WslPtyForeground | undefined> = async () => undefined,
): LivePipe {
  const output = new PassThrough();
  let finish!: () => void;
  const done = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => { finish = () => resolve({ exitCode: null, signal: "SIGTERM" }); },
  );
  const write = vi.fn(async () => undefined);
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
    signalForeground: vi.fn(async () => undefined),
    terminate,
  };
  return { output, transport, inspectForeground: inspect, terminate, write };
}

function createSession(pipe: LivePipe): WslPtySession {
  return new WslPtySession(
    pipe.transport,
    resolveConfig({
      pollIntervalMs: 5,
      idleSilenceMs: 15,
      timeoutMs: 90,
      maxReadBytes: 4096,
      scrollbackMaxBytes: 4096,
    }),
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
  await session.close("readiness regression cleanup");
}

describe("WSL PTY controlled-prompt readiness", () => {
  it.each([
    ["complete prompt and bounded background output in one chunk", CONTROLLED_PROMPT + "bg"],
    [
      "complete prompt and bounded background output in separate chunks",
      [CONTROLLED_PROMPT, "bg"],
    ],
    [
      "complete prompt followed by bounded background output across chunks",
      [CONTROLLED_PROMPT.slice(0, 18), `${CONTROLLED_PROMPT.slice(18)}bg`],
    ],
  ])("settles stopped output and keeps the next send usable: %s", async (_name, chunks) => {
    const pipe = livePipeTransport();
    const session = createSession(pipe);
    try {
      const first = session.startSend({ text: "first", submit: true });
      await waitFor(() => pipe.write.mock.calls.length === 1);
      for (const chunk of Array.isArray(chunks) ? chunks : [chunks]) pipe.output.write(chunk);
      const firstResult = await first.done;
      expect(firstResult.waitReason).toBe("stdin_read");

      const second = session.startSend({ text: "second", submit: true });
      await waitFor(() => pipe.write.mock.calls.length === 2);
      pipe.output.write(CONTROLLED_PROMPT);
      const secondResult = await second.done;
      expect(secondResult.waitReason).toBe("stdin_read");
      expect(session.status().kind).toBe("running");
    } finally {
      await closeSession(session);
    }
  });

  it.each([
    ["OSC marker only", "\u001b]133;D;0\u0007"],
    ["incomplete controlled prompt", CONTROLLED_PROMPT.slice(0, -1)],
    ["mismatched controlled prompt", `${CONTROLLED_PROMPT.slice(0, -1)}X`],
  ])("does not ready on %s", async (_name, output) => {
    const pipe = livePipeTransport();
    const session = createSession(pipe);
    try {
      const operation = session.startSend({ text: "not-ready", submit: true });
      await waitFor(() => pipe.write.mock.calls.length === 1);
      pipe.output.write(output);
      const result = await operation.done;
      expect(result.waitReason).toBe("timeout");
    } finally {
      await closeSession(session);
    }
  });

  it("revokes a complete prompt when a later OSC-only marker arrives", async () => {
    const pipe = livePipeTransport();
    const session = createSession(pipe);
    try {
      const operation = session.startSend({ text: "prompt-reset", submit: true });
      await waitFor(() => pipe.write.mock.calls.length === 1);
      pipe.output.write(CONTROLLED_PROMPT);
      pipe.output.write("\u001b]133;D;0\u0007");
      const result = await operation.done;
      expect(result.waitReason).toBe("timeout");
    } finally {
      await closeSession(session);
    }
  });

  it("does not infer completion from ordinary promptless silent output", async () => {
    const pipe = livePipeTransport();
    const session = createSession(pipe);
    try {
      const operation = session.startSend({ text: "sleep 5", submit: true });
      await waitFor(() => pipe.write.mock.calls.length === 1);
      pipe.output.write("ordinary output without a controlled prompt");
      const result = await operation.done;
      expect(result.waitReason).toBe("timeout");
    } finally {
      await closeSession(session);
    }
  });

  it("does not ready after the prompt when the verified foreground group changes", async () => {
    const inspectForeground = vi.fn()
      .mockResolvedValueOnce({ processGroupId: 100, inputWaiting: false })
      .mockResolvedValueOnce({ processGroupId: 100, inputWaiting: false })
      .mockResolvedValue({ processGroupId: 200, inputWaiting: false });
    const pipe = livePipeTransport(inspectForeground);
    const session = createSession(pipe);
    try {
      const operation = session.startSend({ text: "foreground", submit: true });
      await waitFor(() => pipe.write.mock.calls.length === 1);
      pipe.output.write(CONTROLLED_PROMPT.slice(0, 18));
      await waitFor(() => pipe.inspectForeground.mock.calls.length >= 2);
      pipe.output.write(CONTROLLED_PROMPT.slice(18));
      const result = await operation.done;
      expect(result.waitReason).toBe("timeout");
    } finally {
      await closeSession(session);
    }
  });
});
