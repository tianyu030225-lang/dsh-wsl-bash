import { describe, expect, it, vi } from "vitest";
import type {
  SubprocessHandle,
  SubprocessRuntime,
  SubprocessSpawnSpec,
} from "@deepseek-ai/dsh-subprocess";

import { resolveConfig } from "../../../src/config.js";
import { resolveWslWorkspacePaths } from "../../../src/discovery/wsl.js";
import { buildWslArgv, executeWslBash } from "../../../src/tools/wsl-bash.js";
import { buildWslLaunchPlan } from "../../../src/wsl/launcher.js";

const WSL_EXECUTABLE = "C:\\Windows\\System32\\wsl.exe";
const DISTRO = "Ubuntu";
const WORKSPACE_ROOT = String.raw`C:\workspace\dsh 插件 测试`;
const WINDOWS_CWD = String.raw`C:\workspace\dsh 插件 测试\子目录`;
const WSL_ROOT = "/mnt/c/workspace/dsh 插件 测试";
const WSL_CWD = "/mnt/c/workspace/dsh 插件 测试/子目录";
const CONFIG = resolveConfig({ wslExecutable: WSL_EXECUTABLE, distro: DISTRO });

function outputReader(text = "") {
  return {
    readFrom: vi.fn(() => ({
      text,
      nextOffset: Buffer.byteLength(text),
      lossy: false,
    })),
  };
}

function completedHandle(stdoutText: string, exitCode: number): SubprocessHandle {
  return {
    stdin: undefined,
    stdout: undefined,
    stderr: undefined,
    control: undefined,
    collected: {
      stdout: outputReader(stdoutText),
      stderr: outputReader(),
    },
    done: Promise.resolve({ exitCode, signal: null }),
    terminate: vi.fn(),
    waitForExit: vi.fn(async () => true),
  };
}

  function managedSeam(
    canonicalOutput: string,
    final: { stdout?: string; exitCode?: number } = {},
  ): {
  runtime: SubprocessRuntime;
  spawn: ReturnType<typeof vi.fn>;
  specs: SubprocessSpawnSpec[];
} {
  const specs: SubprocessSpawnSpec[] = [];
  const spawn = vi.fn((spec: SubprocessSpawnSpec) => {
    specs.push(spec);
    // The final launch uses a non-zero sentinel. This proves that the path
    // canonicalization reached the managed launch seam without claiming that
    // a command actually ran successfully.
      return completedHandle(
        specs.length === 1 ? canonicalOutput : (final.stdout ?? ""),
        specs.length === 1 ? 0 : (final.exitCode ?? 73),
      );
  });
  return {
    runtime: { spawn } as unknown as SubprocessRuntime,
    spawn,
    specs,
  };
}

function executeOptions(runtime: SubprocessRuntime) {
  return {
    policy: {
      mode: "workspace-write" as const,
      workspaceRoot: WORKSPACE_ROOT,
    },
    platform: "win32" as const,
    executable: WSL_EXECUTABLE,
    distro: DISTRO,
    skipPreflight: true,
    subprocess: runtime,
  };
}

describe("WSL workdir representation at the managed canonicalization seam", () => {
    it("classifies a script PTY permission denial carried by merged stdout", async () => {
      const seam = managedSeam(`${WSL_ROOT}\n${WSL_ROOT}\n`, {
        stdout: "bash: marker: Read-only file system\r\n",
        exitCode: 1,
      });
      const result = await executeWslBash(
        { command: "touch /outside", description: "merged denial contract" },
        executeOptions(seam.runtime),
      );

      expect(result.exitCode).toBe(1);
      expect(result.stderr.text).toBe("");
      expect(result.stdout.text).toMatch(/Read-only file system/);
      expect(result.sandbox.denied).toBe(true);
    });

  it("keeps the discovery and argv layers equivalent for /mnt/<drive> and Windows spellings", () => {
    expect(resolveWslWorkspacePaths(WORKSPACE_ROOT, WSL_CWD)).toEqual({
      workspaceRoot: WSL_ROOT,
      cwd: WSL_CWD,
    });

    const plan = buildWslArgv(
      {
        command: "printf '%s\\n' boundary",
        description: "same-root WSL workdir spelling",
        workdir: WSL_CWD,
      },
      { mode: "workspace-write", workspaceRoot: WORKSPACE_ROOT },
      {
        platform: "win32",
        executable: WSL_EXECUTABLE,
        distro: DISTRO,
      },
    );

    expect(plan.cwd).toBe(WSL_CWD);
    expect(plan.hostCwd).toBe(WINDOWS_CWD.replace(/^C:/, "c:"));
    expect(plan.workspaceRoot).toBe(WSL_ROOT);
    expect(plan.argv.slice(0, 5)).toEqual([
      "-d",
      DISTRO,
      "--cd",
      WINDOWS_CWD.replace(/^C:/, "c:"),
      "--exec",
    ]);
  });

  it.each([
    ["Windows absolute", WINDOWS_CWD],
    ["relative", "子目录"],
    ["WSL absolute", WSL_CWD],
  ])("canonicalizes %s workdir with Chinese/space characters before the managed launch", async (_label, workdir) => {
    const seam = managedSeam(`${WSL_ROOT}\n${WSL_CWD}\n`);
    const result = await executeWslBash(
      {
        command: "printf '%s\\n' boundary",
        description: "same-root workdir seam",
        workdir,
      },
      executeOptions(seam.runtime),
    );

    expect(result.exitCode).toBe(73);
    expect(result.failure).toBeUndefined();
    expect(seam.specs).toHaveLength(2);
    const canonicalizer = seam.specs[0]!;
    const expectedHostCwd = workdir === WSL_CWD
      ? WINDOWS_CWD.replace(/^C:/, "c:")
      : WINDOWS_CWD;
    expect(canonicalizer.argv.slice(-2)).toEqual([WORKSPACE_ROOT, expectedHostCwd]);

    const launch = seam.specs[1]!;
    expect(launch.argv.slice(0, 5)).toEqual([
      WSL_EXECUTABLE,
      "-d",
      DISTRO,
      "--cd",
        expectedHostCwd,
    ]);
    expect(launch.argv[5]).toBe("--exec");
  });

  it("rejects realpath changes that model a workspace symlink", async () => {
    await expect(
      buildWslLaunchPlan(
        CONFIG,
        {
          mode: "workspace-write",
          workspaceRoot: WORKSPACE_ROOT,
          workdir: WSL_CWD,
        },
        undefined,
        async (linuxPath) =>
          linuxPath === WSL_ROOT ? "/mnt/c/workspace/redirected-root" : linuxPath,
      ),
    ).rejects.toThrow(/realpath no longer maps to the immutable policy workspace root/i);
  });

  it("accepts a target distro whose Windows drives are mounted outside /mnt", async () => {
    const customRoot = "/windir/c/workspace/dsh 插件 测试";
    const customCwd = `${customRoot}/子目录`;
    const plan = await buildWslLaunchPlan(
      CONFIG,
      {
        mode: "workspace-write",
        workspaceRoot: WORKSPACE_ROOT,
        workdir: WINDOWS_CWD,
      },
      undefined,
      async (linuxPath) => linuxPath,
      async (_config, windowsPath) => windowsPath === WORKSPACE_ROOT ? customRoot : customCwd,
    );

    expect(plan.workspaceRootLinux).toBe(customRoot);
    expect(plan.workdirLinux).toBe(customCwd);
  });

  it("rejects realpath changes that model a workdir junction escaping the root", async () => {
    await expect(
      buildWslLaunchPlan(
        CONFIG,
        {
          mode: "workspace-write",
          workspaceRoot: WORKSPACE_ROOT,
          workdir: WSL_CWD,
        },
        undefined,
        async (linuxPath) =>
          linuxPath === WSL_CWD ? "/mnt/c/workspace/outside-target" : linuxPath,
      ),
    ).rejects.toThrow(/WSL realpath escaped the immutable policy workspace root/i);
  });

  it.each([
    ["outside policy root", String.raw`C:\workspace\outside`],
    ["WSL path outside policy root", "/mnt/c/workspace/outside"],
    ["different drive", "/mnt/d/workspace/dsh 插件 测试/子目录"],
    ["Windows parent escape", String.raw`C:\workspace\dsh 插件 测试\..\outside`],
    ["WSL parent escape", "/mnt/c/workspace/dsh 插件 测试/../outside"],
    ["mount root", "/mnt/c"],
    ["UNC", String.raw`\\server\share`],
    ["device namespace", String.raw`\\?\C:\workspace\dsh 插件 测试\子目录`],
    ["NUL", `${WORKSPACE_ROOT}\u0000child`],
    ["embedded newline", `${WORKSPACE_ROOT}\nchild`],
  ])("rejects %s before any managed command spawn", async (_label, workdir) => {
    const seam = managedSeam("");
    const result = await executeWslBash(
      {
        command: "printf '%s\\n' boundary",
        description: "invalid workdir boundary",
        workdir,
      },
      executeOptions(seam.runtime),
    );

    expect(result.failure?.kind).toBe("sandbox-unavailable");
    expect(result.exitCode).toBeNull();
    expect(seam.spawn).not.toHaveBeenCalled();
  });
});
