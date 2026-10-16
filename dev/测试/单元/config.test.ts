import { describe, expect, it } from "vitest";

import { DEFAULT_CONFIG, resolveConfig } from "../../../src/config.js";

describe("configuration security contract", () => {
  it("uses Ubuntu, a clean shell, bounded output, and bounded timeouts by default", () => {
    expect(DEFAULT_CONFIG.backendType).toBe("wsl");
    expect(DEFAULT_CONFIG.distro).toBe("Ubuntu");
    expect(DEFAULT_CONFIG.shellPath).toBe("/bin/bash");
    expect(DEFAULT_CONFIG.shellArgs).toEqual(["--noprofile", "--norc", "-i"]);
    expect(DEFAULT_CONFIG.oneShotMaxSpillBytes).toBe(64 * 1024 * 1024);
    expect(DEFAULT_CONFIG.oneShotMaxOutputBytes).toBeLessThanOrEqual(
      DEFAULT_CONFIG.oneShotMaxSpillBytes,
    );
  });

  it("clones shellArgs so callers cannot mutate the default", () => {
    const resolved = resolveConfig();
    expect(resolved.shellArgs).toEqual(DEFAULT_CONFIG.shellArgs);
    expect(resolved.shellArgs).not.toBe(DEFAULT_CONFIG.shellArgs);
    expect(Object.isFrozen(resolved)).toBe(true);
  });

  it.each([
    ["rows", 0],
    ["cols", -1],
    ["scrollbackLines", Number.NaN],
    ["scrollbackMaxBytes", 1.2],
    ["maxReadBytes", Number.POSITIVE_INFINITY],
    ["timeoutMs", 0],
    ["oneShotTimeoutMs", -1],
  ] as const)("rejects invalid %s", (field, value) => {
    expect(() => resolveConfig({ [field]: value })).toThrow(field);
  });

  it("rejects an output memory budget larger than the spill cap", () => {
    expect(() =>
      resolveConfig({
        oneShotMaxOutputBytes: 2,
        oneShotMaxSpillBytes: 1,
      }),
    ).toThrow(/oneShotMaxOutputBytes/);
  });

  it("rejects a read window larger than the persistent scrollback cap", () => {
    expect(() =>
      resolveConfig({
        maxReadBytes: 2,
        scrollbackMaxBytes: 1,
      }),
    ).toThrow(/maxReadBytes/);
  });

  it("rejects NUL bytes in shell args before a spawn seam is reached", () => {
    expect(() => resolveConfig({ shellArgs: ["--norc\0--login"] })).toThrow(
      /NUL/,
    );
  });
});
