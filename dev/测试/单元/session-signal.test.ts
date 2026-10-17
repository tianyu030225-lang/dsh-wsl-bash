import { PassThrough, Writable } from "node:stream";
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
  function adapterFixture(stdin: Writable) {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let resolveDone!: (value: { exitCode: number | null; signal: NodeJS.Signals | null }) => void;
    const done = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      resolveDone = resolve;
    });
    const terminate = vi.fn(() => {
      stdout.end();
      stderr.end();
      resolveDone({ exitCode: null, signal: "SIGTERM" });
    });
    const handle: SubprocessHandle = {
      stdin,
      stdout,
      stderr,
      control: undefined,
      collected: {},
      done,
      terminate,
      waitForExit: vi.fn(async () => true),
    };
    return { adapter: new WslPtyTransportAdapter(handle), stdin, terminate };
  }

  it("rejects a true-returning write whose callback later reports EPIPE", async () => {
    const error = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
    const stdin = new Writable({
      write(_chunk, _encoding, callback) {
        queueMicrotask(() => callback(error));
      },
    });
    const fixture = adapterFixture(stdin);
    fixture.adapter.output.on("error", () => {});
    expect(stdin.listenerCount("error")).toBeGreaterThan(0);
    await expect(fixture.adapter.write("payload")).rejects.toThrow(/EPIPE/);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await fixture.adapter.terminate();
    expect(fixture.terminate).toHaveBeenCalledOnce();
  });

  it("turns a late stdin error into a transport failure without an unhandled event", async () => {
    const stdin = new PassThrough();
    const fixture = adapterFixture(stdin);
    await fixture.adapter.write("payload");
    const outputError = new Promise<Error>((resolve) => {
      fixture.adapter.output.once("error", resolve);
    });
    stdin.emit("error", Object.assign(new Error("late EPIPE"), { code: "EPIPE" }));
    await expect(outputError).resolves.toMatchObject({ message: "late EPIPE" });
    await fixture.adapter.terminate();
  });

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
