import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

const resolveGitBashPath = vi.hoisted(() => vi.fn());
const spawnGitBashPty = vi.hoisted(() => vi.fn());

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  const isLogicalWindowsPath = (value: unknown): value is string =>
    typeof value === "string" && /^[A-Za-z]:[\\/]/.test(value);
  const realpathSync = Object.assign(
    ((path: Parameters<typeof actual.realpathSync>[0], options?: Parameters<typeof actual.realpathSync>[1]) =>
      isLogicalWindowsPath(path) ? path : actual.realpathSync(path, options as never)) as typeof actual.realpathSync,
    {
      native: ((path: Parameters<typeof actual.realpathSync.native>[0], options?: Parameters<typeof actual.realpathSync.native>[1]) =>
        isLogicalWindowsPath(path) ? path : actual.realpathSync.native(path, options as never)) as typeof actual.realpathSync.native,
    },
  );
  const statSync = ((path: Parameters<typeof actual.statSync>[0], options?: Parameters<typeof actual.statSync>[1]) =>
    isLogicalWindowsPath(path)
      ? { isDirectory: () => true, isFile: () => false }
      : actual.statSync(path, options as never)) as typeof actual.statSync;
  return { ...actual, realpathSync, statSync };
});

vi.mock("../../../src/discovery/git-bash.js", async () => {
  const actual = await vi.importActual<typeof import("../../../src/discovery/git-bash.js")>(
    "../../../src/discovery/git-bash.js",
  );
  return { ...actual, resolveGitBashPath };
});

vi.mock("../../../src/git/pty.js", () => ({ spawnGitBashPty }));

import { resolveConfig } from "../../../src/config.js";
import { GitBashTerminalBackend } from "../../../src/git/backend.js";

const artifactRoot = resolve(process.cwd(), "测试", "运行产物");
const temporaryRoots: string[] = [];

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value), "utf8");
}

function writeText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, "utf8");
}

function createHostGitFixture(delayMs = 0): {
  anchor: string;
  workspaceRoot: string;
  shellPath: string;
} {
  mkdirSync(artifactRoot, { recursive: true });
  const root = mkdtempSync(join(artifactRoot, "unit-git-backend-"));
  temporaryRoots.push(root);
  const anchor = join(root, "node_modules", "@deepseek-ai", "dsh", "package.json");
  const shellPath = join(root, "Git", "bin", "bash.exe");

  writeJson(anchor, { name: "@deepseek-ai/dsh", version: "0.2.1-rc.3" });
  writeJson(join(root, "node_modules", "@deepseek-ai", "dsh-terminal-bash", "package.json"), {
    name: "@deepseek-ai/dsh-terminal-bash",
    version: "0.2.1-rc.3",
    type: "module",
    exports: { ".": "./index.js" },
  });
  writeText(
    join(root, "node_modules", "@deepseek-ai", "dsh-terminal-bash", "index.js"),
    [
      delayMs > 0 ? `await new Promise((resolve) => setTimeout(resolve, ${delayMs}));` : "",
      "const events = globalThis.__dshGitBackendEvents;",
      "export class BashTerminalBackend {",
      "  constructor(_ctx, config, spawn, createSession) { events?.push({ kind: 'construct', config }); globalThis.__dshGitBackendSpawn = spawn; globalThis.__dshGitBackendCreateSession = createSession; }",
      "  async spawn(spec) { events?.push({ kind: 'spawn' }); if (globalThis.__dshInvokeGitSpawnCallback) { const terminal = await globalThis.__dshGitBackendSpawn({ type: 'bash', cwd: spec.cwd }); globalThis.__dshGitBackendSession = globalThis.__dshGitBackendCreateSession(terminal); } return globalThis.__dshGitBackendSession; }",
      "}",
    ].filter((line) => line.length > 0).join("\n"),
  );
  // Resolve the emulator from the host fixture anchored by dsh-terminal-bash.
  // This is deliberately CommonJS: the installed rc.3 host package is loaded
  // through createRequire, and the plugin must not use a plugin-owned copy.
  writeJson(join(root, "node_modules", "@xterm", "headless", "package.json"), {
    name: "@xterm/headless",
    version: "6.0.0-fixture",
    main: "index.js",
  });
  writeText(
    join(root, "node_modules", "@xterm", "headless", "index.js"),
    [
      "const events = globalThis.__dshGitBackendEvents;",
      "events?.push({ kind: 'emulator-load' });",
      "class Terminal {",
      "  constructor(options) { events?.push({ kind: 'emulator-construct', options }); }",
      "  onData() { return { dispose() {} }; }",
      "  write(_data, callback) { callback(); }",
      "  dispose() { events?.push({ kind: 'emulator-dispose' }); }",
      "}",
      "module.exports = { Terminal };",
    ].join("\n"),
  );
  mkdirSync(dirname(shellPath), { recursive: true });
  writeFileSync(shellPath, "fixture", "utf8");

  return {
    anchor,
    workspaceRoot: String.raw`C:\fixture\unit-git-backend\workspace`,
    shellPath,
  };
}

function createContext(
  anchor: string,
  workspaceRoot: string,
  modes: readonly string[],
): { ctx: any; resolvePolicy: ReturnType<typeof vi.fn>; spawnTerminal: ReturnType<typeof vi.fn> } {
  const resolvePolicy = vi.fn(() => ({
    mode: modes[Math.min(Math.max(resolvePolicy.mock.calls.length - 1, 0), modes.length - 1)] ?? "danger-full-access",
    workspaceRoot,
  }));
  const spawnTerminal = vi.fn();
  return {
    ctx: {
      profileContext: { installAnchor: anchor },
      sandboxPolicy: { resolve: resolvePolicy },
      subprocess: { spawnTerminal },
    },
    resolvePolicy,
    spawnTerminal,
  };
}

function createFakeGitTransport(): {
  output: PassThrough;
  done: Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>;
  write: ReturnType<typeof vi.fn>;
  inspectForeground: ReturnType<typeof vi.fn>;
  signalForeground: ReturnType<typeof vi.fn>;
  terminate: ReturnType<typeof vi.fn>;
} {
  const output = new PassThrough();
  let finish!: () => void;
  let terminated = false;
  const done = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    finish = () => resolve({ exitCode: null, signal: "SIGTERM" });
  });
  const write = vi.fn(async () => undefined);
  const inspectForeground = vi.fn(async () => ({ processGroupId: 7123, inputWaiting: false }));
  const signalForeground = vi.fn(async () => 7123);
  const terminate = vi.fn(async () => {
    if (terminated) return;
    terminated = true;
    finish();
    output.end();
  });
  return { output, done, write, inspectForeground, signalForeground, terminate };
}

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 250;
  while (!condition() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  expect(condition()).toBe(true);
}

function spawnSpec(
  workspaceRoot: string,
  options: { cwd?: string; signal?: AbortSignal } = {},
): any {
  return {
    type: "git-bash",
    sessionId: "git-session-1",
    owner: { id: "agent-a", session: "session-a" },
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    workspaceRoot,
  };
}

afterEach(() => {
  resolveGitBashPath.mockReset();
  delete (globalThis as any).__dshGitBackendEvents;
  delete (globalThis as any).__dshGitBackendSession;
  delete (globalThis as any).__dshGitBackendSpawn;
  delete (globalThis as any).__dshGitBackendCreateSession;
  delete (globalThis as any).__dshInvokeGitSpawnCallback;
  spawnGitBashPty.mockReset();
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("persistent Git Bash permission fence", () => {
  it.each(["read-only", "workspace-write"])("rejects %s sessions before discovery, host import, or process creation", async (mode) => {
    const fixture = createHostGitFixture();
    resolveGitBashPath.mockReturnValue(fixture.shellPath);
    const execution = createContext(fixture.anchor, fixture.workspaceRoot, [mode]);
    const backend = new GitBashTerminalBackend(
      execution.ctx,
      resolveConfig({ backendType: "git-bash", persistentShell: "git-bash" }),
    );

    await expect(backend.spawn(spawnSpec(fixture.workspaceRoot))).rejects.toThrow(
      /danger-full-access/,
    );
    expect(execution.resolvePolicy).toHaveBeenCalledOnce();
    expect(resolveGitBashPath).not.toHaveBeenCalled();
    expect(execution.spawnTerminal).not.toHaveBeenCalled();
  });

  it.each([
    "\\\\server\\share\\workspace",
    "C:relative\\workspace",
    "C:\\",
    "\\\\?\\C:\\workspace",
  ])("rejects unsafe full-access workspace %j before Git Bash discovery", async (workspaceRoot) => {
    const fixture = createHostGitFixture();
    resolveGitBashPath.mockReturnValue(fixture.shellPath);
    const execution = createContext(fixture.anchor, workspaceRoot, ["danger-full-access"]);
    const backend = new GitBashTerminalBackend(
      execution.ctx,
      resolveConfig({ backendType: "git-bash", persistentShell: "git-bash" }),
    );

    await expect(backend.spawn(spawnSpec(workspaceRoot))).rejects.toThrow();
    expect(resolveGitBashPath).not.toHaveBeenCalled();
    expect(execution.spawnTerminal).not.toHaveBeenCalled();
  });

  it.each([
    "\\\\server\\share\\cwd",
    "C:relative\\cwd",
    "C:",
    "\\\\?\\C:\\cwd",
  ])("rejects unsafe cwd before Git Bash discovery %j", async (cwd) => {
    const fixture = createHostGitFixture();
    resolveGitBashPath.mockReturnValue(fixture.shellPath);
    const execution = createContext(fixture.anchor, fixture.workspaceRoot, ["danger-full-access"]);
    const backend = new GitBashTerminalBackend(
      execution.ctx,
      resolveConfig({ backendType: "git-bash", persistentShell: "git-bash" }),
    );

    await expect(backend.spawn(spawnSpec(fixture.workspaceRoot, { cwd }))).rejects.toThrow();
    expect(resolveGitBashPath).not.toHaveBeenCalled();
    expect(execution.spawnTerminal).not.toHaveBeenCalled();
  });

  it("honors cancellation before any file access or host module import", async () => {
    const fixture = createHostGitFixture();
    resolveGitBashPath.mockReturnValue(fixture.shellPath);
    const execution = createContext(fixture.anchor, fixture.workspaceRoot, ["danger-full-access"]);
    const backend = new GitBashTerminalBackend(
      execution.ctx,
      resolveConfig({ backendType: "git-bash", persistentShell: "git-bash" }),
    );
    const controller = new AbortController();
    controller.abort(new Error("cancelled before Git Bash setup"));

    await expect(backend.spawn(spawnSpec(fixture.workspaceRoot, { signal: controller.signal }))).rejects.toThrow(
      /cancelled|aborted/i,
    );
    expect(execution.resolvePolicy).not.toHaveBeenCalled();
    expect(resolveGitBashPath).not.toHaveBeenCalled();
    expect(execution.spawnTerminal).not.toHaveBeenCalled();
  });
});

describe("Git Bash load-time permission and host module contracts", () => {
  it("rechecks the live permission after importing the official host PTY module", async () => {
    const fixture = createHostGitFixture();
    resolveGitBashPath.mockReturnValue(fixture.shellPath);
    (globalThis as any).__dshGitBackendEvents = [];
    const execution = createContext(fixture.anchor, fixture.workspaceRoot, [
      "danger-full-access",
      "workspace-write",
    ]);
    const backend = new GitBashTerminalBackend(
      execution.ctx,
      resolveConfig({ backendType: "git-bash", persistentShell: "git-bash" }),
    );

    await expect(backend.spawn(spawnSpec(fixture.workspaceRoot))).rejects.toThrow(
      /danger-full-access/,
    );
    expect(execution.resolvePolicy).toHaveBeenCalledTimes(2);
    expect((globalThis as any).__dshGitBackendEvents).toEqual([]);
    expect(execution.spawnTerminal).not.toHaveBeenCalled();
  });

  it("rechecks the live permission at the official PTY spawn callback before creating a process", async () => {
    const fixture = createHostGitFixture();
    resolveGitBashPath.mockReturnValue(fixture.shellPath);
    (globalThis as any).__dshGitBackendEvents = [];
    (globalThis as any).__dshInvokeGitSpawnCallback = true;
    const execution = createContext(fixture.anchor, fixture.workspaceRoot, [
      "danger-full-access",
      "danger-full-access",
      "workspace-write",
    ]);
    execution.spawnTerminal.mockReturnValue({});
    const backend = new GitBashTerminalBackend(
      execution.ctx,
      resolveConfig({ backendType: "git-bash", persistentShell: "git-bash" }),
    );

    await expect(backend.spawn(spawnSpec(fixture.workspaceRoot))).rejects.toThrow(
      /danger-full-access/,
    );
    expect(execution.resolvePolicy).toHaveBeenCalledTimes(3);
    expect((globalThis as any).__dshGitBackendEvents.map((event: any) => event.kind)).toEqual([
      "emulator-load",
      "construct",
      "spawn",
    ]);
    expect(execution.spawnTerminal).not.toHaveBeenCalled();
  });

  it("honors cancellation that arrives while the official host PTY module is loading", async () => {
    const fixture = createHostGitFixture(40);
    resolveGitBashPath.mockReturnValue(fixture.shellPath);
    (globalThis as any).__dshGitBackendEvents = [];
    const execution = createContext(fixture.anchor, fixture.workspaceRoot, ["danger-full-access"]);
    const backend = new GitBashTerminalBackend(
      execution.ctx,
      resolveConfig({ backendType: "git-bash", persistentShell: "git-bash" }),
    );
    const controller = new AbortController();
    const abortTimer = setTimeout(() => {
      controller.abort(new Error("cancelled while loading Git Bash PTY"));
    }, 5);

    try {
      await expect(backend.spawn(spawnSpec(fixture.workspaceRoot, { signal: controller.signal }))).rejects.toThrow(
        /cancelled|aborted/i,
      );
    } finally {
      clearTimeout(abortTimer);
    }
    expect((globalThis as any).__dshGitBackendEvents).toEqual([]);
    expect(execution.spawnTerminal).not.toHaveBeenCalled();
  }, 5000);

  it("loads and delegates to the official PTY backend resolved from the host anchor", async () => {
    const fixture = createHostGitFixture();
    const session = { motd: "host-session" };
    (globalThis as any).__dshGitBackendEvents = [];
    (globalThis as any).__dshGitBackendSession = session;
    resolveGitBashPath.mockReturnValue(fixture.shellPath);
    const execution = createContext(fixture.anchor, fixture.workspaceRoot, ["danger-full-access"]);
    const backend = new GitBashTerminalBackend(
      execution.ctx,
      resolveConfig({ backendType: "git-bash", persistentShell: "git-bash" }),
    );

    await expect(backend.spawn(spawnSpec(fixture.workspaceRoot))).resolves.toBe(session);
    expect((globalThis as any).__dshGitBackendEvents.map((event: any) => event.kind)).toEqual([
      "emulator-load",
      "construct",
      "spawn",
    ]);
    expect(execution.resolvePolicy).toHaveBeenCalledTimes(2);
    expect(resolveGitBashPath).toHaveBeenCalledOnce();
  });

  it("uses the public fourth factory for native full-control readiness and host emulator cleanup", async () => {
    const fixture = createHostGitFixture();
    const transport = createFakeGitTransport();
    const events: any[] = [];
    (globalThis as any).__dshGitBackendEvents = events;
    (globalThis as any).__dshInvokeGitSpawnCallback = true;
    resolveGitBashPath.mockReturnValue(fixture.shellPath);
    spawnGitBashPty.mockImplementation(() => transport);
    const execution = createContext(fixture.anchor, fixture.workspaceRoot, ["danger-full-access"]);
    const config = resolveConfig({
      backendType: "git-bash",
      persistentShell: "git-bash",
      gitBashExecutable: fixture.shellPath,
      pollIntervalMs: 5,
      idleSilenceMs: 15,
      timeoutMs: 90,
      maxReadBytes: 4096,
      scrollbackMaxBytes: 4096,
      disposeGraceMs: 20,
    });
    const backend = new GitBashTerminalBackend(execution.ctx, config);
    const session = await backend.spawn(spawnSpec(fixture.workspaceRoot));

    expect(typeof (globalThis as any).__dshGitBackendCreateSession).toBe("function");
    expect(session).toBeDefined();
    expect(events.map((event) => event.kind)).toEqual([
      "emulator-load",
      "construct",
      "spawn",
      "emulator-construct",
    ]);
    expect(events.find((event) => event.kind === "emulator-construct").options).toEqual({
      rows: config.rows,
      cols: config.cols,
      scrollback: 0,
    });
    const request = spawnGitBashPty.mock.calls[0]?.[1] as { env?: Record<string, string> };
    expect(request.env?.PS1).toBe("");
    expect(request.env?.PROMPT_COMMAND).toBe(
      '__dsh_status=$?; PS1=""; printf "\\033]133;D;%s;__DSH_PERSISTENT_BASH_PROMPT__\\007__DSH_PERSISTENT_BASH_PROMPT__" "$__dsh_status"',
    );

    const nativeControl = "\u001b]133;D;0;__DSH_PERSISTENT_BASH_PROMPT__\u0007";
    const nativeVisible = "__DSH_PERSISTENT_BASH_PROMPT__";
    const initializing = (session as any).initialize() as Promise<void>;
    await waitFor(() => transport.inspectForeground.mock.calls.length > 0);
    transport.output.write(`${nativeControl}body\u001b[2J${nativeVisible}`);
    await initializing;
    // protectPrompt:false means startup does not write a second shell command.
    expect(transport.write).toHaveBeenCalledTimes(0);

    for (const [label, output] of [
      ["bare visible marker", nativeVisible],
      ["control without visible marker", nativeControl],
    ] as const) {
      const operation = (session as any).startSend({ text: label, submit: true });
      await waitFor(() => transport.write.mock.calls.length >= 1);
      transport.output.write(output);
      const result = await operation.done;
      expect(result.waitReason, label).toBe("timeout");
    }
    // The same foreground fact is present, but inferIdle:false prevents
    // promptless output from being treated as shell readiness.
    expect(transport.inspectForeground.mock.calls.length).toBeGreaterThan(2);

    await (session as any).close("public factory contract cleanup");
    expect(transport.terminate).toHaveBeenCalledOnce();
    expect(events.filter((event) => event.kind === "emulator-dispose")).toHaveLength(1);
  }, 5000);
});
