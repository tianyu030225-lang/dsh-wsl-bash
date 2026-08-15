import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type SpawnOptions } from "node:child_process";
import { describe, expect, it } from "vitest";

import {
  BoundedCapture,
  DEFAULT_MEMORY_LIMIT,
  DEFAULT_SPILL_LIMIT,
  renderCapturedOutput,
} from "../src/tools/output.js";
import { runForeground, runSubprocessForeground } from "../src/tools/process.js";
import type { SubprocessHandle, SubprocessRuntime } from "@deepseek-ai/dsh-subprocess";

describe("bounded output capture", () => {
  it("keeps UTF-8 boundaries while retaining only a bounded tail", () => {
    const capture = new BoundedCapture({ memoryLimit: 7, spillLimit: 64 });
    capture.append(Buffer.from("前缀"));
    capture.append(Buffer.from("-middle-后缀"));
    const result = capture.end();

    expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(7);
    expect(result.text).not.toContain("�");
    expect(result.truncated).toBe(true);
  });

  it("uses a 64 MiB hard spill cap by default", () => {
    expect(DEFAULT_SPILL_LIMIT).toBe(64 * 1024 * 1024);
    expect(DEFAULT_MEMORY_LIMIT).toBeGreaterThan(0);
  });

  it("marks spill overflow instead of retaining unbounded output", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dsh-bash-output-"));
    try {
      const capture = new BoundedCapture({
        memoryLimit: 16,
        spillLimit: 64,
        spillDirectory: directory,
        streamName: "regression",
      });
      capture.append("x".repeat(1024));
      const result = capture.end();
      expect(result.truncated).toBe(true);
      expect(result.overflowed).toBe(true);
      expect(result.spillBytes).toBe(64);
      expect(result.spillPath).toBeDefined();
      expect((await readFile(result.spillPath!)).byteLength).toBe(64);
      expect(renderCapturedOutput(result)).toMatch(/output truncated/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("foreground process seam", () => {
  it("passes command data as argv with shell=false", async () => {
    const payload = "value with spaces; $(touch SHOULD_NOT_RUN) `id`";
    const calls: Array<{ executable: string; argv: readonly string[]; shell: unknown }> = [];
    const spawnImpl = ((executable: string, argv: readonly string[], options: SpawnOptions) => {
      calls.push({ executable, argv, shell: options?.shell });
      return spawn(executable, argv, options);
    }) as unknown as typeof spawn;

    const result = await runForeground({
      executable: process.execPath,
      argv: ["-e", "process.stdout.write(process.argv[1] ?? '')", payload],
      spawnImpl,
      timeoutMs: 5_000,
    });

    expect(result.failure).toBeUndefined();
    expect(result.exitCode).toBe(0);
    expect(result.stdout.text).toBe(payload);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.shell).toBe(false);
    expect(calls[0]?.argv).toEqual([
      "-e",
      "process.stdout.write(process.argv[1] ?? '')",
      payload,
    ]);
  });

  it("reports timeout and kills the child", async () => {
    const result = await runForeground({
      executable: process.execPath,
      argv: ["-e", "setTimeout(() => {}, 10_000)"],
      timeoutMs: 50,
    });

    expect(result.timedOut).toBe(true);
    expect(result.failure?.kind).toBe("timeout");
  });

  it("reports cancellation and kills the child", async () => {
    const controller = new AbortController();
    const pending = runForeground({
      executable: process.execPath,
      argv: ["-e", "setTimeout(() => {}, 10_000)"],
      timeoutMs: 5_000,
      signal: controller.signal,
    });
    controller.abort();
    const result = await pending;

    expect(result.aborted).toBe(true);
    expect(result.failure?.kind).toBe("aborted");
  });

  it("rejects invalid timeout before invoking spawn", async () => {
    let called = false;
    const spawnImpl = (() => {
      called = true;
      throw new Error("must not spawn");
    }) as unknown as typeof spawn;

    await expect(
      runForeground({
        executable: process.execPath,
        argv: [],
        timeoutMs: 0,
        spawnImpl,
      }),
    ).rejects.toThrow(/timeout/);
    expect(called).toBe(false);
  });

  it("times out and cleans up an official subprocess tree", async () => {
    let finish!: () => void;
    const done = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => {
        finish = () => resolve({ exitCode: null, signal: "SIGTERM" });
      },
    );
    const handle: SubprocessHandle = {
      pid: 7070,
      stdin: undefined,
      stdout: undefined,
      stderr: undefined,
      collected: {},
      done,
      terminate: (() => {
        finish();
      }) as SubprocessHandle["terminate"],
      waitForExit: async () => true,
    };
    const subprocess = {
      spawn: ((spec) => {
        spec.signal?.addEventListener("abort", () => handle.terminate(), { once: true });
        return handle;
      }) as SubprocessRuntime["spawn"],
    } as unknown as SubprocessRuntime;

    const result = await runSubprocessForeground({
      executable: "C:\\Windows\\System32\\wsl.exe",
      argv: ["-l", "-q"],
      timeoutMs: 20,
      subprocess,
    });

    expect(result.timedOut).toBe(true);
    expect(result.failure?.kind).toBe("timeout");
  });
});
