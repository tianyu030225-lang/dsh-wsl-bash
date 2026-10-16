import { describe, expect, it, vi } from "vitest";
import type { SubprocessHandle, SubprocessRuntime } from "@deepseek-ai/dsh-subprocess";

import { executeWslBash } from "../../../src/tools/wsl-bash.js";

function subprocessHandle(stdoutText: string): SubprocessHandle {
  const reader = {
    readFrom: vi.fn(() => ({
      text: stdoutText,
      nextOffset: Buffer.byteLength(stdoutText),
      lossy: false,
    })),
  };
  return {
    stdin: undefined,
    stdout: undefined,
    stderr: undefined,
    control: undefined,
    collected: { stdout: reader, stderr: { readFrom: vi.fn(() => ({ text: "", nextOffset: 0, lossy: false })) } },
    done: Promise.resolve({ exitCode: 0, signal: null }),
    terminate: vi.fn(),
    waitForExit: vi.fn(async () => true),
  };
}

describe("WSL realpath output framing", () => {
  it("rejects a successful-looking canonicalization result without the final newline", async () => {
    const handle = subprocessHandle(
      "/mnt/c/Users/Alice/work/dsh 插件 测试\n/mnt/c/Users/Alice/work/dsh 插件 测试/sub dir",
    );
    const spawn = vi.fn(() => handle);

    const result = await executeWslBash(
      { command: "printf ok", description: "local framing test" },
      {
        policy: {
          mode: "workspace-write",
          workspaceRoot: "C:\\Users\\Alice\\work\\dsh 插件 测试",
        },
        platform: "win32",
        executable: "C:\\Windows\\System32\\wsl.exe",
        distro: "Ubuntu",
        subprocess: { spawn } as unknown as SubprocessRuntime,
      },
    );

    expect(result.failure?.kind).toBe("sandbox-unavailable");
    expect(result.stderr.text).toMatch(/invalid framing/i);
    expect(spawn).toHaveBeenCalledTimes(1);
  });
});
