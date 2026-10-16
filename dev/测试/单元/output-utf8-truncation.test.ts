import { describe, expect, it } from "vitest";

import { BoundedCapture, renderCapturedOutput } from "../../../src/tools/output.js";

describe("bounded output truncation after UTF-8 decoding", () => {
  it("marks an invalid trailing byte that expands after the byte cap", () => {
    const capture = new BoundedCapture({ memoryLimit: 4, spillLimit: 4 });
    capture.append(Buffer.from([0x41, 0x42, 0x43, 0xff]));

    const result = capture.end();

    expect(result.totalBytes).toBe(4);
    expect(result.text).toBe("C�");
    expect(result.truncated).toBe(true);
    expect(renderCapturedOutput(result)).toMatch(/output truncated/);
  });

  it("marks a lone invalid byte that decodes to a replacement character", () => {
    const capture = new BoundedCapture({ memoryLimit: 1, spillLimit: 1 });
    capture.append(Buffer.from([0xff]));

    const result = capture.end();

    expect(result.totalBytes).toBe(1);
    expect(result.text).toBe("");
    expect(result.truncated).toBe(true);
    expect(renderCapturedOutput(result)).toMatch(/output truncated/);
  });
});
