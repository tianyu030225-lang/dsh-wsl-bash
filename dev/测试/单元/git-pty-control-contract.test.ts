import { Duplex, PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import { readPtyControl, writePtyControl } from "../../../src/git/pty-control.js";

class ControlChannel extends Duplex {
  readonly writes: string[] = [];
  onWrite: ((text: string) => void) | undefined;

  constructor() {
    super({
      read: () => {},
      write: (chunk, _encoding, callback) => {
        const text = chunk.toString();
        this.writes.push(text);
        this.onWrite?.(text);
        callback();
      },
    });
  }

  feed(text: string): void {
    this.push(text);
  }
}

function readHarness(channel: Duplex = new ControlChannel()): {
  channel: Duplex;
  received: Record<string, unknown>[];
  failures: Error[];
  stop: () => void;
} {
  const received: Record<string, unknown>[] = [];
  const failures: Error[] = [];
  const stop = readPtyControl(
    channel,
    (message) => received.push(message),
    (error) => failures.push(error),
  );
  return { channel, received, failures, stop };
}

describe("private Git Bash PTY control framing", () => {
  it("keeps newline-delimited control packets separate from PTY output", async () => {
    const channel = new ControlChannel();
    const harness = readHarness(channel);

    channel.feed('{"kind":"ready","pid":42}\n');
    channel.feed('{"kind":"ack","id":1}\n');
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(harness.received).toEqual([
      { kind: "ready", pid: 42 },
      { kind: "ack", id: 1 },
    ]);
    expect(harness.failures).toEqual([]);
    harness.stop();
  });

  it.each([
    ["malformed JSON", "{not-json}\n"],
    ["JSON scalar", "42\n"],
    ["JSON array", "[]\n"],
  ])("rejects %s before delivery", async (_label, frame) => {
    const harness = readHarness();

    (harness.channel as ControlChannel).feed(frame);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(harness.received).toEqual([]);
    expect(harness.failures).toHaveLength(1);
    harness.stop();
  });

  it("rejects a semantic unknown packet and retains one failure", async () => {
    const channel = new ControlChannel();
    const failures: Error[] = [];
    const stop = readPtyControl(
      channel,
      (message) => {
        if (message.kind !== "ready") throw new Error("unknown control packet");
      },
      (error) => failures.push(error),
    );

    channel.feed('{"kind":"future-op"}\n');
    await new Promise<void>((resolve) => setImmediate(resolve));
    channel.emit("error", new Error("late transport error"));
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(failures).toHaveLength(1);
    expect(failures[0]?.message).toBe("unknown control packet");
    stop();
  });

  it("rejects a UTF-8 control frame that exceeds 64 KiB", async () => {
    const harness = readHarness();

    (harness.channel as ControlChannel).feed("x".repeat(64 * 1024 + 1));
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(harness.received).toEqual([]);
    expect(harness.failures).toHaveLength(1);
    expect(harness.failures[0]?.message).toMatch(/size limit/i);
    harness.stop();
  });

  it("rejects an EOF-delimited partial frame", async () => {
    const channel = new ControlChannel();
    const harness = readHarness(channel);

    channel.feed('{"kind":"ready"}');
    channel.push(null);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(harness.failures).toHaveLength(1);
    expect(harness.failures[0]?.message).toMatch(/incomplete frame/i);
    harness.stop();
  });

  it("does not write an oversized outbound packet", async () => {
    const channel = new ControlChannel();
    const write = writePtyControl(channel, { payload: "x".repeat(64 * 1024) });

    await expect(write).rejects.toThrow(/size limit/i);
    expect(channel.writes).toEqual([]);
  });

  it("accepts a frame exactly at the bounded size", async () => {
    const channel = new ControlChannel();
    const emptyFrame = JSON.stringify({ payload: "" });
    const targetPayloadBytes = 64 * 1024 - Buffer.byteLength(emptyFrame, "utf8") - 1;
    const payload = "x".repeat(targetPayloadBytes);
    const frame = `${JSON.stringify({ payload })}\n`;
    expect(Buffer.byteLength(frame, "utf8")).toBe(64 * 1024);

    await expect(writePtyControl(channel, { payload })).resolves.toBeUndefined();
    expect(channel.writes).toEqual([frame]);
  });

  it("cleans all listeners when explicitly stopped", () => {
    const channel = new PassThrough();
    const stop = readPtyControl(channel, vi.fn(), vi.fn());

    stop();

    expect(channel.listenerCount("data")).toBe(0);
    expect(channel.listenerCount("error")).toBe(0);
    expect(channel.listenerCount("end")).toBe(0);
  });
});
