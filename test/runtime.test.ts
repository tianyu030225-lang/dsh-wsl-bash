import { describe, expect, it } from "vitest";

import {
  assertSupportedDshVersion,
  SUPPORTED_DSH_VERSION,
} from "../src/runtime.js";

describe("DSH runtime compatibility", () => {
  it("accepts the exact rc.6 host contract", () => {
    expect(() => assertSupportedDshVersion(SUPPORTED_DSH_VERSION)).not.toThrow();
  });

  it("fails closed for a different host version", () => {
    expect(() => assertSupportedDshVersion("0.1.0-rc.5")).toThrow(
      "supports DSH 0.1.0-rc.6 only",
    );
  });
});
