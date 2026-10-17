import { describe, expect, it } from "vitest";

import {
  cleanWslBashArgv,
  filteredWslEnv,
  sanitizedWslHostEnvironment,
  wslHostEnvironmentOverrides,
} from "../../../src/wsl/bootstrap.js";
import { buildBwrapArgs } from "../../../src/wsl/sandbox.js";

describe("WSL Bash bootstrap environment", () => {
  it("removes Bash startup controls without discarding unrelated WSLENV entries", () => {
    expect(filteredWslEnv("KEEP/p:BASH_ENV/p:ENV/u:SHELL:SOME_LIST/l")).toBe("KEEP/p:SOME_LIST/l");
    expect(wslHostEnvironmentOverrides({ WSLENV: "KEEP/p:BASH_ENV/p" })).toMatchObject({
      BASH_ENV: undefined,
      ENV: undefined,
      SHELLOPTS: undefined,
      BASHOPTS: undefined,
      SHELL: undefined,
      WSLENV: "KEEP/p",
    });
    expect(sanitizedWslHostEnvironment({
      PATH: "safe-path",
      BASH_ENV: "C:\\workspace\\startup.bash",
      WSLENV: "BASH_ENV/p:KEEP/p",
    })).toEqual({ PATH: "safe-path", WSLENV: "KEEP/p" });
  });

  it("removes startup variables before invoking the fixed Bash", () => {
    const argv = cleanWslBashArgv("printf ok");
    const bashIndex = argv.indexOf("/bin/bash");
    expect(bashIndex).toBeGreaterThan(0);
    for (const name of ["BASH_ENV", "ENV", "SHELLOPTS", "BASHOPTS", "CDPATH", "GLOBIGNORE"]) {
      expect(argv.slice(0, bashIndex)).toEqual(expect.arrayContaining(["-u", name]));
    }
    expect(argv.slice(0, bashIndex)).toContain("SHELL=/bin/bash");
  });

  it.each(["read-only", "workspace-write", "danger-full-access"] as const)(
    "cleans the bwrap child environment in %s mode",
    (mode) => {
      const argv = buildBwrapArgs({
        mode,
        workspaceRootLinux: "/mnt/c/workspace/repo",
        workdirLinux: "/mnt/c/workspace/repo",
        command: "/bin/bash",
        args: ["-c", "exit 0"],
      });
      const separator = argv.indexOf("--");
      expect(separator).toBeGreaterThan(0);
      const metadata = argv.slice(0, separator);
      expect(metadata).toEqual(expect.arrayContaining([
        "--unsetenv", "BASH_ENV", "--unsetenv", "ENV",
        "--setenv", "SHELL", "/bin/bash",
      ]));
    },
  );
});
