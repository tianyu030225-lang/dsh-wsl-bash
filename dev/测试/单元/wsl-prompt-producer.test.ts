import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type {
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessSpawnSpec,
} from "@deepseek-ai/dsh-subprocess";

import { resolveConfig } from "../../../src/config.js";
import { WslTerminalBackend } from "../../../src/wsl/backend.js";

const CONTROLLED_PROMPT = "__DSH_PERSISTENT_BASH_PROMPT__ ";
const CONTROLLED_PROMPT_FRAME = `\u001b]133;D;0\u0007${CONTROLLED_PROMPT}`;
const CONTROLLED_PROMPT_COMMAND =
  '__dsh_status=$?; PS1=""; printf "\\033]133;D;%s\\007__DSH_PERSISTENT_BASH_PROMPT__ " "$__dsh_status"';

function outputReader(text: string) {
  return {
    readFrom: vi.fn(() => ({
      text,
      nextOffset: Buffer.byteLength(text),
      lossy: false,
    })),
  };
}

function completedSubprocess(text: string): SubprocessHandle {
  return {
    stdin: undefined,
    stdout: undefined,
    stderr: undefined,
    control: undefined,
    collected: {
      stdout: outputReader(text),
      stderr: outputReader(""),
    },
    done: Promise.resolve({ exitCode: 0, signal: null }),
    terminate: vi.fn(),
    waitForExit: vi.fn(async () => true),
  } as unknown as SubprocessHandle;
}

type LiveSubprocess = {
  handle: SubprocessHandle;
  stdinWrites: ReturnType<typeof vi.fn>;
  terminate: ReturnType<typeof vi.fn>;
  waitForExit: ReturnType<typeof vi.fn>;
};

function liveSubprocess(): LiveSubprocess {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let resolveDone!: (outcome: SubprocessOutcome) => void;
  let finished = false;
  const done = new Promise<SubprocessOutcome>((resolve) => {
    resolveDone = resolve;
  });
  const finish = (): void => {
    if (finished) return;
    finished = true;
    resolveDone({ exitCode: null, signal: "SIGTERM" });
    stdout.end();
    stderr.end();
  };
  const originalWrite = stdin.write.bind(stdin);
  const stdinWrites = vi.fn((chunk: string | Buffer, ...args: unknown[]) => {
    const accepted = (originalWrite as (...values: unknown[]) => boolean)(chunk, ...args);
    queueMicrotask(() => stdout.write(CONTROLLED_PROMPT_FRAME));
    return accepted;
  });
  (stdin as unknown as { write: typeof stdinWrites }).write = stdinWrites;
  const terminate = vi.fn(() => finish());
  const waitForExit = vi.fn(async () => {
    finish();
    return true;
  });
  return {
    handle: {
      stdin,
      stdout,
      stderr,
      control: undefined,
      collected: {},
      done,
      terminate,
      waitForExit,
    } as unknown as SubprocessHandle,
    stdinWrites,
    terminate,
    waitForExit,
  };
}

function quotedPosix(value: string): string {
  const singleQuoteReplacement = "'\"'\"'";
  return `'${value.replaceAll("'", singleQuoteReplacement)}'`;
}

function setenvMap(argv: readonly string[]): Map<string, string> {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length - 2; index += 1) {
    if (argv[index] === "--setenv") {
      const key = argv[index + 1];
      const value = argv[index + 2];
      if (key !== undefined && value !== undefined) values.set(key, value);
    }
  }
  return values;
}

function createBackendHarness(): {
  context: any;
  spawn: ReturnType<typeof vi.fn>;
  specs: SubprocessSpawnSpec[];
  live: LiveSubprocess;
  workspaceRoot: string;
  workdir: string;
} {
  const workspaceRoot = "C:\\Users\\Alice\\work\\dsh 插件测试";
  const workdir = `${workspaceRoot}\\子目录`;
  const specs: SubprocessSpawnSpec[] = [];
  let live: LiveSubprocess | undefined;
  const spawn = vi.fn((spec: SubprocessSpawnSpec) => {
    specs.push(spec);
    if (spec.argv.includes("/usr/bin/bwrap")) {
      live = liveSubprocess();
      queueMicrotask(() => (live as LiveSubprocess).handle.stdout?.emit("data", CONTROLLED_PROMPT_FRAME));
      return (live as LiveSubprocess).handle;
    }
    const linuxPath = spec.argv.at(-1);
    if (linuxPath === undefined) throw new Error("realpath fixture received no path");
    return completedSubprocess(`${linuxPath}\n`);
  });
  const context = {
    terminals: { hasOwnerActivity: vi.fn(() => false) },
    sandboxPolicy: {
      resolve: vi.fn(() => ({ mode: "workspace-write", workspaceRoot })),
    },
    subprocess: { spawn },
  };
  return {
    context,
    spawn,
    specs,
    get live() {
      if (live === undefined) throw new Error("live WSL subprocess was not created");
      return live;
    },
    workspaceRoot,
    workdir,
  } as unknown as {
    context: any;
    spawn: ReturnType<typeof vi.fn>;
    specs: SubprocessSpawnSpec[];
    live: LiveSubprocess;
    workspaceRoot: string;
    workdir: string;
  };
}

describe.skipIf(process.platform !== "win32")("WSL prompt producer backend contract", () => {
  it("emits one single-printf prompt frame in bwrap metadata and direct script env", async () => {
    const harness = createBackendHarness();
    const backend = new WslTerminalBackend(
      harness.context,
      resolveConfig({
        wslExecutable: "C:\\Windows\\System32\\wsl.exe",
        rows: 40,
        cols: 160,
        pollIntervalMs: 2,
        idleSilenceMs: 5,
        timeoutMs: 500,
        maxReadBytes: 4096,
        scrollbackMaxBytes: 4096,
      }),
    );
    const owner = { id: "producer-owner", session: {}, ctx: {} } as any;
    const session = await backend.spawn({
      type: "wsl",
      sessionId: "producer-session" as any,
      owner,
      cwd: harness.workdir,
      name: "producer-contract",
    });

    try {
      expect(harness.specs).toHaveLength(3);
      expect(harness.specs.slice(0, 2).map((spec) => spec.argv.slice(0, 4))).toEqual([
        ["C:\\Windows\\System32\\wsl.exe", "-d", "Ubuntu", "--exec"],
        ["C:\\Windows\\System32\\wsl.exe", "-d", "Ubuntu", "--exec"],
      ]);
      const finalSpec = harness.specs.find((spec) => spec.argv.includes("/usr/bin/bwrap"));
      expect(finalSpec).toBeDefined();
      if (finalSpec === undefined) throw new Error("bwrap launch was not observed");
      const finalEnv = finalSpec.env as Record<string, string>;
      const metadata = setenvMap(finalSpec.argv);
      expect(metadata.get("PROMPT_COMMAND")).toBe(CONTROLLED_PROMPT_COMMAND);
      expect(metadata.get("PS1")).toBe(CONTROLLED_PROMPT);
      expect(finalEnv.PROMPT_COMMAND).toBe(CONTROLLED_PROMPT_COMMAND);
      expect(finalEnv.PS1).toBe(CONTROLLED_PROMPT);
      expect(CONTROLLED_PROMPT_COMMAND).toContain('PS1=""; printf');
      expect(CONTROLLED_PROMPT_COMMAND).toContain("__DSH_PERSISTENT_BASH_PROMPT__ ");

      const separator = finalSpec.argv.indexOf("--");
      expect(separator).toBeGreaterThan(finalSpec.argv.indexOf("--setenv"));
      const scriptIndex = finalSpec.argv.indexOf("/usr/bin/script", separator + 1);
      expect(scriptIndex).toBeGreaterThan(separator);
      expect(finalSpec.argv[scriptIndex + 1]).toBe("-qefc");
      const directCommand = finalSpec.argv[scriptIndex + 2];
      expect(directCommand).toBeDefined();
      if (directCommand === undefined) throw new Error("script -c command was not observed");
      expect(directCommand).toContain("/usr/bin/stty rows 40 cols 160 && exec");
      for (const [key, value] of [
        ["TERM", "dumb"],
        ["PAGER", "cat"],
        ["GIT_PAGER", "cat"],
        ["PS1", CONTROLLED_PROMPT],
        ["PROMPT_COMMAND", CONTROLLED_PROMPT_COMMAND],
        ["BASH_SILENCE_DEPRECATION_WARNING", "1"],
        ["DSH_SHELL", "1"],
      ] as const) {
        expect(directCommand).toContain(quotedPosix(`${key}=${value}`));
        expect(metadata.get(key)).toBe(value);
      }
      expect(directCommand).toContain(quotedPosix("/bin/bash"));
      expect(directCommand).toContain(quotedPosix("--noprofile"));
      expect(directCommand).toContain(quotedPosix("--norc"));
      expect(directCommand).toContain(quotedPosix("-i"));
      expect(finalSpec.argv).toContain("--ro-bind");
      expect(finalSpec.argv).toContain("--bind");
      expect(finalSpec.argv).toContain("--chdir");
      expect(finalSpec.cwd).toBe(harness.workdir);

      const writes = harness.live.stdinWrites.mock.calls.map(([value]) => String(value));
      expect(writes).toContain("stty rows 40 cols 160; readonly PROMPT_COMMAND\r");
      expect(writes.some((value) => value.includes("readonly PROMPT_COMMAND"))).toBe(true);
    } finally {
      await session.close("producer contract cleanup");
      expect(harness.live.terminate).toHaveBeenCalledOnce();
      expect(harness.live.waitForExit).toHaveBeenCalled();
    }
  });
});

