import type { PathLike } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  canonicalGitBashPath,
  gitBashCandidates,
  rejectUnsafeWindowsPath,
  resolveGitBashPath,
  type GitBashFs,
} from "../src/discovery/git-bash.js";
import {
  resolveWslExecutable,
  resolveWslWorkspacePaths,
} from "../src/discovery/wsl.js";

function fakeFs(existing: readonly string[]): GitBashFs {
  const files = new Set(existing.map((value) => value.toLowerCase()));
  return {
    statSync(path: PathLike) {
      if (!files.has(String(path).toLowerCase())) throw new Error("ENOENT");
      return { isFile: () => true } as ReturnType<GitBashFs["statSync"]>;
    },
    accessSync(path: PathLike) {
      if (!files.has(String(path).toLowerCase())) throw new Error("EACCES");
    },
    realpathSync: Object.assign(
      (path: string) => {
        if (!files.has(path.toLowerCase())) throw new Error("ENOENT");
        return path;
      },
      {
        native: (path: string) => {
          if (!files.has(path.toLowerCase())) throw new Error("ENOENT");
          return path;
        },
      },
    ) as GitBashFs["realpathSync"],
  } as unknown as GitBashFs;
}

describe("Git Bash discovery", () => {
  it("rejects UNC and device paths before filesystem access", () => {
    for (const value of [
      "\\\\server\\share\\Git\\bin\\bash.exe",
      "\\\\?\\C:\\Git\\bin\\bash.exe",
      "\\\\.\\PIPE\\bash.exe",
    ]) {
      expect(() => rejectUnsafeWindowsPath(value)).toThrow(
        /UNC|device|namespace/i,
      );
    }
  });

  it("rejects drive-relative and non-absolute paths", () => {
    expect(() => rejectUnsafeWindowsPath("C:Git\\bin\\bash.exe")).toThrow(
      /absolute/i,
    );
    expect(() => rejectUnsafeWindowsPath("Git\\bin\\bash.exe")).toThrow(
      /absolute/i,
    );
  });

  it("requires a local bash.exe file and canonicalizes it", () => {
    const path = "C:\\Program Files\\Git\\bin\\bash.exe";
    expect(canonicalGitBashPath(path, fakeFs([path]))).toBe(path);
    expect(() => canonicalGitBashPath(path, fakeFs([]))).toThrow(
      /does not exist|executable/i,
    );
    expect(() => canonicalGitBashPath("C:\\Program Files\\Git\\bin\\sh.exe", fakeFs([]))).toThrow();
  });

  it("keeps configured/env overrides ahead of discovery candidates", () => {
    const configured = "D:\\Tools\\Git\\bin\\bash.exe";
    const env = {
      DSH_GIT_BASH_PATH: configured,
      ProgramFiles: "C:\\Program Files",
    };
    expect(
      resolveGitBashPath(undefined, {
        platform: "win32",
        env,
        fsImpl: fakeFs([configured]),
      }),
    ).toBe(configured);
  });

  it("does not use a bare arbitrary bash.exe from PATH", () => {
    const candidates = gitBashCandidates({ PATH: "C:\\attacker;D:\\Git\\cmd" });
    expect(candidates.some((candidate) => /attacker.*bash\.exe$/i.test(candidate))).toBe(false);
  });

  it("does not mistake an ordinary user's nested workspace for a broad root", () => {
    expect(
      resolveWslWorkspacePaths("C:\\Users\\Alice\\work\\dsh_bash", "src"),
    ).toEqual({
      workspaceRoot: "/mnt/c/Users/Alice/work/dsh_bash",
      cwd: "/mnt/c/Users/Alice/work/dsh_bash/src",
    });
  });

  it("does not allow evil.exe to masquerade as wsl.exe", () => {
    expect(() =>
      resolveWslExecutable({
        platform: "win32",
        executable: "C:\\Windows\\System32\\evil.exe",
      }),
    ).toThrow(/wsl\.exe/i);
  });

  it("resolves the legacy bare WSL setting to SystemRoot instead of PATH", () => {
    expect(
      resolveWslExecutable({
        platform: "win32",
        executable: "wsl.exe",
        env: { SystemRoot: "D:\\Windows" },
      }),
    ).toBe("D:\\Windows\\System32\\wsl.exe");
  });
});
