import { describe, expect, it, vi } from "vitest";
import type {
  SubprocessHandle,
  SubprocessRuntime,
} from "@deepseek-ai/dsh-subprocess";

import {
  buildWslArgv,
  probeWslRuntime,
} from "../../../src/tools/wsl-bash.js";
import {
  runDoctor,
  type DoctorOptions,
  type ProbeResult,
} from "../../../src/doctor/checks.js";
import type { GitBashFs } from "../../../src/discovery/git-bash.js";

const WSL_EXECUTABLE = "C:\\Windows\\System32\\wsl.exe";
const DISTRO = "Ubuntu";
const WORKSPACE_ROOT = "C:\\Users\\Alice\\work\\dsh 插件测试";

function outputReader(text = "") {
  return {
    readFrom: vi.fn(() => ({
      text,
      nextOffset: Buffer.byteLength(text),
      lossy: false,
    })),
  };
}

function successfulSubprocessHandle(): SubprocessHandle {
  return {
    stdin: undefined,
    stdout: undefined,
    stderr: undefined,
    control: undefined,
    collected: {
      stdout: outputReader(),
      stderr: outputReader(),
    },
    done: Promise.resolve({ exitCode: 0, signal: null }),
    terminate: vi.fn(),
    waitForExit: vi.fn(async () => true),
  };
}

function passingGitBashFs(): GitBashFs {
  const realpathSync = Object.assign(
    vi.fn((value: string) => value),
    { native: vi.fn((value: string) => value) },
  );
  return {
    statSync: vi.fn(() => ({ isFile: () => true })),
    accessSync: vi.fn(),
    realpathSync,
  } as unknown as GitBashFs;
}

function passingDoctorProbe() {
  return vi.fn(async (_executable: string, argv: readonly string[]): Promise<ProbeResult> => {
    if (argv[0] === "-l") {
      return {
        exitCode: 0,
        stdout: Buffer.from("Ubuntu\r\n", "utf16le").toString("utf8"),
        stderr: "",
      };
    }
    if (argv.includes("/bin/uname")) {
      return { exitCode: 0, stdout: "Linux 6.1 WSL2", stderr: "" };
    }
    if (argv.includes("/usr/bin/wslpath")) {
      return {
        exitCode: 0,
        stdout: "/mnt/c/Users/Alice/work/dsh 插件测试\r\n",
        stderr: "",
      };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  });
}

function doctorOptions(): DoctorOptions {
  return {
    platform: "win32",
    dshVersion: "0.2.2-alpha.2",
    wslExecutable: WSL_EXECUTABLE,
    distro: DISTRO,
    workspaceRoot: WORKSPACE_ROOT,
    gitBashPath: "C:\\Program Files\\Git\\bin\\bash.exe",
    pathExists: vi.fn(() => true),
    gitBashFs: passingGitBashFs(),
  };
}

describe("WSL direct-exec argv contract", () => {
  it("uses --exec for the one-shot bwrap launch after --cd", () => {
    const plan = buildWslArgv(
      {
        command: "printf '%s\\n' ok",
        description: "Print ok",
      },
      {
        mode: "workspace-write",
        workspaceRoot: WORKSPACE_ROOT,
      },
      {
        platform: "win32",
        executable: WSL_EXECUTABLE,
        distro: DISTRO,
      },
    );

    expect(plan.argv.slice(0, 4)).toEqual([
      "-d",
      DISTRO,
      "--cd",
      WORKSPACE_ROOT,
    ]);
    expect(plan.hostCwd).toBe(WORKSPACE_ROOT);
    expect(plan.argv[4]).toBe("--exec");
    expect(plan.argv[5]).toBe("/usr/bin/bwrap");
    expect(plan.argv.slice(0, 5)).not.toContain("--");
  });

  it("uses --exec for the direct probe without a default-shell hop", async () => {
    const handle = successfulSubprocessHandle();
    const spawn = vi.fn(
      (_spec: Parameters<SubprocessRuntime["spawn"]>[0]) => handle,
    );
    const subprocess = { spawn } as unknown as SubprocessRuntime;

    await expect(
      probeWslRuntime({
        executable: WSL_EXECUTABLE,
        distro: DISTRO,
        subprocess,
      }),
    ).resolves.toEqual({ ok: true });

    const spec = spawn.mock.calls[0]?.[0];
    expect(spec).toBeDefined();
    if (spec === undefined) throw new Error("probe did not spawn a subprocess");
    expect(spec.argv.slice(0, 4)).toEqual([
      WSL_EXECUTABLE,
      "-d",
      DISTRO,
      "--exec",
    ]);
    expect(spec.argv[4]).toBe("/usr/bin/env");
    expect(spec.argv).toEqual(expect.arrayContaining([
      "-u", "BASH_ENV", "-u", "ENV", "SHELL=/bin/bash", "/bin/bash",
    ]));
    expect(spec.env).toMatchObject({
      BASH_ENV: undefined,
      ENV: undefined,
      SHELLOPTS: undefined,
      BASHOPTS: undefined,
    });
  });

  it("uses --exec for every doctor WSL command while retaining bwrap's inner --", async () => {
    const probe = passingDoctorProbe();
    const report = await runDoctor({ ...doctorOptions(), probe });

    expect(report.ok).toBe(true);
    const wslCalls = probe.mock.calls.filter(
      ([executable]) => executable === WSL_EXECUTABLE,
    );
    const directWslCalls = wslCalls.filter(([_, argv]) => argv[0] === "-d");
    expect(directWslCalls.length).toBeGreaterThanOrEqual(6);
    for (const [, argv] of directWslCalls) {
      expect(argv.slice(0, 3)).toEqual(["-d", DISTRO, "--exec"]);
      expect(argv.slice(0, 3)).not.toEqual(["-d", DISTRO, "--"]);
    }

    const bwrapCall = directWslCalls.find(([, argv]) => argv[3] === "/usr/bin/bwrap");
    expect(bwrapCall?.[1]).toContain("--");
  });
});
