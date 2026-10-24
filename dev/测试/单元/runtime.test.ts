import { describe, expect, it } from "vitest";

import {
  assertSupportedDshVersion,
  SUPPORTED_DSH_VERSIONS,
} from "../../../src/runtime.js";

describe("DSH runtime compatibility", () => {
  it("accepts the exact current host contract", () => {
    for (const version of SUPPORTED_DSH_VERSIONS) {
      expect(() => assertSupportedDshVersion(version)).not.toThrow();
    }
  });

  it("fails closed for legacy and unknown host versions", () => {
    for (const version of ["0.1.0-rc.6", "0.1.0-rc.5", "0.2.1-rc.2", "0.2.1-rc.4", "0.2.1", "unknown"]) {
      expect(() => assertSupportedDshVersion(version)).toThrow(
        "supports DSH 0.2.1-rc.3 only",
      );
    }
  });
});
