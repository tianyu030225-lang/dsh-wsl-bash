import { createRequire } from "node:module";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import type { SubprocessRuntime } from "@deepseek-ai/dsh-subprocess";

import { runSubprocessForeground } from "../../../src/tools/process.js";

const HOST_VERSION = "0.2.2-alpha.2";

type OutputCollectorLike = {
  push(chunk: Buffer): void;
  readFrom(fromByte: number): {
    text: string;
    nextOffset: number;
    lossy: boolean;
    spillPath?: string;
  };
};

async function loadCurrentHostOutputCollector(): Promise<
  new (maxBytes: number, label: string, spill?: unknown) => OutputCollectorLike
> {
  // Resolve through the installed alpha.2 host anchor and its package graph. Do
  // not pick the first similarly named .pnpm directory: the tree also carries
  // a second dsh-subprocess peer instance without the local collector.
  const installAnchor = realpathSync(join(
    process.cwd(),
    "node_modules",
    "@deepseek-ai",
    "dsh",
    "package.json",
  ));
  const readManifest = (path: string): { name?: string; version?: string } =>
    JSON.parse(readFileSync(path, "utf8")) as {
      name?: string;
      version?: string;
    };
  const hostManifest = readManifest(installAnchor);
  if (hostManifest.name !== "@deepseek-ai/dsh" ||
    hostManifest.version !== HOST_VERSION) {
    throw new Error(
      `unexpected DSH install anchor: ${hostManifest.name}@${hostManifest.version}`,
    );
  }
  const hostRequire = createRequire(installAnchor);
  const baseAnchor = realpathSync(
    hostRequire.resolve("@deepseek-ai/dsh-base/package.json"),
  );
  const baseManifest = readManifest(baseAnchor);
  if (baseManifest.name !== "@deepseek-ai/dsh-base" ||
    baseManifest.version !== HOST_VERSION) {
    throw new Error(
      `unexpected DSH base package: ${baseManifest.name}@${baseManifest.version}`,
    );
  }
  const baseRequire = createRequire(baseAnchor);
  const subprocessAnchor = realpathSync(
    baseRequire.resolve("@deepseek-ai/dsh-subprocess/package.json"),
  );
  const subprocessManifest = readManifest(subprocessAnchor);
  if (subprocessManifest.name !== "@deepseek-ai/dsh-subprocess" ||
    subprocessManifest.version !== HOST_VERSION) {
    throw new Error(
      `unexpected subprocess package: ${subprocessManifest.name}@${subprocessManifest.version}`,
    );
  }
  const localAnchor = realpathSync(
    baseRequire.resolve("@deepseek-ai/dsh-subprocess-local/package.json"),
  );
  const localManifest = readManifest(localAnchor);
  if (localManifest.name !== "@deepseek-ai/dsh-subprocess-local" ||
    localManifest.version !== HOST_VERSION) {
    throw new Error(
      `unexpected local subprocess package: ${localManifest.name}@${localManifest.version}`,
    );
  }
  const modulePath = realpathSync(
    baseRequire.resolve("@deepseek-ai/dsh-subprocess-local/output"),
  );
  const module = await import(pathToFileURL(modulePath).href) as {
    OutputCollector: new (
      maxBytes: number,
      label: string,
      spill?: unknown,
    ) => OutputCollectorLike;
  };
  return module.OutputCollector;
}

async function runWithCollectedOutput(options: {
  memoryLimit: number;
  stdout: readonly Buffer[];
  stderr: readonly Buffer[];
}): Promise<Awaited<ReturnType<typeof runSubprocessForeground>>> {
  const OutputCollector = await loadCurrentHostOutputCollector();
  const stdout = new OutputCollector(options.memoryLimit, "stdout");
  const stderr = new OutputCollector(options.memoryLimit, "stderr");
  for (const chunk of options.stdout) stdout.push(chunk);
  for (const chunk of options.stderr) stderr.push(chunk);
  const subprocess = {
    spawn() {
      return {
        done: Promise.resolve({ exitCode: 0, signal: null }),
        waitForExit: async () => undefined,
        collected: { stdout, stderr },
      };
    },
  } as unknown as SubprocessRuntime;
  return runSubprocessForeground({
    executable: "fixture",
    argv: [],
    subprocess,
    memoryLimit: options.memoryLimit,
    spillLimit: options.memoryLimit,
  });
}

describe("managed subprocess output visible-byte contract", () => {
  it("keeps invalid UTF-8 expansion within the adapter memory cap and marks truncation", async () => {
    const result = await runWithCollectedOutput({
      memoryLimit: 4,
      stdout: [Buffer.from([0xff, 0xff, 0xff, 0xff])],
      stderr: [],
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.totalBytes).toBe(4);
    expect(Buffer.byteLength(result.stdout.text, "utf8")).toBeLessThanOrEqual(4);
    expect(result.stdout.truncated).toBe(true);
  });

  it("adapts stdout and stderr independently without local-only clip metadata", async () => {
    const result = await runWithCollectedOutput({
      memoryLimit: 16,
      stdout: [Buffer.from("stdout")],
      stderr: [Buffer.from("stderr")],
    });

    expect(result.stdout).toEqual({
      text: "stdout",
      truncated: false,
      totalBytes: 6,
    });
    expect(result.stderr).toEqual({
      text: "stderr",
      truncated: false,
      totalBytes: 6,
    });
  });

  it("keeps a cap-of-one tail bounded for both malformed and ordinary bytes", async () => {
    const result = await runWithCollectedOutput({
      memoryLimit: 1,
      stdout: [Buffer.from([0xff])],
      stderr: [Buffer.from("AB")],
    });

    expect(result.stdout.text).toBe("");
    expect(result.stdout.totalBytes).toBe(1);
    expect(result.stdout.truncated).toBe(true);
    expect(Buffer.byteLength(result.stdout.text, "utf8")).toBeLessThanOrEqual(1);
    expect(result.stderr).toEqual({
      text: "B",
      truncated: true,
      totalBytes: 2,
    });
  });

  it("preserves normal ASCII and split UTF-8 text across collector chunks", async () => {
    const result = await runWithCollectedOutput({
      memoryLimit: 8,
      stdout: [Buffer.from("ascii"), Buffer.from("-ok")],
      stderr: [
        Buffer.from([0xe4]),
        Buffer.from([0xb8, 0xad]),
        Buffer.from([0xe6, 0x96, 0x87]),
      ],
    });

    expect(result.stdout).toEqual({
      text: "ascii-ok",
      truncated: false,
      totalBytes: 8,
    });
    expect(result.stderr).toEqual({
      text: "中文",
      truncated: false,
      totalBytes: 6,
    });
  });

  it("keeps the original lossy flag and absolute cursor for a retained tail", async () => {
    const result = await runWithCollectedOutput({
      memoryLimit: 4,
      stdout: [Buffer.from("abcdef")],
      stderr: [Buffer.from("123456")],
    });

    expect(result.stdout).toEqual({
      text: "cdef",
      truncated: true,
      totalBytes: 6,
    });
    expect(result.stderr).toEqual({
      text: "3456",
      truncated: true,
      totalBytes: 6,
    });
  });
});
