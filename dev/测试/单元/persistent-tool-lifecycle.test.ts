import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apply as applyCandidate } from "../../../src/tools/persistent.js";

type SessionStatus =
  | { kind: "running" }
  | { kind: "exited"; exitCode: number | null; signal: string | null };
type WaitReason = "stdin_read" | "inferred_idle" | "timeout";
type TerminalResult = {
  viewport: string;
  waitReason: WaitReason;
  sessionStatus: SessionStatus;
  truncated: boolean;
};
type RegisteredTool = {
  name: string;
  execute(args: unknown, exec: unknown): Promise<unknown>;
};
type FixtureMode =
  | "normal"
  | "poll"
  | "missing-end"
  | "malformed-end"
  | "foreign-end"
  | "cancel-frame"
  | "init-failure"
  | "natural-exit"
  | "serial"
  | "unload-creating"
  | "held-done-cancel"
  | "deadline-send-abort"
  | "deadline-done-reject"
  | "generic-send-error";

const require = createRequire(import.meta.url);
const HOST_ANCHOR = require.resolve("@deepseek-ai/dsh/package.json");
const WRONG_NAME_HOST_ANCHOR = require.resolve(
  "@deepseek-ai/dsh-tool-bash-persistent/package.json",
);
const CONFIG = {
  backendType: "wsl",
  timeoutMs: 100,
  maxOutputChars: 16_000,
  description: "lifecycle contract fixture",
};

function withDeadline<T>(promise: Promise<T>, milliseconds = 1_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bounded = Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`fixture deadline exceeded: ${milliseconds}ms`)), milliseconds);
    }),
  ]);
  return bounded.finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

function createUnsupportedVersionHostFixture() {
  const root = mkdtempSync(join(resolve("测试", "运行产物"), "persistent-lifecycle-host-"));
  const anchor = join(root, "node_modules", "@deepseek-ai", "dsh", "package.json");
  mkdirSync(dirname(anchor), { recursive: true });
  writeFileSync(anchor, JSON.stringify({ name: "@deepseek-ai/dsh", version: "9.9.9" }), "utf8");
  return { root, anchor };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function markerPair(text: string): { start: string; end: string } | undefined {
  const start = text.match(/(__DSH_PERSISTENT_BASH_START_[0-9a-f-]+__)/u)?.[1];
  if (start === undefined) return undefined;
  const nonce = start.slice("__DSH_PERSISTENT_BASH_START_".length, -2);
  return {
    start,
    end: `__DSH_PERSISTENT_BASH_END_${nonce}:`,
  };
}

function makeToolFixture(mode: FixtureMode) {
  type Session = {
    owner: Owner;
    sessionId: string;
    alive: boolean;
    status: SessionStatus;
    commandCalls: number;
    marker?: { start: string; end: string };
    latest: string;
  };
  type Owner = {
    name: string;
    session: { header: { cwd: string } };
    ctx: { effect: ReturnType<typeof vi.fn> };
  };

  const sessions = new Map<string, Session>();
  const pluginCleanups: Array<() => unknown> = [];
  const firstCommandStarted = deferred<void>();
  const cancelOperation = deferred<TerminalResult>();
  const heldCancelOperation = deferred<TerminalResult>();
  const ownerInFlight = new Map<Owner, number>();
  const ownerMaxInFlight = new Map<Owner, number>();
  const commandStarts: Array<{ owner: Owner; sessionId: string; text: string }> = [];
  const killCalls: Array<{ owner: Owner; sessionId: string; reason?: string }> = [];
  let nextSession = 0;
  let naturalExitConsumed = false;
  let heldCancelStarted = false;
  let heldCancelReleased = false;
  let heldCancelListenerActive = false;
  let registered: RegisteredTool | undefined;
  const workingDirectoryEnsure = vi.fn(async (owner: Owner) => owner.session.header.cwd);

  const makeOwner = (name: string): Owner => {
    const cleanups: Array<() => unknown> = [];
    const owner = {
      name,
      session: { header: { cwd: "C:\\fixture" } },
      ctx: {
        effect: vi.fn((factory: () => unknown) => {
          const cleanup = factory();
          if (typeof cleanup === "function") cleanups.push(cleanup as () => unknown);
          return vi.fn();
        }),
      },
    } as Owner;
    return owner;
  };

  const ownerA = makeOwner("owner-a");
  const ownerB = makeOwner("owner-b");

  const releaseHeldCancelOperation = (): void => {
    if (heldCancelReleased) return;
    heldCancelReleased = true;
    heldCancelOperation.resolve({
      viewport: "",
      waitReason: "inferred_idle",
      sessionStatus: { kind: "running" },
      truncated: false,
    });
  };

  const kill = vi.fn(async (owner: Owner, sessionId: string, reason?: string) => {
    killCalls.push({
      owner,
      sessionId,
      ...(reason === undefined ? {} : { reason }),
    });
    const session = sessions.get(sessionId);
    if (session !== undefined) {
      session.alive = false;
      session.status = { kind: "exited", exitCode: 0, signal: null };
    }
    if (mode === "held-done-cancel" && owner === ownerA) {
      releaseHeldCancelOperation();
    }
    return true;
  });

  const spawn = vi.fn(async (owner: Owner, _options: unknown, signal?: AbortSignal) => {
    if (mode === "unload-creating") {
      return await new Promise<{ sessionId: string }>((resolve, reject) => {
        const abort = (): void => {
          signal?.removeEventListener("abort", abort);
          reject(signal?.reason ?? new Error("fixture creation aborted"));
        };
        if (signal?.aborted) abort();
        else signal?.addEventListener("abort", abort, { once: true });
      });
    }
    if (signal?.aborted) throw signal.reason ?? new Error("fixture spawn aborted");
    nextSession += 1;
    const sessionId = `fixture-session-${nextSession}`;
    sessions.set(sessionId, {
      owner,
      sessionId,
      alive: true,
      status: { kind: "running" },
      commandCalls: 0,
      latest: "",
    });
    return { sessionId };
  });

  const list = vi.fn((owner: Owner) => [...sessions.values()]
    .filter((session) => session.owner === owner && session.alive)
    .map((session) => ({ sessionId: session.sessionId, status: session.status })));

  const read = vi.fn((_owner: Owner, sessionId: string) => {
    const session = sessions.get(sessionId);
    return {
      text: session?.latest ?? "",
      totalLines: session?.latest.length === 0 ? 0 : session?.latest.split("\n").length,
      lineBegin: 0,
      lineEnd: session?.latest.length === 0 ? 0 : session?.latest.split("\n").length,
      truncated: false,
    };
  });

  const settleWithOwnerDelay = async (owner: Owner, result: TerminalResult): Promise<TerminalResult> => {
    const current = (ownerInFlight.get(owner) ?? 0) + 1;
    ownerInFlight.set(owner, current);
    ownerMaxInFlight.set(owner, Math.max(ownerMaxInFlight.get(owner) ?? 0, current));
    if (mode === "serial") await new Promise((resolve) => setTimeout(resolve, 10));
    if (mode === "deadline-send-abort") {
      await new Promise((resolve) => setTimeout(resolve, 8));
    }
    ownerInFlight.set(owner, current - 1);
    return result;
  };

  const startSend = vi.fn((owner: Owner, sessionId: string, request: { text: string; signal?: AbortSignal }) => {
    const session = sessions.get(sessionId);
    expect(session).toBeDefined();
    if (session === undefined) throw new Error("unknown fixture session");
    if (session.owner !== owner) {
      const error = new Error("foreign fixture session");
      Object.assign(error, { code: "FOREIGN_SESSION" });
      throw error;
    }
    if (mode === "deadline-send-abort" && request.signal?.aborted) {
      throw new Error("WSL PTY send aborted before write");
    }
    if (request.text === "stty -echo; set +H") {
      if (mode === "init-failure") {
        session.status = { kind: "exited", exitCode: 1, signal: null };
        return {
          done: Promise.resolve<TerminalResult>({
            viewport: "init-failed",
            waitReason: "stdin_read",
            sessionStatus: session.status,
            truncated: false,
          }),
          readOutput: () => ({ delta: "", truncated: false }),
        };
      }
      return {
        done: Promise.resolve<TerminalResult>({
          viewport: "",
          waitReason: "stdin_read",
          sessionStatus: { kind: "running" },
          truncated: false,
        }),
        readOutput: () => ({ delta: "", truncated: false }),
      };
    }

    session.commandCalls += 1;
    commandStarts.push({ owner, sessionId, text: request.text });
    if (session.commandCalls === 1) firstCommandStarted.resolve();
    if (mode === "generic-send-error" && session.commandCalls === 1) {
      throw new Error("fixture generic send failure");
    }
    const requestPair = markerPair(request.text);
    const pair = request.text.length === 0 ? session.marker : requestPair;
    if (requestPair !== undefined) session.marker = requestPair;
    const activePair = session.marker;
    const payload = `output-${owner.name}-${session.commandCalls}\n`;
    const valid = activePair === undefined ? "" : `${activePair.start}\n${payload}${activePair.end}0\n`;
    const foreign = activePair === undefined
      ? ""
      : `${activePair.start}\n${payload}__DSH_PERSISTENT_BASH_END_foreign:0\n`;
    let delta = valid;
    let viewport = valid;
    let result: TerminalResult = {
      viewport,
      waitReason: "inferred_idle",
      sessionStatus: { kind: "running" },
      truncated: false,
    };

    if (mode === "poll" && session.commandCalls === 1) {
      delta = `${activePair?.start ?? ""}\n${payload}`;
      viewport = delta;
      result = { viewport, waitReason: "inferred_idle", sessionStatus: { kind: "running" }, truncated: false };
    } else if (mode === "missing-end") {
      delta = `${activePair?.start ?? ""}\n${payload}`;
      viewport = delta;
    } else if (mode === "malformed-end") {
      delta = `${activePair?.start ?? ""}\n${payload}${activePair?.end ?? "__DSH_PERSISTENT_BASH_END_missing:"}999\n`;
      viewport = delta;
    } else if (mode === "foreign-end") {
      delta = foreign;
      viewport = foreign;
    } else if (mode === "natural-exit" && !naturalExitConsumed) {
      naturalExitConsumed = true;
      session.status = { kind: "exited", exitCode: 7, signal: null };
      session.latest = "natural-output\n";
      delta = "natural-output\n";
      viewport = delta;
      result = { viewport, waitReason: "inferred_idle", sessionStatus: session.status, truncated: false };
    } else if (mode === "cancel-frame" && session.commandCalls === 1) {
      delta = valid;
      viewport = valid;
      result = {
        viewport,
        waitReason: "inferred_idle",
        sessionStatus: { kind: "running" },
        truncated: false,
      };
      return {
        done: cancelOperation.promise,
        readOutput: () => ({ delta, truncated: false }),
      };
    } else if (mode === "held-done-cancel"
      && owner === ownerA
      && !heldCancelStarted) {
      heldCancelStarted = true;
      heldCancelListenerActive = true;
      const onHeldCancel = (): void => {
        // The held operation stays pending until the owner terminal is killed.
      };
      const clearHeldCancelListener = (): void => {
        heldCancelListenerActive = false;
        request.signal?.removeEventListener("abort", onHeldCancel);
      };
      request.signal?.addEventListener("abort", onHeldCancel);
      const done = heldCancelOperation.promise.then(
        (value) => {
          clearHeldCancelListener();
          return value;
        },
        (error: unknown) => {
          clearHeldCancelListener();
          throw error;
        },
      );
      return {
        done,
        readOutput: () => ({ delta: valid, truncated: false }),
      };
    } else if (mode === "deadline-send-abort" && session.commandCalls === 1) {
      delta = `${activePair?.start ?? ""}\npartial-before-internal-timeout\n`;
      viewport = delta;
      result = {
        viewport,
        waitReason: "inferred_idle",
        sessionStatus: { kind: "running" },
        truncated: false,
      };
    } else if (mode === "deadline-done-reject" && session.commandCalls === 1) {
      session.latest = `${activePair?.start ?? ""}\npartial-before-done-abort\n`;
      const done = new Promise<TerminalResult>((_resolve, reject) => {
        const onAbort = (): void => {
          request.signal?.removeEventListener("abort", onAbort);
          reject(new Error("WSL PTY send aborted before write"));
        };
        if (request.signal?.aborted) onAbort();
        else request.signal?.addEventListener("abort", onAbort, { once: true });
      });
      return {
        done,
        readOutput: () => ({ delta: `${activePair?.start ?? ""}\npartial-before-done-abort\n`, truncated: false }),
      };
    }
    session.latest = viewport;
    const done = settleWithOwnerDelay(owner, result);
    return {
      done,
      readOutput: () => ({ delta, truncated: false }),
    };
  });

  const ctx = {
    profileContext: { installAnchor: HOST_ANCHOR },
    effect: vi.fn((factory: () => unknown) => {
      const cleanup = factory();
      if (typeof cleanup === "function") pluginCleanups.push(cleanup as () => unknown);
      return vi.fn();
    }),
    tools: {
      register: vi.fn((definition: RegisteredTool) => {
        registered = definition;
        return vi.fn();
      }),
    },
    terminals: { spawn, startSend, list, read, kill },
    workingDirectory: { ensure: workingDirectoryEnsure },
  };

  return {
    ctx,
    ownerA,
    ownerB,
    spawn,
    startSend,
    list,
    read,
    kill,
    killCalls,
    sessions,
    commandStarts,
    ownerMaxInFlight,
    workingDirectoryEnsure,
    pluginCleanups,
    firstCommandStarted,
    cancelOperation,
    releaseHeldCancelOperation,
    heldCancelState: () => ({
      started: heldCancelStarted,
      released: heldCancelReleased,
      listenerActive: heldCancelListenerActive,
    }),
    registered: () => registered,
    async unload(): Promise<void> {
      for (const cleanup of pluginCleanups) await cleanup();
    },
  };
}

async function applyFixture(fixture: ReturnType<typeof makeToolFixture>, config = CONFIG): Promise<RegisteredTool> {
  await (applyCandidate as unknown as (ctx: unknown, config: unknown) => Promise<void>)(fixture.ctx, config);
  const tool = fixture.registered();
  expect(tool?.name).toBe("bash");
  return tool!;
}

function callTool(tool: RegisteredTool, owner: unknown, command = "printf fixture", signal = new AbortController().signal) {
  return tool.execute(
    { command },
    {
      callId: "lifecycle-call",
      name: "bash",
      arguments: { command },
      signal,
      agent: owner,
      token: Symbol("tool-token"),
      deferContext: vi.fn(),
      concludeTurn: vi.fn(),
    },
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});
describe("persistent tool public lifecycle contract", () => {
  it("uses the real host deadline/output services and preserves the first nonce across empty polls", async () => {
    const fixture = makeToolFixture("poll");
    const tool = await applyFixture(fixture);
    const startedAt = performance.now();
    const result = await withDeadline(callTool(tool, fixture.ownerA));

    expect(result).toContain("output-owner-a");
    expect(result).toContain("[Command finished with exit code 0]");
    expect(performance.now() - startedAt).toBeLessThan(CONFIG.timeoutMs);
    expect(fixture.workingDirectoryEnsure).toHaveBeenCalledWith(
      fixture.ownerA,
      expect.any(AbortSignal),
    );
    expect(fixture.spawn.mock.calls[0]?.[1]).toEqual({
      type: "wsl",
      cwd: "C:\\fixture",
    });
    expect(fixture.startSend).toHaveBeenCalledTimes(3);
    expect(fixture.commandStarts[0]?.text).toMatch(/__DSH_PERSISTENT_BASH_START_[0-9a-f-]+__/u);
    expect(fixture.commandStarts[1]?.text).toBe("");
    expect(fixture.commandStarts[2]).toBeUndefined();
  });

  it.each([
    ["missing END", "missing-end"],
    ["malformed END status", "malformed-end"],
    ["foreign END nonce", "foreign-end"],
  ] as const)("never treats %s as success", async (_label, mode) => {
    const fixture = makeToolFixture(mode);
    const tool = await applyFixture(fixture, { ...CONFIG, timeoutMs: 25 });
    const result = await withDeadline(callTool(tool, fixture.ownerA));

    expect(result).toContain("[Command timed out or OOM]");
    expect(result).not.toContain("[Command finished with exit code 0]");
    expect(fixture.kill).toHaveBeenCalledTimes(1);
  });

  it("gives a real caller cancellation priority over an already available END frame", async () => {
    const fixture = makeToolFixture("cancel-frame");
    const tool = await applyFixture(fixture, { ...CONFIG, timeoutMs: 1_000 });
    const controller = new AbortController();
    const pending = callTool(tool, fixture.ownerA, "printf cancel", controller.signal);
    await withDeadline(fixture.firstCommandStarted.promise);
    controller.abort(new Error("fixture caller cancellation"));
    fixture.cancelOperation.resolve({
      viewport: "__DSH_PERSISTENT_BASH_END_foreign:0\n",
      waitReason: "inferred_idle",
      sessionStatus: { kind: "running" },
      truncated: false,
    });

    await expect(withDeadline(pending)).resolves.toBe("");
    expect(fixture.kill).toHaveBeenCalledTimes(1);
  });

  it("kills and resets before a held operation.done settles", async () => {
    const fixture = makeToolFixture("held-done-cancel");
    const tool = await applyFixture(fixture, { ...CONFIG, timeoutMs: 1_000 });
    const controller = new AbortController();
    const first = callTool(tool, fixture.ownerA, "printf held", controller.signal);
    await withDeadline(fixture.firstCommandStarted.promise);
    const queued = callTool(tool, fixture.ownerA, "printf queued");
    const foreign = callTool(tool, fixture.ownerB, "printf foreign");

    await expect(withDeadline(foreign)).resolves.toContain("output-owner-b");
    expect(fixture.killCalls.filter((call) => call.owner === fixture.ownerB)).toHaveLength(0);
    expect(fixture.list(fixture.ownerB)).toHaveLength(1);

    controller.abort(new Error("fixture held-operation cancellation"));
    // The operation.done promise is deliberately still held. A correct owner
    // cancellation path starts kill/reset before awaiting that promise.
    await Promise.resolve();
    await Promise.resolve();
    try {
      expect(fixture.killCalls.filter((call) => call.owner === fixture.ownerA)).toHaveLength(1);
      expect(fixture.heldCancelState()).toMatchObject({
        started: true,
        released: true,
        listenerActive: false,
      });
      await expect(withDeadline(first)).resolves.toBe("");
      await expect(withDeadline(queued)).resolves.toContain("output-owner-a");
      expect(fixture.list(fixture.ownerA)).toHaveLength(1);
    } finally {
      // A RED implementation can still be waiting on operation.done. Release
      // it here so the failure remains bounded and the fixture is reusable.
      fixture.releaseHeldCancelOperation();
      await withDeadline(first.catch(() => ""));
      await withDeadline(queued.catch(() => ""));
      await withDeadline(fixture.unload());
    }
    expect(fixture.list(fixture.ownerA)).toEqual([]);
    expect(fixture.list(fixture.ownerB)).toEqual([]);
  });

  it("classifies an internal deadline PTY abort as the canonical timeout", async () => {
    const fixture = makeToolFixture("deadline-send-abort");
    const tool = await applyFixture(fixture, { ...CONFIG, timeoutMs: 30 });
    const pending = callTool(tool, fixture.ownerA, "printf internal-timeout");
    try {
      const result = await withDeadline(pending, 500);
      expect(result).toContain(
        "Your command timed out after 0 seconds or experienced an OOM error.",
      );
      expect(result).toContain("[Command timed out or OOM]");
      expect(result).toContain("partial-before-internal-timeout");
      expect(result).toContain(
        "The persistent bash shell was reset; the next bash call starts from the workspace",
      );
      expect(result).not.toContain("WSL PTY send aborted before write");
    } finally {
      await withDeadline(fixture.unload());
    }
    expect(fixture.startSend).toHaveBeenCalledTimes(2);
    expect(fixture.commandStarts).toHaveLength(1);
    expect(fixture.kill).toHaveBeenCalledTimes(1);
    expect(fixture.list(fixture.ownerA)).toEqual([]);
  });

  it("does not misclassify a generic PTY send error as a timeout", async () => {
    const fixture = makeToolFixture("generic-send-error");
    const tool = await applyFixture(fixture, { ...CONFIG, timeoutMs: 30 });
    try {
      await expect(withDeadline(callTool(tool, fixture.ownerA, "printf generic-error")))
        .rejects.toThrow("fixture generic send failure");
    } finally {
      await withDeadline(fixture.unload());
    }
    expect(fixture.kill).toHaveBeenCalledTimes(1);
    expect(fixture.list(fixture.ownerA)).toEqual([]);
  });

  it("classifies an internal deadline operation.done rejection as the canonical timeout", async () => {
    const fixture = makeToolFixture("deadline-done-reject");
    const tool = await applyFixture(fixture, { ...CONFIG, timeoutMs: 30 });
    try {
      const result = await withDeadline(callTool(tool, fixture.ownerA, "printf done-timeout"), 500);
      expect(result).toContain(
        "Your command timed out after 0 seconds or experienced an OOM error.",
      );
      expect(result).toContain("[Command timed out or OOM]");
      expect(result).toContain("partial-before-done-abort");
      expect(result).toContain(
        "The persistent bash shell was reset; the next bash call starts from the workspace",
      );
    } finally {
      await withDeadline(fixture.unload());
    }
    expect(fixture.startSend).toHaveBeenCalledTimes(2);
    expect(fixture.commandStarts).toHaveLength(1);
    expect(fixture.kill).toHaveBeenCalledTimes(1);
    expect(fixture.list(fixture.ownerA)).toEqual([]);
  });

  it("reaps the session when initialization exits before accepting stty", async () => {
    const fixture = makeToolFixture("init-failure");
    const tool = await applyFixture(fixture);

    await expect(withDeadline(callTool(tool, fixture.ownerA))).rejects.toThrow(/initialization|accept|exited/i);
    expect(fixture.spawn).toHaveBeenCalledTimes(1);
    expect(fixture.kill).toHaveBeenCalledTimes(1);
    expect(fixture.list(fixture.ownerA)).toEqual([]);
  });

  it("reports natural shell exit, resets ownership, and starts a fresh session next time", async () => {
    const fixture = makeToolFixture("natural-exit");
    const tool = await applyFixture(fixture);
    const first = await withDeadline(callTool(tool, fixture.ownerA, "printf first"));
    const second = await withDeadline(callTool(tool, fixture.ownerA, "printf second"));

    expect(first).toContain("[shell exited: code 7]");
    expect(first).toContain("fresh current directory and environment");
    expect(second).toContain("[Command finished with exit code 0]");
    expect(fixture.spawn).toHaveBeenCalledTimes(2);
    expect(fixture.kill).toHaveBeenCalledTimes(1);
  });

  it("serializes one owner while allowing an independent owner session", async () => {
    const fixture = makeToolFixture("serial");
    const tool = await applyFixture(fixture);
    const [a1, a2, b1] = await withDeadline(Promise.all([
      callTool(tool, fixture.ownerA, "printf a1"),
      callTool(tool, fixture.ownerA, "printf a2"),
      callTool(tool, fixture.ownerB, "printf b1"),
    ]));

    expect(a1).toContain("output-owner-a");
    expect(a2).toContain("output-owner-a");
    expect(b1).toContain("output-owner-b");
    for (const result of [a1, a2, b1]) {
      expect(result).toContain("[Command finished with exit code 0]");
      expect(result).not.toContain("[Command timed out or OOM]");
      expect(result).not.toContain("The persistent bash shell was reset");
    }
    expect(fixture.ownerMaxInFlight.get(fixture.ownerA)).toBe(1);
    expect(fixture.ownerMaxInFlight.get(fixture.ownerB)).toBe(1);
    expect(fixture.spawn).toHaveBeenCalledTimes(2);
    const ownerASessionIds = fixture.commandStarts
      .filter((entry) => entry.owner === fixture.ownerA)
      .map((entry) => entry.sessionId);
    const ownerBSessionIds = fixture.commandStarts
      .filter((entry) => entry.owner === fixture.ownerB)
      .map((entry) => entry.sessionId);
    expect(ownerASessionIds).toHaveLength(2);
    expect(new Set(ownerASessionIds).size).toBe(1);
    expect(ownerBSessionIds).toHaveLength(1);
    expect(ownerBSessionIds[0]).not.toBe(ownerASessionIds[0]);
    const ownerAStartMarkers = fixture.commandStarts
      .filter((entry) => entry.owner === fixture.ownerA)
      .map((entry) => entry.text.match(/(__DSH_PERSISTENT_BASH_START_[0-9a-f-]+__)/u)?.[1]);
    expect(ownerAStartMarkers[0]).toBeDefined();
    expect(ownerAStartMarkers[1]).toBeDefined();
    expect(ownerAStartMarkers[0]).not.toBe(ownerAStartMarkers[1]);
    const ownerBSessionId = fixture.commandStarts.find((entry) => entry.owner === fixture.ownerB)?.sessionId;
    expect(ownerBSessionId).toBeDefined();
    // This is a fixture-side owner-fence control only. Production registry
    // ownership is qualified by the real CLI/Desktop integration matrix.
    await expect(
      Promise.resolve().then(() => fixture.ctx.terminals.startSend(
          fixture.ownerA,
          ownerBSessionId!,
          { text: "printf foreign", signal: new AbortController().signal },
        )),
    ).rejects.toMatchObject({ code: "FOREIGN_SESSION" });
  });

  it("unload waits for a shell still being created and leaves no owned session", async () => {
    const fixture = makeToolFixture("unload-creating");
    const tool = await applyFixture(fixture, { ...CONFIG, timeoutMs: 1_000 });
    const pending = callTool(tool, fixture.ownerA, "printf creating");
    await vi.waitFor(() => expect(fixture.spawn).toHaveBeenCalledTimes(1));

    await withDeadline(fixture.unload());
    await expect(withDeadline(pending)).rejects.toThrow(/disposed|aborted|creation/i);
    expect(fixture.list(fixture.ownerA)).toEqual([]);
  });

  it("unload closes an active session and prevents retained process ownership", async () => {
    const fixture = makeToolFixture("normal");
    const tool = await applyFixture(fixture);
    await withDeadline(callTool(tool, fixture.ownerA, "printf live"));
    expect(fixture.list(fixture.ownerA)).toHaveLength(1);

    await withDeadline(fixture.unload());
    expect(fixture.kill).toHaveBeenCalledTimes(1);
    expect(fixture.list(fixture.ownerA)).toEqual([]);
  });

  it("rejects malformed config, missing host, wrong-name host, and unsupported version before registration", async () => {
    const malformed = makeToolFixture("normal");
    await expect(
      (applyCandidate as unknown as (ctx: unknown, config: unknown) => Promise<void>)(
        malformed.ctx,
        { ...CONFIG, timeoutMs: 0 },
      ),
    ).rejects.toThrow(/invalid configuration/);
    expect(malformed.ctx.tools.register).not.toHaveBeenCalled();

    const missingHost = makeToolFixture("normal");
    await expect(
      (applyCandidate as unknown as (ctx: unknown, config: unknown) => Promise<void>)(
        { ...missingHost.ctx, profileContext: undefined },
        CONFIG,
      ),
    ).rejects.toThrow(/actual host installAnchor/);
    expect(missingHost.ctx.tools.register).not.toHaveBeenCalled();

    const wrongNameHost = makeToolFixture("normal");
    await expect(
      (applyCandidate as unknown as (ctx: unknown, config: unknown) => Promise<void>)(
        {
          ...wrongNameHost.ctx,
          profileContext: { installAnchor: WRONG_NAME_HOST_ANCHOR },
        },
        CONFIG,
      ),
    ).rejects.toThrow(/could not read the host DSH version|installAnchor/);
    expect(wrongNameHost.ctx.tools.register).not.toHaveBeenCalled();

    const unsupportedHost = makeToolFixture("normal");
    const unsupportedVersionFixture = createUnsupportedVersionHostFixture();
    try {
      await expect(
        (applyCandidate as unknown as (ctx: unknown, config: unknown) => Promise<void>)(
          {
            ...unsupportedHost.ctx,
            profileContext: { installAnchor: unsupportedVersionFixture.anchor },
          },
          CONFIG,
        ),
      ).rejects.toThrow(/supports DSH.*detected 9\.9\.9/);
      expect(unsupportedHost.ctx.tools.register).not.toHaveBeenCalled();
    } finally {
      rmSync(unsupportedVersionFixture.root, { recursive: true, force: true });
    }
  });
});
