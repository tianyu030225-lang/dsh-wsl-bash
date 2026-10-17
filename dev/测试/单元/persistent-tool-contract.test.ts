import { Buffer } from "node:buffer";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
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
type FixtureMode = "normal" | "segmented" | "prefix" | "large" | "fallback" | "deadline" | "truncated";

const START_MARKER = "__DSH_PERSISTENT_BASH_START_";
const END_MARKER = "__DSH_PERSISTENT_BASH_END_";
const HOST_ANCHOR = createRequire(import.meta.url).resolve(
  "@deepseek-ai/dsh/package.json",
);

async function loadOfficialApply(): Promise<
  (ctx: unknown, config: unknown) => void
> {
  const packagePath = createRequire(import.meta.url).resolve(
    "@deepseek-ai/dsh-tool-bash-persistent",
  );
  const official = await import(pathToFileURL(packagePath).href) as {
    apply: (ctx: unknown, config: unknown) => void;
  };
  return official.apply;
}

function makeToolFixture(mode: FixtureMode) {
  const owner = {
    session: { header: { cwd: "C:\\fixture" } },
    ctx: { effect: vi.fn(() => vi.fn()) },
  };
  const sessionId = `fixture-session-${mode}`;
  const effects: unknown[] = [];
  let alive = true;
  let commandCalls = 0;
  let firstStart = "";
  let firstEnd = "";
  let firstPayload = "";
  const kill = vi.fn(async () => {
    alive = false;
    return true;
  });
  const startSend = vi.fn((
    _owner: unknown,
    _id: string,
    request: { text: string; signal: AbortSignal },
  ) => {
    if (request.text === "stty -echo") {
      return {
        done: Promise.resolve<TerminalResult>({
          viewport: "",
          waitReason: "stdin_read",
          sessionStatus: { kind: "running" },
          truncated: false,
        }),
        readOutput: () => ({ delta: "", truncated: false }),
        cancel: () => false,
      };
    }

    commandCalls += 1;
    const parsedStart = request.text.match(
      /(__DSH_PERSISTENT_BASH_START_[0-9a-f-]+__)/u,
    )?.[1];
    if (parsedStart === undefined) expect(request.text).toBe("");
    const start = parsedStart ?? (firstStart || undefined);
    expect(start).toBeDefined();
    const nonce = start!.slice(START_MARKER.length, -2);
    const end = `${END_MARKER}${nonce}:`;
    if (commandCalls === 1) {
      firstStart = start!;
      firstEnd = end;
    }

    const payload = mode === "large" || mode === "fallback"
      ? `${"😀✓".repeat(180_000)}\n`
      : mode === "prefix"
        ? "prefix-before-empty-viewport\n"
        : "fixture-output-✓\n";
    if (commandCalls === 1) firstPayload = payload;
    const full = mode === "large"
      ? `${start}\n${payload}${end}0\n${"noise-✓\n".repeat(80_000)}`
      : `${start}\n${payload}${end}0\n`;
    let delta: string;
    let viewport = full;
    if (mode === "segmented" || mode === "prefix") {
      delta = commandCalls === 1
        ? `${start}\n${payload}`
        : mode === "prefix"
          ? commandCalls === 2
            ? ""
            : commandCalls === 3
              ? `${end}0\n`
              : ""
          : commandCalls === 2
            ? `${end}0\n`
            : "";
      if (mode === "prefix" && commandCalls === 2) viewport = "background-tail\n".repeat(1000);
    } else if (mode === "fallback") {
      delta = commandCalls === 1
        ? `${start}\n${payload}`
        : commandCalls === 2
          ? `${end}0\n`
          : "";
      viewport = "background-tail\n".repeat(1000);
    } else {
      delta = full;
    }

    if (mode === "deadline") {
      let settle!: (result: TerminalResult) => void;
      let settled = false;
      const done = new Promise<TerminalResult>((resolve) => { settle = resolve; });
      const onAbort = (): void => {
        if (settled) return;
        settled = true;
        request.signal.removeEventListener("abort", onAbort);
        settle({
          viewport: full,
          waitReason: "timeout",
          sessionStatus: { kind: "running" },
          truncated: false,
        });
      };
      if (request.signal.aborted) onAbort();
      else request.signal.addEventListener("abort", onAbort, { once: true });
      return {
        done,
        readOutput: () => ({ delta, truncated: false }),
        cancel: () => false,
      };
    }

    return {
      done: Promise.resolve<TerminalResult>({
        viewport,
        waitReason: "inferred_idle",
        sessionStatus: { kind: "running" },
          truncated: mode === "truncated",
      }),
        readOutput: () => ({ delta, truncated: mode === "truncated" }),
      cancel: () => false,
    };
  });
  const latest = {
    text: "latest-background\n".repeat(1000),
    totalLines: 1000,
    lineBegin: 0,
    lineEnd: 1000,
      truncated: mode === "truncated",
  };
  let registered: RegisteredTool | undefined;
  const contextEffect = vi.fn((factory: () => unknown) => {
    effects.push(factory());
    return vi.fn();
  });
  const ctx = {
    profileContext: { installAnchor: HOST_ANCHOR },
    effect: contextEffect,
    tools: {
      register: vi.fn((definition: RegisteredTool) => {
        registered = definition;
        return vi.fn();
      }),
    },
    terminals: {
      spawn: vi.fn(async () => ({ sessionId })),
      startSend,
      list: vi.fn(() => alive ? [{ sessionId, status: { kind: "running" } }] : []),
      read: vi.fn(() => latest),
      kill,
    },
  };
  return {
    ctx,
    owner,
    effects,
    registered: () => registered,
    kill,
    startSend,
    latest,
    getMarkers: () => ({ start: firstStart, end: firstEnd, payload: firstPayload }),
  };
}

async function executeFixture(
  fixture: ReturnType<typeof makeToolFixture>,
  callId: string,
  command = "printf 'fixture'",
): Promise<unknown> {
  const tool = fixture.registered();
  expect(tool?.name).toBe("bash");
  return tool!.execute(
      { command },
    {
      callId,
      name: "bash",
        arguments: { command },
      signal: new AbortController().signal,
      agent: fixture.owner,
      token: Symbol("tool-token"),
      deferContext: vi.fn(),
      concludeTurn: vi.fn(),
    },
  );
}

const CONFIG = {
  backendType: "wsl",
  timeoutMs: 75,
  maxOutputChars: 16_000,
  description: "test persistent bash tool",
};

describe("persistent bash tool completion and deadline contracts", () => {
  it("encodes terminal control bytes before sending the interactive wrapper", async () => {
    const fixture = makeToolFixture("normal");
    await applyCandidate(fixture.ctx as any, CONFIG);
    await executeFixture(fixture, "control-bytes", "printf '<%s>' $'a\tb\x1bc\x7f'");

    const request = fixture.startSend.mock.calls
      .map(([, , value]) => value as { text: string })
      .find((value) => value.text !== "stty -echo");
    expect(request).toBeDefined();
    expect(request?.text).not.toContain("\t");
    expect(request?.text).not.toContain("\x1b");
    expect(request?.text).not.toContain("\x7f");
    expect(request?.text).toContain("\\t");
    expect(request?.text).toContain("\\x1b");
    expect(request?.text).toContain("\\x7f");
  });

  it("rejects NUL before creating a persistent shell", async () => {
    const fixture = makeToolFixture("normal");
    await applyCandidate(fixture.ctx as any, CONFIG);
    await expect(executeFixture(fixture, "nul", "printf 'bad\0command'")).rejects.toThrow(/NUL/);
    expect(fixture.ctx.terminals.spawn).not.toHaveBeenCalled();
  });

  it("marks a command capture incomplete when every source reports a gap", async () => {
    const fixture = makeToolFixture("truncated");
    await applyCandidate(fixture.ctx as any, CONFIG);
    const output = await executeFixture(fixture, "truncated-output");
    expect(String(output)).toContain("The beginning of this command output was dropped");
  });

  it("candidate resolves a normal inferred_idle operation from incremental END", async () => {
    const fixture = makeToolFixture("normal");
    await (applyCandidate as unknown as (ctx: unknown, config: unknown) => Promise<void>)
      (fixture.ctx, CONFIG);
    const result = await executeFixture(fixture, "candidate-normal");

    expect(result).toContain("fixture-output-✓");
    expect(result).toContain("[Command finished with exit code 0]");
    expect(fixture.kill).not.toHaveBeenCalled();
    expect(fixture.startSend).toHaveBeenCalledTimes(2);
    expect(fixture.latest.text).not.toContain(END_MARKER);
  });

  it("candidate keeps a START/prefix across empty-viewport and final END frames", async () => {
    const fixture = makeToolFixture("prefix");
    await (applyCandidate as unknown as (ctx: unknown, config: unknown) => Promise<void>)
      (fixture.ctx, CONFIG);
    const result = await executeFixture(fixture, "candidate-prefix");

    expect(result).toContain("prefix-before-empty-viewport");
    expect(result).toContain("[Command finished with exit code 0]");
    expect(fixture.kill).not.toHaveBeenCalled();
    expect(fixture.startSend).toHaveBeenCalledTimes(4);
  });

  it("candidate completes segmented START and END output while preserving bounded UTF-8 text", async () => {
    const fixture = makeToolFixture("segmented");
    await (applyCandidate as unknown as (ctx: unknown, config: unknown) => Promise<void>)
      (fixture.ctx, { ...CONFIG, maxOutputChars: 64 });
    const result = await executeFixture(fixture, "candidate-segmented");

    expect(result).toContain("fixture-output-✓");
    expect(result).toContain("[Command finished with exit code 0]");
    expect(result).not.toContain("�");
    expect(fixture.kill).not.toHaveBeenCalled();
    expect(fixture.startSend).toHaveBeenCalledTimes(3);
  });

  it("candidate keeps a valid current incremental END after the bounded fallback loses it to noise", async () => {
    const fixture = makeToolFixture("large");
    await (applyCandidate as unknown as (ctx: unknown, config: unknown) => Promise<void>)
      (fixture.ctx, { ...CONFIG, maxOutputChars: 128 });
    const result = await executeFixture(fixture, "candidate-large");

    expect(result).toContain("[Command finished with exit code 0]");
    expect(result).toContain("<response clipped>");
    expect(result).not.toContain("�");
    expect(fixture.kill).not.toHaveBeenCalled();
    expect(fixture.startSend).toHaveBeenCalledTimes(2);
  });

  it("candidate exposes a bounded, valid UTF-8 fallback when START is older than the byte cap", async () => {
    const fixture = makeToolFixture("fallback");
    await (applyCandidate as unknown as (ctx: unknown, config: unknown) => Promise<void>)
      (fixture.ctx, { ...CONFIG, maxOutputChars: 300_000 });
    const result = await executeFixture(fixture, "candidate-fallback");
    const text = String(result);
    const retained = text.split("earliest retained output.</NOTE>\n")[1]?.split("<response clipped>")[0];

    expect(text).toMatch(/beginning of this command output was dropped/i);
    expect(text).toContain("<response clipped>");
    expect(text).toContain("[Command finished with exit code 0]");
    expect(text).not.toContain("�");
    expect(retained).toBeDefined();
    expect(Buffer.byteLength(retained!)).toBeLessThanOrEqual(262_144);
    expect(Buffer.byteLength(retained!)).toBeGreaterThan(100_000);
    expect(fixture.kill).not.toHaveBeenCalled();
    expect(fixture.startSend).toHaveBeenCalledTimes(3);
  });

  it("candidate gives timeout priority when END becomes observable only after the deadline", async () => {
    const fixture = makeToolFixture("deadline");
    await (applyCandidate as unknown as (ctx: unknown, config: unknown) => Promise<void>)
      (fixture.ctx, { ...CONFIG, timeoutMs: 10 });
    const result = await executeFixture(fixture, "candidate-deadline");

    expect(result).toContain("[Command timed out or OOM]");
    expect(fixture.kill).toHaveBeenCalledTimes(1);
  });

  it("records the official package latest-only behavior as a known baseline, not a candidate failure", async () => {
    const fixture = makeToolFixture("normal");
    const apply = await loadOfficialApply();
    apply(fixture.ctx, CONFIG);
    const result = await executeFixture(fixture, "official-known-baseline");

    expect(result).toContain("[Command timed out or OOM]");
    expect(fixture.kill).toHaveBeenCalledTimes(1);
    console.info(
      "KNOWN_BASELINE official persistent package ignores valid operation incremental END and resets after latest-only timeout",
    );
  });

  it("fails closed before registration when the host installAnchor is missing", async () => {
    const fixture = makeToolFixture("normal");
    const register = fixture.ctx.tools.register;
    const ctx = { ...fixture.ctx, profileContext: undefined };

    await expect(
      (applyCandidate as unknown as (ctx: unknown, config: unknown) => Promise<void>)(ctx, CONFIG),
    ).rejects.toThrow(/actual host installAnchor/);
    expect(register).not.toHaveBeenCalled();
  });
});
