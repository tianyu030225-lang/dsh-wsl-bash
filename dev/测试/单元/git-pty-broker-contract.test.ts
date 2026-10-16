import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Duplex, PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

const { createDshHostRequire } = vi.hoisted(() => ({
  createDshHostRequire: vi.fn(),
}));

vi.mock("../../../src/runtime.js", () => ({ createDshHostRequire }));

import { spawnGitBashPty } from "../../../src/git/pty.js";

type ControlPacket = Record<string, unknown>;

class ControlChannel extends Duplex {
  readonly outbound: ControlPacket[] = [];
  onPacket: ((packet: ControlPacket) => void) | undefined;

  constructor() {
    super({
      read: () => {},
      write: (chunk, _encoding, callback) => {
        const text = chunk.toString();
        for (const line of text.split("\n")) {
          if (line.length === 0) continue;
          const packet = JSON.parse(line) as ControlPacket;
          this.outbound.push(packet);
          this.onPacket?.(packet);
        }
        callback();
      },
    });
  }

  feed(packet: ControlPacket): void {
    this.push(`${JSON.stringify(packet)}\n`);
  }
}

interface FakeChild {
  readonly child: {
    stdin: Writable;
    stdout: PassThrough;
    stderr: PassThrough;
    control: ControlChannel;
    done: Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>;
    terminate: ReturnType<typeof vi.fn>;
    waitForExit: ReturnType<typeof vi.fn>;
  };
  readonly control: ControlChannel;
  readonly writes: string[];
  readonly resolveDone: (outcome: { exitCode: number | null; signal: NodeJS.Signals | null }) => void;
  readonly rejectDone: (reason?: unknown) => void;
}

const temporaryRoots: string[] = [];
const artifactRoot = resolve(process.cwd(), "测试", "运行产物");

function createFakeChild(autoReady: boolean): FakeChild {
  const control = new ControlChannel();
  const writes: string[] = [];
  const stdin = new Writable({
    write(chunk, _encoding, callback) {
      writes.push(chunk.toString());
      callback();
    },
  });
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let resolveDone!: (outcome: { exitCode: number | null; signal: NodeJS.Signals | null }) => void;
  let rejectDone!: (reason?: unknown) => void;
  const done = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  const terminate = vi.fn(() => {
    resolveDone({ exitCode: null, signal: "SIGTERM" });
  });
  const waitForExit = vi.fn(async () => true);
  control.onPacket = (packet) => {
    if (packet.kind === "start" && autoReady) {
      control.feed({ kind: "ready", pid: 4242 });
      return;
    }
    if (packet.id !== undefined) control.feed({ kind: "ack", id: packet.id });
  };
  return {
    child: { stdin, stdout, stderr, control, done, terminate, waitForExit },
    control,
    writes,
    resolveDone,
    rejectDone,
  };
}

async function createHarness(autoReady = true): Promise<{
  ctx: any;
  anchor: string;
  spawn: ReturnType<typeof vi.fn>;
  children: FakeChild[];
  hostRequire: { resolve: ReturnType<typeof vi.fn> };
}> {
  mkdirSync(artifactRoot, { recursive: true });
  const root = mkdtempSync(join(artifactRoot, "unit-git-pty-broker-"));
  temporaryRoots.push(root);
  const anchor = join(root, "host", "package.json");
  const localModule = join(root, "local.mjs");
  const win32Module = join(root, "win32.mjs");
  const runner = join(root, "runner.js");
  const nodePty = join(root, "node-pty.mjs");
  mkdirSync(dirname(anchor), { recursive: true });
  writeFileSync(anchor, JSON.stringify({ name: "@deepseek-ai/dsh", version: "0.2.1-alpha.1" }), "utf8");
  writeFileSync(localModule, "export class LocalSubprocessRuntime {}\n", "utf8");
  writeFileSync(
    win32Module,
    "export function loadWin32ProcessBindings() { return {}; }\nexport function probeCurrentTokenJobSupport() {}\n",
    "utf8",
  );
  writeFileSync(runner, "export {};\n", "utf8");
  writeFileSync(nodePty, "export {};\n", "utf8");
  const paths: Record<string, string> = {
    "@deepseek-ai/dsh-subprocess-local": localModule,
    "@deepseek-ai/dsh-subprocess-local/runner": runner,
    "@deepseek-ai/dsh-win32-process": win32Module,
    "node-pty": nodePty,
  };
  const hostRequire = {
    resolve: vi.fn((name: string) => {
      const path = paths[name];
      if (path === undefined) throw new Error(`missing host dependency: ${name}`);
      return path;
    }),
  };
  createDshHostRequire.mockReturnValue(hostRequire);
  const local = await import(pathToFileURL(localModule).href) as {
    LocalSubprocessRuntime: new () => Record<string, unknown>;
  };
  const provider = new local.LocalSubprocessRuntime() as any;
  const children: FakeChild[] = [];
  const spawn = vi.fn(() => {
    const fake = createFakeChild(autoReady);
    children.push(fake);
    return fake.child;
  });
  provider.spawn = spawn;
  return {
    ctx: {
      profileContext: { installAnchor: anchor },
      subprocess: provider,
    },
    anchor,
    spawn,
    children,
    hostRequire,
  };
}

function request(signal?: AbortSignal): any {
  return {
    argv: ["C:\\Program Files\\Git\\bin\\bash.exe", "--noprofile", "--norc", "-i"],
    cwd: "C:\\Users\\Alice\\work\\git-bash",
    env: { DSH_TEST: "broker", TERM: "dumb" },
    rows: 30,
    cols: 120,
    terminalType: "dumb",
    graceMs: 500,
    ...(signal === undefined ? {} : { signal }),
  };
}

afterEach(() => {
  createDshHostRequire.mockReset();
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe.skipIf(process.platform !== "win32")("native Git PTY broker contract", () => {
  it("uses the real host anchor and public managed spawn without spawnTerminal", async () => {
    const harness = await createHarness();
    const permission = vi.fn();
    const session = await spawnGitBashPty(harness.ctx, request(), permission);
    const spec = harness.spawn.mock.calls[0]?.[0];

    expect(harness.spawn).toHaveBeenCalledOnce();
    expect(spec.argv[0]).toBe(process.execPath);
    expect(spec.argv[1]).toMatch(/(?:^|[\\/])src[\\/]git[\\/]pty-helper\.js$/);
    expect(spec.argv[2]).toBe(harness.anchor);
    expect(spec.cwd).toBe("C:\\Users\\Alice\\work\\git-bash");
    expect(spec.env).toEqual({
      ELECTRON_RUN_AS_NODE: "1",
      NODE_OPTIONS: undefined,
      NODE_PATH: undefined,
    });
    expect(spec.stdio).toEqual({
      stdin: "pipe",
      stdout: "pipe",
      stderr: { maxBytes: 4_096 },
      control: "pipe",
    });
    expect(spec.graceMs).toBe(500);
    expect(session.pid).toBe(4242);
    expect(permission).toHaveBeenCalledTimes(3);

    await session.write("printf broker");
    expect(harness.children[0]?.writes).toEqual(["printf broker"]);
    await session.resize(80, 25);
    await expect(session.signalForeground("SIGINT")).resolves.toBe(4242);
    expect(harness.children[0]?.control.outbound.map((packet) => packet.kind)).toEqual([
      "start",
      "resize",
      "interrupt",
    ]);
    expect(await session.inspectForeground()).toEqual({ processGroupId: 4242, inputWaiting: false });

    await session.terminate();
    expect(harness.children[0]?.child.terminate).toHaveBeenCalledOnce();
    expect(harness.children[0]?.child.waitForExit).toHaveBeenCalled();
    await expect(session.done).resolves.toMatchObject({ exitCode: null, signal: "SIGTERM" });
  });

  it("rejects a non-local subprocess provider before the first Git spawn", async () => {
    const harness = await createHarness();
    const spawn = vi.fn();
    harness.ctx.subprocess = { spawn };

    await expect(spawnGitBashPty(harness.ctx, request(), vi.fn())).rejects.toThrow(/managed-Job/);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("fails closed on a missing host dependency with zero Git spawn", async () => {
    const harness = await createHarness();
    const originalResolve = harness.hostRequire.resolve.getMockImplementation()!;
    harness.hostRequire.resolve.mockImplementation((name: string) => {
      if (name === "@deepseek-ai/dsh-win32-process") throw new Error("missing host win32 package");
      return originalResolve(name);
    });

    await expect(spawnGitBashPty(harness.ctx, request(), vi.fn())).rejects.toThrow(/missing host win32/);
    expect(harness.spawn).not.toHaveBeenCalled();
  });

  it("preserves an upstream abort reason and cleans the owned child", async () => {
    const harness = await createHarness(false);
    const controller = new AbortController();
    const reason = new Error("upstream cancellation");
    const started = spawnGitBashPty(harness.ctx, request(controller.signal), vi.fn());
    await vi.waitFor(() => expect(harness.spawn).toHaveBeenCalledOnce());

    controller.abort(reason);

    await expect(started).rejects.toBe(reason);
    expect(harness.children[0]?.child.terminate).toHaveBeenCalledOnce();
    expect(harness.children[0]?.child.waitForExit).toHaveBeenCalled();
  });

  it("cleans the managed child when initialization times out", async () => {
    const harness = await createHarness(false);
    const started = spawnGitBashPty(harness.ctx, request(), vi.fn());
    await vi.waitFor(() => expect(harness.spawn).toHaveBeenCalledOnce());

    await expect(started).rejects.toThrow(/timed out/i);
    expect(harness.children[0]?.child.terminate).toHaveBeenCalledOnce();
    expect(harness.children[0]?.child.waitForExit).toHaveBeenCalled();
  }, 10_000);

  it("cleans up when the helper reports a malformed or unknown control packet", async () => {
    const harness = await createHarness(false);
    const started = spawnGitBashPty(harness.ctx, request(), vi.fn());
    await vi.waitFor(() => expect(harness.spawn).toHaveBeenCalledOnce());
    const child = harness.children[0]!;

    child.control.push("{not-json}\n");

    await expect(started).rejects.toThrow();
    expect(child.child.terminate).toHaveBeenCalledOnce();
    expect(child.child.waitForExit).toHaveBeenCalled();
  });

  it.each([
    ["zero PID", [{ kind: "ready", pid: 0 }]],
    ["non-integer PID", [{ kind: "ready", pid: 1.5 }]],
    ["duplicate ready", [{ kind: "ready", pid: 4242 }, { kind: "ready", pid: 4343 }]],
  ])("rejects %s readiness and cleans the child", async (_label, packets) => {
    const harness = await createHarness(false);
    const child = createFakeChild(false);
    child.control.onPacket = (packet) => {
      if (packet.kind === "start") {
        for (const response of packets) child.control.feed(response);
      }
    };
    harness.spawn.mockImplementationOnce(() => {
      harness.children.push(child);
      return child.child;
    });

    await expect(spawnGitBashPty(harness.ctx, request(), vi.fn())).rejects.toThrow();
    expect(child.child.terminate).toHaveBeenCalledOnce();
    expect(child.child.waitForExit).toHaveBeenCalled();
  });

  it.each([
    ["unknown acknowledgement", { kind: "ack", id: 999 }, "ack"],
    ["malformed exit", { kind: "exit", exitCode: "not-a-number" }, "exit"],
  ])("rejects %s and settles the pending lifecycle", async (_label, packet, kind) => {
    const harness = await createHarness(false);
    const child = createFakeChild(false);
    child.control.onPacket = (outbound) => {
      if (outbound.kind === "start") child.control.feed({ kind: "ready", pid: 4242 });
    };
    harness.spawn.mockImplementationOnce(() => {
      harness.children.push(child);
      return child.child;
    });
    const session = await spawnGitBashPty(harness.ctx, request(), vi.fn());

    if (kind === "ack") {
      const resize = session.resize(80, 25);
      await new Promise<void>((resolve) => setImmediate(resolve));
      child.control.feed(packet);
      await expect(resize).rejects.toThrow(/acknowledgement|closing/i);
    } else {
      child.control.feed(packet);
      await expect(session.done).rejects.toThrow(/exit|closing/i);
    }
    expect(child.child.terminate).toHaveBeenCalledOnce();
    expect(child.child.waitForExit).toHaveBeenCalled();
  });

  it("rejects a managed child done failure and still requests termination", async () => {
    const harness = await createHarness(false);
    const child = createFakeChild(false);
    child.control.onPacket = (packet) => {
      if (packet.kind === "start") child.control.feed({ kind: "ready", pid: 4242 });
    };
    harness.spawn.mockImplementationOnce(() => {
      harness.children.push(child);
      return child.child;
    });
    const session = await spawnGitBashPty(harness.ctx, request(), vi.fn());

    child.rejectDone(new Error("managed helper failed"));

    await expect(session.done).rejects.toThrow(/managed helper failed|subprocess failed/i);
    expect(child.child.terminate).toHaveBeenCalledOnce();
    expect(child.child.waitForExit).toHaveBeenCalled();
  });

  it("retains an exit packet delivered after waitForExit quiesces", async () => {
    const harness = await createHarness(false);
    const child = createFakeChild(false);
    child.control.onPacket = (packet) => {
      if (packet.kind === "start") child.control.feed({ kind: "ready", pid: 4242 });
    };
    harness.spawn.mockImplementationOnce(() => {
      harness.children.push(child);
      return child.child;
    });
    const session = await spawnGitBashPty(harness.ctx, request(), vi.fn());
    let releaseWaitForExit!: (value: boolean) => void;
    child.child.waitForExit.mockImplementationOnce(
      () => new Promise<boolean>((resolve) => { releaseWaitForExit = resolve; }),
    );

    const done = session.done;
    child.resolveDone({ exitCode: 17, signal: null });
    await vi.waitFor(() => expect(child.child.waitForExit).toHaveBeenCalledOnce());
    releaseWaitForExit(true);
    await new Promise<void>((resolve) => setImmediate(resolve));
    child.control.feed({ kind: "exit", exitCode: 17 });
    child.control.push(null);

    await expect(done).resolves.toMatchObject({ exitCode: 17, signal: null });
    expect(child.child.waitForExit).toHaveBeenCalledOnce();
  });

  it("bounds a helper exit with no exit packet or control EOF", async () => {
    vi.useFakeTimers();
    try {
      const graceMs = 25;
      const harness = await createHarness(false);
      const child = createFakeChild(false);
      child.control.onPacket = (packet) => {
        if (packet.kind === "start") child.control.feed({ kind: "ready", pid: 4242 });
      };
      harness.spawn.mockImplementationOnce(() => {
        harness.children.push(child);
        return child.child;
      });
      const session = await spawnGitBashPty(harness.ctx, { ...request(), graceMs }, vi.fn());
      const done = session.done;

      child.resolveDone({ exitCode: 0, signal: null });
      await Promise.resolve();
      await Promise.resolve();
      const rejection = expect(done).rejects.toThrow(/without a shell outcome/i);
      await vi.advanceTimersByTimeAsync(graceMs);
      await rejection;

      expect(vi.getTimerCount()).toBe(0);
      expect(child.control.listenerCount("data")).toBe(0);
      expect(child.control.listenerCount("error")).toBe(0);
      expect(child.control.listenerCount("end")).toBe(0);
      expect(child.child.stdin.listenerCount("error")).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a malformed exit packet that arrives after waitForExit quiesces", async () => {
    const harness = await createHarness(false);
    const child = createFakeChild(false);
    child.control.onPacket = (packet) => {
      if (packet.kind === "start") child.control.feed({ kind: "ready", pid: 4242 });
    };
    harness.spawn.mockImplementationOnce(() => {
      harness.children.push(child);
      return child.child;
    });
    const session = await spawnGitBashPty(harness.ctx, request(), vi.fn());
    const done = session.done;

    child.resolveDone({ exitCode: 17, signal: null });
    await vi.waitFor(() => expect(child.child.waitForExit).toHaveBeenCalledOnce());
    await new Promise<void>((resolve) => setImmediate(resolve));
    child.control.feed({ kind: "exit", exitCode: "late-invalid" });

    await expect(done).rejects.toThrow(/Invalid Git Bash PTY exit packet/i);
    expect(child.child.terminate).toHaveBeenCalledOnce();
    expect(child.control.listenerCount("data")).toBe(0);
    expect(child.control.listenerCount("error")).toBe(0);
  });

  it("rejects a natural helper exit that never publishes an exit packet", async () => {
    const harness = await createHarness(false);
    const child = createFakeChild(false);
    child.control.onPacket = (packet) => {
      if (packet.kind === "start") child.control.feed({ kind: "ready", pid: 4242 });
    };
    harness.spawn.mockImplementationOnce(() => {
      harness.children.push(child);
      return child.child;
    });
    const session = await spawnGitBashPty(harness.ctx, request(), vi.fn());
    const done = session.done;

    child.resolveDone({ exitCode: 0, signal: null });
    child.control.push(null);

    await expect(done).rejects.toThrow(/without a shell outcome/i);
    expect(child.child.waitForExit).toHaveBeenCalledOnce();
  });

  it("rejects control EOF during startup and cleans the child", async () => {
    const harness = await createHarness(false);
    const child = createFakeChild(false);
    harness.spawn.mockImplementationOnce(() => {
      harness.children.push(child);
      return child.child;
    });
    const started = spawnGitBashPty(harness.ctx, request(), vi.fn());
    await vi.waitFor(() => expect(harness.spawn).toHaveBeenCalledOnce());

    child.control.push(null);

    await expect(started).rejects.toThrow(/control channel ended|closing/i);
    expect(child.child.terminate).toHaveBeenCalledOnce();
    expect(child.child.waitForExit).toHaveBeenCalled();
  });

  it.each(["control", "stdout", "stdin"] as const)(
    "rejects a child missing its required %s stream",
    async (missing) => {
      const harness = await createHarness();
      const child = createFakeChild(true);
      (child.child as Record<string, unknown>)[missing] = undefined;
      harness.spawn.mockImplementationOnce(() => {
        harness.children.push(child);
        return child.child;
      });

      await expect(spawnGitBashPty(harness.ctx, request(), vi.fn())).rejects.toThrow(/required pipes/);
      expect(child.child.terminate).toHaveBeenCalledOnce();
      expect(child.child.waitForExit).toHaveBeenCalled();
    },
  );

  it("treats input transport errors as a failed lifecycle and tears down the Job", async () => {
    const harness = await createHarness();
    const session = await spawnGitBashPty(harness.ctx, request(), vi.fn());
    const child = harness.children[0]!;
    const inputError = new Error("stdin transport failed");

    child.child.stdin.emit("error", inputError);

    await expect(session.done).rejects.toBe(inputError);
    expect(child.child.terminate).toHaveBeenCalledOnce();
    expect(child.child.waitForExit).toHaveBeenCalled();
  });

  it("rejects unsupported signals without pretending they were delivered", async () => {
    const harness = await createHarness();
    const session = await spawnGitBashPty(harness.ctx, request(), vi.fn());
    const child = harness.children[0]!;

    await expect(session.signalForeground("SIGKILL")).rejects.toThrow(/unsupported/);
    expect(child.control.outbound.map((packet) => packet.kind)).toEqual(["start"]);
    await session.terminate();
  });
});
