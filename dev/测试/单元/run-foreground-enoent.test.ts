import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { runForeground } from "../../../src/tools/process.js";

const artifactRoot = resolve(process.cwd(), "测试", "运行产物");
const temporaryRoots: string[] = [];

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("runForeground spawn-error lifecycle", () => {
  it("resolves a structured ENOENT result for a missing absolute executable", async () => {
    await mkdir(artifactRoot, { recursive: true });
    const root = await mkdtemp(join(artifactRoot, "run-foreground-enoent-"));
    temporaryRoots.push(root);
    const missingExecutable = join(root, "missing-command.exe");

    const result = await runForeground({
      executable: missingExecutable,
      argv: [],
      timeoutMs: 5_000,
    });

    expect(result.failure?.kind).toBe("spawn-error");
    expect(result.failure?.code).toBe("ENOENT");
    // Windows Node reports ERROR_FILE_NOT_FOUND (`-4058`); POSIX Node commonly
    // reports `-2`. The structured spawn failure above is the stable contract.
    expect([null, -2, -4058]).toContain(result.exitCode);
    expect(result.signal).toBeNull();
    expect(result.timedOut).toBe(false);
    expect(result.aborted).toBe(false);
    expect(result.stdout.text).toBe("");
    expect(result.stderr.text).toBe("");
  });
});
