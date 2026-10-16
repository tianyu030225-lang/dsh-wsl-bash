import type { Duplex } from "node:stream";

const MAX_CONTROL_BYTES = 64 * 1024;

/** A separate inherited channel: terminal output is never parsed as control. */
export function readPtyControl(
  channel: Duplex,
  receive: (message: Record<string, unknown>) => void,
  fail: (error: Error) => void,
): () => void {
  let pending = "";
  let stopped = false;
  const stop = (): void => {
    stopped = true;
    channel.off("data", onData);
    channel.off("error", onError);
    channel.off("end", onEnd);
  };
  const onError = (error: Error): void => {
    if (stopped) return;
    stopped = true;
    channel.off("data", onData);
    channel.off("end", onEnd);
    // Keep a sink for subsequent transport errors until the owner disposes us.
    fail(error);
  };
  const onEnd = (): void => {
    if (pending.length > 0) onError(new Error("Git Bash PTY control channel ended with an incomplete frame"));
  };
  const onData = (text: string): void => {
    if (stopped) return;
    try {
      pending += text;
      if (Buffer.byteLength(pending, "utf8") > MAX_CONTROL_BYTES) {
        throw new Error("Git Bash PTY control frame exceeded its size limit");
      }
      let newline: number;
      while (!stopped && (newline = pending.indexOf("\n")) >= 0) {
        const frame = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        const message: unknown = JSON.parse(frame);
        if (typeof message !== "object" || message === null || Array.isArray(message)) {
          throw new Error("Git Bash PTY control frame must be an object");
        }
        receive(message as Record<string, unknown>);
      }
    } catch (error) {
      onError(error instanceof Error ? error : new Error("Invalid Git Bash PTY control frame"));
    }
  };
  channel.setEncoding("utf8");
  channel.on("data", onData);
  channel.on("error", onError);
  channel.on("end", onEnd);
  return stop;
}

export function writePtyControl(channel: Duplex, message: object): Promise<void> {
  const frame = `${JSON.stringify(message)}\n`;
  if (Buffer.byteLength(frame, "utf8") > MAX_CONTROL_BYTES) {
    return Promise.reject(new Error("Git Bash PTY control frame exceeded its size limit"));
  }
  return new Promise((resolve, reject) => {
    channel.write(frame, "utf8", (error) => error ? reject(error) : resolve());
  });
}
