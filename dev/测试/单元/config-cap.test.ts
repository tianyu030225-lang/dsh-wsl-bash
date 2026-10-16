import { describe, expect, it } from "vitest";

import { resolveConfig } from "../../../src/config.js";

const OUTPUT_SPILL_CAP = 64 * 1024 * 1024;

describe("one-shot output safety cap", () => {
  it("accepts the exact 64 MiB spill boundary without widening the memory cap", () => {
    const config = resolveConfig({
      oneShotMaxOutputBytes: OUTPUT_SPILL_CAP,
      oneShotMaxSpillBytes: OUTPUT_SPILL_CAP,
    });

    expect(config.oneShotMaxSpillBytes).toBe(OUTPUT_SPILL_CAP);
    expect(config.oneShotMaxOutputBytes).toBeLessThanOrEqual(
      config.oneShotMaxSpillBytes,
    );
  });

  it("rejects a spill cap above 64 MiB", () => {
    expect(() =>
      resolveConfig({ oneShotMaxSpillBytes: OUTPUT_SPILL_CAP + 1 }),
    ).toThrow(/64MiB output safety cap/);
  });
});
