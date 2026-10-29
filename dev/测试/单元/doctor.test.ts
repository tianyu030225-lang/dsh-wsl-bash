import { describe, expect, it, vi } from "vitest";

import { runDoctor, type ProbeExecutionOptions } from "../../../src/doctor/checks.js";
import type { GitBashFs } from "../../../src/discovery/git-bash.js";

describe("doctor backend independence", () => {
  it("parses UTF-16LE-style NUL-padded output from wsl.exe -l -q", async () => {
    const gitBashPath = "C:\\Program Files\\Git\\bin\\bash.exe";
    const gitBashFs = {
      statSync: () => ({ isFile: () => true }),
      accessSync: vi.fn(),
      realpathSync: Object.assign(
        (path: string) => path,
        { native: (path: string) => path },
      ),
    } as unknown as GitBashFs;
    const probe = vi.fn(async (
      _executable: string,
      argv: readonly string[],
      _timeoutMs?: number,
      _execution?: ProbeExecutionOptions,
    ) => {
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
        return { exitCode: 0, stdout: "/mnt/c/Users/Alice/work/dsh_bash\r\n", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    const report = await runDoctor({
      platform: "win32",
      dshVersion: "0.2.2-alpha.2",
      wslExecutable: "C:\\Windows\\System32\\wsl.exe",
      distro: "Ubuntu",
      workspaceRoot: "C:\\Users\\Alice\\work\\dsh_bash",
      gitBashPath,
      pathExists: () => true,
      gitBashFs,
      probe,
    });

    expect(report.checks.find((check) => check.id === "wsl2")?.status).toBe("pass");
    const bwrapArgv = probe.mock.calls.find(([, argv]) => argv.includes("/usr/bin/bwrap"))?.[1];
    expect(bwrapArgv).toEqual(expect.arrayContaining([
      "--tmpfs", "/run", "--unsetenv", "WSL_INTEROP",
     "--unsetenv", "WSLENV", "--cap-drop", "ALL", "--disable-userns",
      "--unshare-user",
   ]));
    expect(bwrapArgv?.join(" ")).toContain("/mnt/c/Windows/System32/cmd.exe");
      const listCall = probe.mock.calls.find(([, argv]) => argv[0] === "-l");
      expect(listCall?.[3]?.env).toMatchObject({ WSL_UTF8: "1" });
  });

    it("uses a successful direct Unicode distro launch instead of trusting a damaged list", async () => {
      const distro = "Ubuntu-开发";
      const probe = vi.fn(async (_executable: string, argv: readonly string[]) => {
        if (argv[0] === "-l") {
          return { exitCode: 0, stdout: "Ubuntu-_�S\r\n", stderr: "" };
        }
        if (argv.includes("/bin/uname")) {
          return { exitCode: 0, stdout: "Linux 6.1 WSL2", stderr: "" };
        }
        if (argv.includes("/usr/bin/wslpath")) {
          return { exitCode: 0, stdout: "/mnt/c/workspace\r\n", stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      });

      const report = await runDoctor({
        platform: "win32",
        dshVersion: "0.2.2-alpha.2",
        wslExecutable: "C:\\Windows\\System32\\wsl.exe",
        distro,
        workspaceRoot: "C:\\workspace",
        gitBashPath: "C:\\Program Files\\Git\\bin\\bash.exe",
        pathExists: () => true,
        gitBashFs: {
          statSync: () => ({ isFile: () => true }),
          accessSync: vi.fn(),
          realpathSync: Object.assign((path: string) => path, { native: (path: string) => path }),
        } as unknown as GitBashFs,
        probe,
      });

      expect(report.ok).toBe(true);
      expect(report.checks.find((check) => check.id === "wsl2")?.detail).toMatch(/started successfully/);
    });

  it("checks Git Bash even when the WSL probes fail", async () => {
    const gitBashPath = "C:\\Program Files\\Git\\bin\\bash.exe";
    const gitBashFs = {
      statSync: () => ({ isFile: () => true }),
      accessSync: vi.fn(),
      realpathSync: Object.assign(
        (path: string) => path,
        { native: (path: string) => path },
      ),
    } as unknown as GitBashFs;
    const probe = vi.fn(async (executable: string) => {
      if (executable === gitBashPath) {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      return {
        exitCode: 1,
        stdout: "",
        stderr: "WSL unavailable",
        failure: "WSL unavailable",
      };
    });

    const report = await runDoctor({
      platform: "win32",
      dshVersion: "0.2.2-alpha.2",
      wslExecutable: "C:\\Windows\\System32\\wsl.exe",
      distro: "Ubuntu",
      workspaceRoot: "C:\\Users\\Alice\\work\\dsh_bash",
      gitBashPath,
      pathExists: () => true,
      gitBashFs,
      probe,
    });

    expect(report.checks.find((check) => check.id === "wsl2")?.status).toBe("fail");
    expect(report.checks.find((check) => check.id === "git-bash")?.status).toBe("pass");
    expect(probe).toHaveBeenCalledWith(
      gitBashPath,
      ["--noprofile", "--norc", "-c", "test -x /usr/bin/env"],
      20_000,
    );
  });
});
