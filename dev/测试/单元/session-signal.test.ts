import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { SubprocessHandle } from "@deepseek-ai/dsh-subprocess";

import { resolveConfig } from "../../../src/config.js";
import {
  WslPtySession,
  WslPtyTransportAdapter,
  type WslPtyTransport,
} from "../../../src/terminal/session.js";

const CONTROLLED_PROMPT =
  "\u001b]133;D;0\u0007__DSH_PERSISTENT_BASH_PROMPT__ ";

function livePipeTransport() {
  const output = new PassThrough();
  let finish!: () => void;
  const done = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      finish = () => resolve({ exitCode: null, signal: "SIGTERM" });
    },
  );
  const signalForeground = vi.fn(async () => undefined);
  const terminate = vi.fn(async () => {
    finish();
    output.end();
  });
  const transport: WslPtyTransport = {
    output,
    done,
    write: vi.fn(async (data: string) => {
      if (data.includes("readonly PROMPT_COMMAND")) output.write(CONTROLLED_PROMPT);
    }),
    inspectForeground: vi.fn(async () => undefined),
    signalForeground,
    terminate,
  };
  return { output, signalForeground, terminate, transport };
}

describe("persistent WSL signal and PID boundary", () => {
  it("rejects a registry signal before side effects when no Linux PGID is verified", async () => {
    const pipe = livePipeTransport();
    const session = new WslPtySession(
      pipe.transport,
      resolveConfig({ pollIntervalMs: 1, idleSilenceMs: 1, timeoutMs: 500 }),
    );

    const initializing = session.initialize();
    pipe.output.write(CONTROLLED_PROMPT);
    await initializing;

    await expect(session.signal("SIGINT")).rejects.toThrow(
      /foreground process group cannot be verified/i,
    );
    expect(pipe.signalForeground).not.toHaveBeenCalled();
    expect(pipe.terminate).not.toHaveBeenCalled();

    await session.close("test cleanup");
    expect(pipe.terminate).toHaveBeenCalledTimes(1);
  });

  it("does not expose an ordinary subprocess PID as a Linux process-group target", async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const done = Promise.resolve({ exitCode: 0, signal: null });
    const terminate = vi.fn(async () => {
      stdout.end();
      stderr.end();
    });
    const handle: SubprocessHandle = {
      stdin: new PassThrough(),
      stdout,
      stderr,
      control: undefined,
      collected: {},
      done,
      terminate,
      waitForExit: vi.fn(async () => true),
    };

    const adapter = new WslPtyTransportAdapter(handle);
    expect(adapter.pid).toBeUndefined();
    expect(await adapter.inspectForeground()).toBeUndefined();
    expect(await adapter.signalForeground("SIGTERM")).toBeUndefined();
    expect(terminate).toHaveBeenCalledTimes(1);
  });
});
