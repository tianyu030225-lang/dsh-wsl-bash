import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const { RUN_ROOT, ownedPnpmDiagnostics, requireSuccessfulCli } = await import(new URL("../CLI/test-harness.mjs", import.meta.url).href);

describe("owned CLI installer diagnostics", () => {
  it("retains pnpm errors printed to stdout alongside wrapper stderr", () => {
    const result = { exitCode: 1, stdout: "ERR_PNPM_FIXTURE offline metadata missing", stderr: "wrapper failed" };
    expect(() => requireSuccessfulCli(result, "fixture install")).toThrow(/ERR_PNPM_FIXTURE/);
    expect(() => requireSuccessfulCli(result, "fixture install")).toThrow(/wrapper failed/);
  });
  it("retains the bounded error tail and removes credential-shaped values", () => {
    mkdirSync(RUN_ROOT, { recursive: true });
    const root = mkdtempSync(join(RUN_ROOT, "installer-diagnostic-"));
    try {
      const context = { root, home: join(root, "dsh-home"), profile: "fixture" };
      const logs = join(context.home, "profiles", context.profile, ".plugin-manager", "logs", "operation-test");
      mkdirSync(logs, { recursive: true });
      writeFileSync(join(logs, "pnpm.log"),
        "old-prefix\n".repeat(2000) + "ERR_PNPM_FIXTURE package installation failed\n_authToken=fixture-secret\nauthorization: Bearer fixture-bearer-secret\n");
      const diagnostic = ownedPnpmDiagnostics(context);
      expect(diagnostic).toContain("ERR_PNPM_FIXTURE");
      expect(diagnostic).toContain("_authToken=<redacted>");
      expect(diagnostic).not.toContain("fixture-secret");
      expect(diagnostic).not.toContain("fixture-bearer-secret");
      expect(diagnostic.length).toBeLessThanOrEqual(16000);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("accepts a profile with no package-manager logs", () => {
    mkdirSync(RUN_ROOT, { recursive: true });
    const root = mkdtempSync(join(RUN_ROOT, "installer-no-diagnostic-"));
    try {
      const context = { root, home: join(root, "dsh-home"), profile: "fixture" };
      mkdirSync(join(context.home, "profiles", context.profile), { recursive: true });
      expect(ownedPnpmDiagnostics(context)).toBe("");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("refuses a root outside the owned run-artifact directory", () => {
    mkdirSync(RUN_ROOT, { recursive: true });
    expect(() => ownedPnpmDiagnostics({ root: dirname(RUN_ROOT), home: "unused", profile: "unused" }))
      .toThrow(/escaped/);
  });
});
