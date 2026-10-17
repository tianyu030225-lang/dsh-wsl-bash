import { describe, expect, it, vi } from "vitest";

const FIXTURE_EXECUTABLE = "C:\\fixture\\Git\\bin\\bash.exe";
const resolveGitBashPath = vi.hoisted(() =>
  vi.fn(() => FIXTURE_EXECUTABLE),
);

vi.mock("../../../src/discovery/git-bash.js", async () => {
  const actual = await vi.importActual<typeof import("../../../src/discovery/git-bash.js")>(
    "../../../src/discovery/git-bash.js",
  );
  return { ...actual, resolveGitBashPath };
});

import { resolveConfig } from "../../../src/config.js";
import { registerOneShotTools } from "../../../src/tools/register.js";

type RegisteredTool = {
  name: string;
  output: {
    render: (args: Record<string, unknown>, value: unknown) => Array<{ type: string; text: string }>;
  };
  execute: (
    args: Record<string, unknown>,
    exec: Record<string, unknown>,
  ) => Promise<unknown>;
};

function subprocessHandle() {
  const reader = () => ({
    readFrom: vi.fn(() => ({
      text: "",
      nextOffset: 0,
      lossy: false,
    })),
  });
  return {
    collected: { stdout: reader(), stderr: reader() },
    done: Promise.resolve({ exitCode: 0, signal: null }),
    waitForExit: vi.fn(async () => true),
  };
}

function registerGitTool(
  policy: Record<string, unknown>,
  spawn = vi.fn((..._args: unknown[]) => subprocessHandle()),
  currentDirectory = String(policy.workspaceRoot ?? "C:\\fixture"),
) {
  const services: Record<string, unknown> = {
    sandboxPolicy: { resolve: vi.fn(() => policy) },
    subprocess: { spawn },
    approval: { request: vi.fn(async () => "rejected") },
  };
  const register = vi.fn();
  const ctx = {
    get: vi.fn((name: string) => services[name]),
    tools: { register },
    workingDirectory: { ensure: vi.fn(async () => currentDirectory) },
  } as any;
  registerOneShotTools(ctx, resolveConfig());
  const gitBash = register.mock.calls
    .map(([tool]) => tool as RegisteredTool)
    .find((tool) => tool.name === "git_bash");
  if (gitBash === undefined) throw new Error("git_bash was not registered");
  return { ctx, gitBash, spawn };
}

async function executeGitTool(
  policy: Record<string, unknown>,
  args: Record<string, unknown> = {
    command: "printf ok",
    description: "workdir contract",
  },
) {
  const execution = registerGitTool(policy);
  const result = await execution.gitBash.execute(args, {
    agent: { id: "agent-a" },
    callId: "git-workdir-contract",
    signal: new AbortController().signal,
  });
  return { ...execution, result: result as any };
}

describe("registered git_bash workspace-root working directory contract", () => {
    it("preserves and renders managed spawn failures", async () => {
      const error = Object.assign(new Error("spawn EACCES denied"), { code: "EACCES" });
      const spawn = vi.fn(() => { throw error; });
      const execution = registerGitTool({
        mode: "danger-full-access",
        workspaceRoot: "C:\\Users\\Alice\\work\\dsh_bash",
      }, spawn);
      const args = { command: "printf ok", description: "spawn failure contract" };
      const result = await execution.gitBash.execute(args, {
        agent: { id: "agent-a" },
        callId: "git-spawn-failure",
        signal: new AbortController().signal,
      }) as any;

      expect(result.failure).toEqual({
        kind: "spawn-error",
        message: "spawn EACCES denied",
        code: "EACCES",
      });
      expect(execution.gitBash.output.render(args, result)[0]?.text).toMatch(
        /failure: spawn-error.*spawn EACCES denied.*code EACCES/s,
      );
    });

  it.each([
    ["omitted", undefined, "C:\\Users\\Alice\\work\\dsh_bash"],
    [
      "relative",
      "nested\\dir",
      "C:\\Users\\Alice\\work\\dsh_bash\\nested\\dir",
    ],
    [
      "absolute",
      "C:\\Users\\Alice\\work\\dsh_bash\\explicit",
      "C:\\Users\\Alice\\work\\dsh_bash\\explicit",
    ],
  ])("resolves %s workdir from the trusted policy root", async (
    _label,
    workdir,
    expectedCwd,
  ) => {
    const args = {
      command: "printf ok",
      description: "workdir contract",
      ...(workdir === undefined ? {} : { workdir }),
    };
    const { result, spawn } = await executeGitTool({
      mode: "danger-full-access",
      workspaceRoot: "C:\\Users\\Alice\\work\\dsh_bash",
    }, args);

    expect(result.sandbox.denied).toBe(false);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0]?.[0]).toMatchObject({
      argv: [FIXTURE_EXECUTABLE, "--noprofile", "--norc", "-c", "printf ok"],
      cwd: expectedCwd,
    });
    expect(resolveGitBashPath).toHaveBeenCalled();
  });

  it("resolves a relative workdir from the latest Session directory", async () => {
    const root = "C:\\Users\\Alice\\work\\dsh_bash";
    const current = `${root}\\current`;
    const execution = registerGitTool({
      mode: "danger-full-access",
      workspaceRoot: root,
    }, undefined, current);

    await execution.gitBash.execute({
      command: "printf ok",
      description: "current directory contract",
      workdir: "nested",
    }, {
      agent: { id: "agent-a" },
      callId: "git-current-workdir",
      signal: new AbortController().signal,
    });

    expect(execution.ctx.workingDirectory.ensure).toHaveBeenCalledTimes(1);
    expect(execution.spawn.mock.calls[0]?.[0]).toMatchObject({
      cwd: `${current}\\nested`,
    });
  });

  it.each([
    "\\\\server\\share\\repo",
    "\\\\?\\C:\\outside\\bash.exe",
    "\\\\.\\PIPE\\bash.exe",
    "C:\\Users\\Alice\\work\\dsh_bash\\bad\0path",
  ])("rejects unsafe workdir %j before spawning", async (workdir) => {
    const { result, spawn } = await executeGitTool({
      mode: "danger-full-access",
      workspaceRoot: "C:\\Users\\Alice\\work\\dsh_bash",
    }, {
      command: "printf ok",
      description: "unsafe workdir",
      workdir,
    });

    expect(result.sandbox.denied).toBe(true);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("rejects restricted Git Bash before discovery or spawn", async () => {
    const { result, spawn } = await executeGitTool({
      mode: "workspace-write",
      workspaceRoot: "C:\\Users\\Alice\\work\\dsh_bash",
    });

    expect(result.sandbox.denied).toBe(true);
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each([undefined, ""]) (
    "requires a non-empty policy workspace root (%j) before subprocess access",
    async (workspaceRoot) => {
      const execution = registerGitTool({ mode: "danger-full-access", workspaceRoot });

      await expect(execution.gitBash.execute({
        command: "printf ok",
        description: "missing root",
      }, {
        agent: { id: "agent-a" },
        callId: "missing-root",
        signal: new AbortController().signal,
      })).rejects.toThrow(/immutable sandboxPolicy\.workspaceRoot/);
      expect(execution.spawn).not.toHaveBeenCalled();
      expect(execution.ctx.get).not.toHaveBeenCalledWith("subprocess");
    },
  );
});
