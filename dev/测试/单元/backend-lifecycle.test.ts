import { PassThrough, Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { Context } from "@deepseek-ai/cordis";
import type {
  SubprocessHandle,
  SubprocessSpawnSpec,
} from "@deepseek-ai/dsh-subprocess";
import type {
  TerminalBackendSession,
  TerminalBackendSpawnSpec,
} from "@deepseek-ai/dsh-terminal";

import { resolveConfig } from "../../../src/config.js";
import {
  registerWslTerminalBackend,
  WslTerminalBackend,
} from "../../../src/wsl/backend.js";
import {
  WslPtySession,
  type WslPtyTransport,
} from "../../../src/terminal/session.js";

interface TestHandle {
  readonly handle: SubprocessHandle;
  readonly finish: () => void;
  readonly writes: string[];
}

function terminalHandle(): TestHandle {
  let finish!: () => void;
  const done = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    finish = () => resolve({ exitCode: null, signal: "SIGTERM" });
  });
 const stdin = new PassThrough();
 const stdout = new PassThrough();
  const writes: string[] = [];
  const prompt = "\u001b]133;D;0\u0007__DSH_PERSISTENT_BASH_PROMPT__ ";
  // The first prompt represents the shell becoming interactive. Every later
  // write represents a completed command, including the internal readonly
  // PROMPT_COMMAND guard installed by WslPtySession.initialize.
  setImmediate(() => stdout.write(prompt));
  stdin.on("data", (chunk) => {
    writes.push(chunk.toString());
    setImmediate(() => stdout.write(prompt));
  });
 return {
   handle: {
    stdin,
    stdout,
    stderr: Readable.from([]),
    control: undefined,
      collected: {},
      done,
      terminate: vi.fn(() => {
        finish();
        stdout.end();
      }),
      waitForExit: vi.fn(async () => true),
    },
   finish,
    writes,
 };
}

function exitedHandle(): SubprocessHandle {
  return {
    stdin: new PassThrough(),
    stdout: Readable.from([]),
    stderr: Readable.from([]),
    control: undefined,
    collected: {},
    done: Promise.resolve({ exitCode: 0, signal: null }),
    terminate: vi.fn(),
    waitForExit: vi.fn(async () => true),
  };
}

function canonicalizationHandle(spec: SubprocessSpawnSpec): SubprocessHandle {
  const path = spec.argv.at(-1) ?? "/mnt/c/Users/Alice/work/dsh_bash";
  const reader = (text: string) => ({
    readFrom: () => ({
      text,
      nextOffset: Buffer.byteLength(text),
      lossy: false,
    }),
  });
  return {
    stdin: new PassThrough(),
    stdout: Readable.from([`${path}\n`]),
    stderr: Readable.from([]),
    control: undefined,
    collected: {
      stdout: reader(`${path}\n`),
      stderr: reader(""),
    },
    done: Promise.resolve({ exitCode: 0, signal: null }),
    terminate: vi.fn(),
    waitForExit: vi.fn(async () => true),
  };
}

function controlledPrompt(): string {
  return "\u001b]133;D;0\u0007__DSH_PERSISTENT_BASH_PROMPT__ ";
}

function backendContext(spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle): {
  context: Context;
  spawnTerminal: ReturnType<typeof vi.fn>;
} {
  const spawnTerminal = vi.fn(async () => {
    throw new Error("spawnTerminal must not be called by the WSL backend");
  });
  return {
    context: {
      subprocess: {
        // Windows production code canonicalizes the mapped root and cwd with
        // two read-only WSL realpath probes before creating the terminal.
        // Keep those probes explicit in the fake seam so the lifecycle tests
        // assert terminal allocation rather than depending on host filesystem.
        spawn: (spec: SubprocessSpawnSpec) =>
          spec.argv.includes("/usr/bin/realpath") ? canonicalizationHandle(spec) : spawn(spec),
        spawnTerminal,
      },
      terminals: { registerBackend: vi.fn() },
      sandboxPolicy: {
        resolve: vi.fn(() => ({
          mode: "workspace-write",
          workspaceRoot: "C:\\Users\\Alice\\work\\dsh_bash",
        })),
      },
    } as unknown as Context,
    spawnTerminal,
  };
}

const spawnSpec = (owner: unknown): TerminalBackendSpawnSpec => ({
  type: "wsl",
  sessionId: "session-1" as TerminalBackendSpawnSpec["sessionId"],
  owner: owner as TerminalBackendSpawnSpec["owner"],
  cwd: "C:\\Users\\Alice\\work\\dsh_bash\\目录 with spaces",
  name: "agent-a-shell",
});

describe("persistent WSL backend lifecycle", () => {
  const testConfig = resolveConfig({
    pollIntervalMs: 1,
    idleSilenceMs: 1,
    timeoutMs: 1_000,
  });

  it("registers exactly one WSL backend and preserves the pwsh seam", () => {
    const registerBackend = vi.fn();
    const ctx = {
      terminals: { registerBackend },
    } as unknown as Context;

    registerWslTerminalBackend(ctx, resolveConfig());

    expect(registerBackend).toHaveBeenCalledTimes(1);
    const backend = registerBackend.mock.calls[0]?.[0] as WslTerminalBackend;
    expect(backend).toBeInstanceOf(WslTerminalBackend);
    expect(backend.type).toBe("wsl");
    // The plugin only contributes a backend; it must not replace a host pwsh backend.
    expect(registerBackend.mock.calls[0]?.[0]).not.toHaveProperty("type", "pwsh");
  });

  it("starts a clean WSL session with policy-owned cwd and tears it down", async () => {
    const allocated = terminalHandle();
    const spawn = vi.fn((spec: SubprocessSpawnSpec) => {
      expect(spec.argv).toContain("/bin/bash");
      expect(spec.argv).toContain("--noprofile");
      expect(spec.argv).toContain("--norc");
      expect(spec.argv).toContain("-i");
      expect(spec.argv).toContain("--setenv");
      expect(spec.argv).toContain("PROMPT_COMMAND");
      expect(spec.argv).toContain("TERM");
      expect(spec.argv.some((arg) => arg.includes("/usr/bin/env"))).toBe(true);
      if (process.platform === "win32") {
        expect(spec.cwd).toContain("C:\\Users\\Alice\\work\\dsh_bash");
      } else {
        expect(spec.cwd).toContain("/mnt/c/");
      }
      expect(spec.cwd).toContain("目录 with spaces");
      expect(spec.cwd).not.toContain("outside");
      expect(spec.stdio).toEqual({ stdin: "pipe", stdout: "pipe", stderr: "pipe" });
      return allocated.handle;
    });
    const backendContextResult = backendContext(spawn);
    const backend = new WslTerminalBackend(backendContextResult.context, testConfig);

    const session = await backend.spawn(spawnSpec({ id: "agent-a" })) as unknown as TerminalBackendSession;
    expect(allocated.writes.some((write) => write.includes("stty rows 40 cols 160; readonly PROMPT_COMMAND"))).toBe(true);
    await session.close("test cleanup");
    expect(allocated.handle.terminate).toHaveBeenCalledTimes(1);
    expect(backendContextResult.spawnTerminal).not.toHaveBeenCalled();
  });

  it("rejects a transport that exits cleanly before the first prompt", async () => {
    const handle = exitedHandle();
    const spawn = vi.fn(() => handle);
    const backendContextResult = backendContext(spawn);
    const backend = new WslTerminalBackend(backendContextResult.context, testConfig);

    await expect(backend.spawn(spawnSpec({ id: "agent-a" }))).rejects.toThrow(
      /startup|exited|WSL PTY/i,
    );
    expect(handle.terminate).toHaveBeenCalledTimes(1);
    expect(backendContextResult.spawnTerminal).not.toHaveBeenCalled();
  });

  it("does not publish a session when terminal allocation fails", async () => {
    const spawn = vi.fn(() => {
      throw new Error("bwrap unavailable");
    });
    const backendContextResult = backendContext(spawn);
    const backend = new WslTerminalBackend(backendContextResult.context, testConfig);

    await expect(backend.spawn(spawnSpec({ id: "agent-a" }))).rejects.toThrow(
      /bwrap|sandbox|unavailable|WSL/i,
    );
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(backendContextResult.spawnTerminal).not.toHaveBeenCalled();
  });

  it("keeps separate owner inputs distinct at the backend boundary", async () => {
    const allocatedA = terminalHandle();
    const allocatedB = terminalHandle();
    const specs: SubprocessSpawnSpec[] = [];
    const spawn = vi.fn((spec: SubprocessSpawnSpec) => {
      specs.push(spec);
      return specs.length === 1 ? allocatedA.handle : allocatedB.handle;
    });
    const backendContextResult = backendContext(spawn);
    const backend = new WslTerminalBackend(backendContextResult.context, testConfig);

    const sessionA = await backend.spawn(spawnSpec({ id: "agent-a" }));
    const sessionB = await backend.spawn({ ...spawnSpec({ id: "agent-b" }), sessionId: "session-2" as TerminalBackendSpawnSpec["sessionId"] });
    expect(specs).toHaveLength(2);
    expect(specs[0]?.cwd).toBe(specs[1]?.cwd);
    expect(specs[0]?.env).not.toEqual(specs[1]?.env);
    expect(backendContextResult.spawnTerminal).not.toHaveBeenCalled();
    await Promise.all([sessionA.close("test cleanup A"), sessionB.close("test cleanup B")]);
  });

  it("does not infer idle while an ordinary-pipe foreground command is silent", async () => {
    const output = new PassThrough();
    let finish!: () => void;
    const done = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => {
        finish = () => resolve({ exitCode: 0, signal: null });
      },
    );
    const transport: WslPtyTransport = {
      pid: 4545,
      output,
      done,
     write: vi.fn(async (data: string) => {
        if (data.includes("readonly PROMPT_COMMAND")) {
          output.write(controlledPrompt());
          return;
        }
       if (!data.includes("sleep")) return;
        setTimeout(() => {
          output.write(`done\n${controlledPrompt()}`);
        }, 100);
      }),
      // The rc.6 ordinary subprocess handle exposes no Linux foreground pgid.
      inspectForeground: vi.fn(async () => undefined),
      signalForeground: vi.fn(async () => 4545),
      terminate: vi.fn(async () => {
        finish();
        output.end();
      }),
    };
    const session = new WslPtySession(
      transport,
      resolveConfig({ pollIntervalMs: 5, idleSilenceMs: 25, timeoutMs: 500 }),
    );

    const initializing = session.initialize();
    output.write(controlledPrompt());
    await initializing;

    const operation = session.startSend({
      text: "sleep 100; printf done",
      submit: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    let settledEarly = false;
    void operation.done.then(() => {
      settledEarly = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settledEarly).toBe(false);

    const result = await operation.done;
    expect(result.waitReason).toBe("stdin_read");
    expect(result.viewport).toContain("done");
    await session.close("test cleanup");
  });

  it("discards oversized split CSI and OSC escapes without leaking printable tails", async () => {
    const output = new PassThrough();
    let finish!: () => void;
    const done = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      finish = () => resolve({ exitCode: 0, signal: null });
    });
    const transport: WslPtyTransport = {
      pid: 4646,
      output,
      done,
      write: vi.fn(async (data: string) => {
        if (data.includes("readonly PROMPT_COMMAND")) {
          output.write(controlledPrompt());
          return;
        }
        if (data.includes("oversized-osc")) {
          output.write(`\u001b]${"x".repeat(80)}`);
          output.write(`discarded-osc\u001b`);
          output.write(`\\safe-osc\n${controlledPrompt()}`);
          return;
        }
        if (data.includes("oversized-csi")) {
          output.write(`\u001b[${"1".repeat(80)}`);
          output.write("still-discarded");
          output.write(`Aafter-csi\n${controlledPrompt()}`);
        }
      }),
      inspectForeground: vi.fn(async () => undefined),
      signalForeground: vi.fn(async () => 4646),
      terminate: vi.fn(async () => {
        finish();
        output.end();
      }),
    };
    const session = new WslPtySession(
      transport,
      resolveConfig({
        // Keep the sanitizer bound below the oversized escape while leaving
        // enough viewport budget for the safe payload plus its prompt marker.
        maxReadBytes: 64,
        scrollbackMaxBytes: 256,
        pollIntervalMs: 5,
        idleSilenceMs: 25,
        timeoutMs: 500,
      }),
    );
    const initializing = session.initialize();
    output.write(controlledPrompt());
    await initializing;

    const osc = session.startSend({ text: "oversized-osc", submit: true });
    const oscResult = await osc.done;
    expect(oscResult.viewport).toContain("safe-osc");
    expect(oscResult.viewport).not.toContain("discarded-osc");

    const csi = session.startSend({ text: "oversized-csi", submit: true });
    const csiResult = await csi.done;
    expect(csiResult.viewport).toContain("after-csi");
    expect(csiResult.viewport).not.toContain("still-discarded");
    await session.close("test cleanup");
  });
});
