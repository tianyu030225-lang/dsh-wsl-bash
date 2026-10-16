import { describe, expect, it, vi } from "vitest";
import type {
  SubprocessHandle,
  SubprocessRuntime,
} from "@deepseek-ai/dsh-subprocess";

import {
  buildGitBashArgv,
  executeGitBash,
} from "../../../src/tools/git-bash.js";
import {
  buildWslArgv,
  executeWslBash,
  probeWslRuntime,
  WSL_RUNNER_SCRIPT,
} from "../../../src/tools/wsl-bash.js";

const command = "printf '%s\\n' \"$(touch SHOULD_NOT_RUN)\"";

function subprocessHandle(stdoutText = "", stderrText = "", lossy = false): SubprocessHandle {
  const reader = (text: string) => ({
    readFrom: vi.fn(() => ({
      text,
      nextOffset: Buffer.byteLength(text),
      lossy,
    })),
  });
  return {
    stdin: undefined,
    stdout: undefined,
    stderr: undefined,
    control: undefined,
    collected: {
      stdout: reader(stdoutText),
      stderr: reader(stderrText),
    },
    done: Promise.resolve({ exitCode: 0, signal: null }),
    terminate: vi.fn(),
    waitForExit: vi.fn(async () => true),
  };
}

describe("one-shot tool security fences", () => {
  it("encodes WSL command data and keeps the policy root separate from cwd", () => {
    const plan = buildWslArgv(
      {
        command,
        description: "Print a value",
        workdir: "C:\\Users\\Alice\\work\\dsh_bash\\目录 with spaces",
      },
      {
        mode: "workspace-write",
        workspaceRoot: "C:\\Users\\Alice\\work\\dsh_bash",
      },
      {
        platform: "win32",
        executable: "C:\\Windows\\System32\\wsl.exe",
        distro: "Ubuntu",
      },
    );

    expect(plan.argv.slice(0, 4)).toEqual([
      "-d",
      "Ubuntu",
      "--cd",
      "/mnt/c/Users/Alice/work/dsh_bash/目录 with spaces",
    ]);
    expect(plan.argv).toContain("--bind");
    expect(plan.argv).not.toContain("--unshare-net");
    expect(plan.argv.at(-1)).toBe(
      Buffer.from(command, "utf8").toString("base64"),
    );
    expect(WSL_RUNNER_SCRIPT).not.toContain(command);
  });

  it("uses bwrap for full-access WSL and still requires the immutable policy root", () => {
    const plan = buildWslArgv(
      { command: "printf ok", description: "Print ok" },
      {
        mode: "danger-full-access",
        workspaceRoot: "C:\\Users\\Alice\\work\\dsh_bash",
      },
      {
        platform: "win32",
        executable: "C:\\Windows\\System32\\wsl.exe",
        distro: "Ubuntu",
      },
    );
    expect(plan.argv).toContain("/usr/bin/bwrap");
    const bindIndex = plan.argv.indexOf("--bind");
    expect(bindIndex).toBeGreaterThanOrEqual(0);
    expect(plan.argv.slice(bindIndex, bindIndex + 3)).toEqual([
      "--bind",
      "/",
      "/",
    ]);
    expect(plan.mode).toBe("danger-full-access");

    expect(() =>
      buildWslArgv(
        { command: "printf ok", description: "Print ok" },
        { mode: "danger-full-access" },
        {
          platform: "win32",
          executable: "C:\\Windows\\System32\\wsl.exe",
          distro: "Ubuntu",
        },
      ),
    ).toThrow(/immutable sandboxPolicy\.workspaceRoot/);
  });

  it("fails closed before spawn when the WSL sandbox runtime is missing", async () => {
    const result = await executeWslBash(
      { command: "printf ok", description: "Print ok" },
      {
        policy: {
          mode: "workspace-write",
          workspaceRoot: "C:\\Users\\Alice\\work\\dsh_bash",
        },
        platform: "win32",
        executable: "C:\\Windows\\System32\\wsl.exe",
        distro: "Ubuntu",
        probeRuntime: vi.fn(async () => ({ ok: false, message: "bwrap missing" })),
      },
    );
    expect(result.failure?.kind).toBe("sandbox-unavailable");
    expect(result.exitCode).toBeNull();
    expect(result.stderr.text).toContain("bwrap missing");
  });

  it("does not discover or spawn Git Bash in restricted mode", async () => {
    const result = await executeGitBash(
      { command, description: "Run a command" },
      {
        policy: { mode: "workspace-write" },
        // Deliberately invalid: a restricted denial must happen before discovery.
        executable: "\\\\?\\C:\\attacker\\bash.exe",
        platform: "win32",
      },
    );
    expect(result.failure?.kind).toBe("sandbox-denied");
    expect(result.sandbox.denied).toBe(true);
    expect(result.stderr.text).toMatch(/no process|danger-full-access/i);
  });

  it("rejects an inexact Git Bash escalation instead of running it", async () => {
    const result = await executeGitBash(
      {
        command,
        description: "Run a command",
        sandbox_permissions: "workspace-write",
        justification: "Try a narrower mode",
      },
      {
        policy: { mode: "read-only" },
        executable: "C:\\Program Files\\Git\\bin\\bash.exe",
        platform: "win32",
        approvalContext: {
          approver: {},
          agent: { id: "agent-a" },
          callId: "call-1",
          toolName: "git_bash",
          signal: new AbortController().signal,
        },
        approve: vi.fn(async () => "workspace-write" as const),
      },
    );
    expect(result.failure?.kind).toBe("sandbox-denied");
    expect(result.sandbox.denied).toBe(true);
  });

  it("rejects Git Bash UNC/device workdirs before a child is created", () => {
    expect(() =>
      buildGitBashArgv(
        { command: "printf ok", description: "Print ok", workdir: "\\\\server\\share" },
        {
          executable: "C:\\Program Files\\Git\\bin\\bash.exe",
          platform: "win32",
        },
        "danger-full-access",
      ),
    ).toThrow();
  });

  it("rejects NUL command and description data before either tool can spawn", async () => {
    const wslSpawn = vi.fn();
    await expect(
      executeWslBash(
        { command: "printf ok\0", description: "Print ok" },
        {
          policy: {
            mode: "workspace-write",
            workspaceRoot: "C:\\Users\\Alice\\work\\dsh_bash",
          },
          platform: "win32",
          executable: "C:\\Windows\\System32\\wsl.exe",
          spawnImpl: wslSpawn,
        },
      ),
    ).rejects.toThrow(/NUL/i);
    expect(wslSpawn).not.toHaveBeenCalled();

    const gitSpawn = vi.fn();
    await expect(
      executeGitBash(
        { command: "printf ok", description: "Print ok\0" },
        {
          policy: { mode: "danger-full-access" },
          executable: "C:\\Program Files\\Git\\bin\\bash.exe",
          platform: "win32",
          spawnImpl: gitSpawn,
        },
      ),
    ).rejects.toThrow(/NUL/i);
    expect(gitSpawn).not.toHaveBeenCalled();
  });

  it("uses the official subprocess runtime for the WSL preflight", async () => {
    const handle = subprocessHandle();
    const spawn = vi.fn(() => handle);
    const subprocess = { spawn } as unknown as SubprocessRuntime;

    await expect(
      probeWslRuntime({
        executable: "C:\\Windows\\System32\\wsl.exe",
        distro: "Ubuntu",
        subprocess,
      }),
    ).resolves.toEqual({ ok: true });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(handle.waitForExit).toHaveBeenCalledTimes(1);
  });

  it("passes the official subprocess runtime through the default WSL preflight", async () => {
    const handles = [
      subprocessHandle("/mnt/c/Users/Alice/work/dsh_bash\n/mnt/c/Users/Alice/work/dsh_bash\n"),
      subprocessHandle(),
      subprocessHandle("ok"),
    ];
    const spawn = vi.fn(() => handles.shift()!);
    const subprocess = { spawn } as unknown as SubprocessRuntime;

    const result = await executeWslBash(
      { command: "printf ok", description: "Print ok" },
      {
        policy: {
          mode: "workspace-write",
          workspaceRoot: "C:\\Users\\Alice\\work\\dsh_bash",
        },
        platform: "win32",
        executable: "C:\\Windows\\System32\\wsl.exe",
        distro: "Ubuntu",
        subprocess,
      },
    );

    expect(result.failure).toBeUndefined();
    expect(result.exitCode).toBe(0);
    expect(spawn).toHaveBeenCalledTimes(3);
  for (const call of spawn.mock.results) {
    expect(call.value.waitForExit).toHaveBeenCalledTimes(1);
  }
 });

  it("fails closed on WSL canonicalization truncation, framing, or mapping mismatch", async () => {
    const cases = [
      {
        stdout: "/mnt/c/Users/Alice/work/dsh_bash\n/mnt/c/Users/Alice/work/dsh_bash\n",
        lossy: true,
        message: /16KiB|truncat/i,
      },
      {
        stdout: "/mnt/c/Users/Alice/work/dsh_bash\n/mnt/c/Users/Alice/work/dsh_bash\nextra\n",
        lossy: false,
        message: /framing|invalid/i,
      },
      {
        stdout: "/mnt/c/Users/Alice/work/other\n/mnt/c/Users/Alice/work/dsh_bash\n",
        lossy: false,
        message: /immutable|mapping|realpath/i,
      },
    ] as const;
    for (const testCase of cases) {
      const handle = subprocessHandle(testCase.stdout, "", testCase.lossy);
      const spawn = vi.fn(() => handle);
      const result = await executeWslBash(
        { command: "printf ok", description: "Print ok" },
        {
          policy: {
            mode: "workspace-write",
            workspaceRoot: "C:\\Users\\Alice\\work\\dsh_bash",
          },
          platform: "win32",
          executable: "C:\\Windows\\System32\\wsl.exe",
          distro: "Ubuntu",
          subprocess: { spawn } as unknown as SubprocessRuntime,
        },
      );
      expect(result.failure?.kind).toBe("sandbox-unavailable");
      expect(result.stderr.text).toMatch(testCase.message);
      // Canonicalization is the only permitted child creation; no preflight
      // or command process may run after an invalid security result.
      expect(spawn).toHaveBeenCalledTimes(1);
    }
  });
});
