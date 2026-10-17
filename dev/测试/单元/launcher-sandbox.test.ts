import { describe, expect, it } from "vitest";

import { resolveConfig } from "../../../src/config.js";
import { buildWslLaunchPlan } from "../../../src/wsl/launcher.js";
import { buildBwrapArgs } from "../../../src/wsl/sandbox.js";
import type { WslExecutionBoundary } from "../../../src/types.js";

const config = resolveConfig();

describe("WSL path and sandbox boundaries", () => {
  it("does not let model workdir replace the policy workspace root", async () => {
    const boundary: WslExecutionBoundary = {
      mode: "workspace-write",
      workspaceRoot: "C:\\Users\\Alice\\work\\dsh_bash",
      workdir: "src\\with spaces",
    };

    const plan = await buildWslLaunchPlan(config, boundary);
    expect(plan.workspaceRootLinux).not.toBe(plan.workdirLinux);
    expect(plan.workspaceRootLinux).toContain("/mnt/c/");
    expect(plan.workdirLinux).toContain("with spaces");
    expect(plan.mode).toBe("workspace-write");

    const args = buildBwrapArgs({
      mode: plan.mode,
      workspaceRootLinux: plan.workspaceRootLinux,
      workdirLinux: plan.workdirLinux,
      command: "/bin/bash",
      args: ["--noprofile", "--norc", "-i"],
    });
    const bindIndex = args.indexOf("--bind");
    expect(bindIndex).toBeGreaterThanOrEqual(0);
    expect(args[bindIndex + 1]).toBe(plan.workspaceRootLinux);
    expect(args[bindIndex + 2]).toBe(plan.workspaceRootLinux);
    expect(args).toContain("--chdir");
    expect(args).toContain(plan.workdirLinux);
  });

  it.each([
    "/",
    "/mnt",
    "/mnt/c",
    "/tmp",
    "C:\\",
    "C:\\Users",
    "\\\\server\\share\\repo",
    "\\\\?\\C:\\repo",
  ])("rejects broad or remote workspace root %s", async (workspaceRoot) => {
    await expect(
      buildWslLaunchPlan(config, {
        mode: "workspace-write",
        workspaceRoot,
        workdir: ".",
      }),
    ).rejects.toThrow();
  });

  it("rejects a workdir that escapes through parent segments", async () => {
    await expect(
      buildWslLaunchPlan(config, {
        mode: "workspace-write",
        workspaceRoot: "C:\\Users\\Alice\\work\\dsh_bash",
        workdir: "..\\outside",
      }),
    ).rejects.toThrow(/workspace|contain|outside|root/i);
  });

  it("keeps read-only mode from adding a writable bind", () => {
    const args = buildBwrapArgs({
      mode: "read-only",
      workspaceRootLinux: "/mnt/c/Users/Alice/work/dsh_bash",
      workdirLinux: "/mnt/c/Users/Alice/work/dsh_bash/src",
      command: "/bin/bash",
      args: ["-c", "printf '%s' ok"],
    });
    expect(args).not.toContain("--bind");
    expect(args).toContain("--ro-bind");
    expect(args).toContain("--tmpfs");
    expect(args).toContain("/run");
    expect(args).toContain("/tmp");
    expect(args).toContain("--unsetenv");
   expect(args).toContain("WSL_INTEROP");
   expect(args).toContain("WSLENV");
    expect(args).toContain("--cap-drop");
    expect(args).toContain("ALL");
    expect(args).toContain("--disable-userns");
 });

  it("does not build an outer shell around command argv", () => {
    const args = buildBwrapArgs({
      mode: "workspace-write",
      workspaceRootLinux: "/mnt/c/Users/Alice/work/dsh_bash",
      workdirLinux: "/mnt/c/Users/Alice/work/dsh_bash",
      command: "/bin/bash",
      args: ["-c", "printf '%s' \"$(touch SHOULD_NOT_RUN)\""],
    });
    expect(args.at(-2)).toBe("-c");
    expect(args.at(-1)).toContain("SHOULD_NOT_RUN");
    expect(args).not.toContain("sh");
    expect(args).not.toContain("-c echo");
  });

  it.each(["read-only", "workspace-write"] as const)(
    "removes WSL host interop from restricted %s sandboxes",
    (mode) => {
      const args = buildBwrapArgs({
        mode,
        workspaceRootLinux: "/mnt/c/Users/Alice/work/dsh_bash",
        workdirLinux: "/mnt/c/Users/Alice/work/dsh_bash",
        command: "/bin/true",
        args: [],
      });
      expect(args).toContain("--tmpfs");
      expect(args).toContain("/run");
     expect(args).toContain("--unsetenv");
     expect(args).toContain("WSL_INTEROP");
     expect(args).toContain("WSLENV");
      expect(args).toContain("--cap-drop");
      expect(args).toContain("--unshare-user");
      expect(args).toContain("--disable-userns");
   },
  );

  it("retains WSL host interop only for explicit danger-full-access", () => {
    const args = buildBwrapArgs({
      mode: "danger-full-access",
      workspaceRootLinux: "/mnt/c/Users/Alice/work/dsh_bash",
      workdirLinux: "/mnt/c/Users/Alice/work/dsh_bash",
      command: "/bin/true",
      args: [],
    });
    expect(args).toContain("--bind");
    expect(args).toEqual(expect.arrayContaining([
      "--unsetenv", "BASH_ENV", "--unsetenv", "ENV", "--setenv", "SHELL", "/bin/bash",
    ]));
    expect(args).not.toContain("WSL_INTEROP");
    expect(args).not.toContain("WSLENV");
    expect(args).not.toContain("--tmpfs");
  });
});
