#!/usr/bin/env node

// Security smoke delegates to the real Windows CLI security composition. The
// official probe owns the WSL/Git-Bash process lifecycle and policy assertions.
import {
  EXPECTED_CLI_VERSION,
  EXPECTED_PLUGIN_VERSION,
  RUN_ROOT,
  SkipError,
  cleanupOwnedTestRoot,
  childLifecycleEvidence,
  createOwnedTestRoot,
  parseProbeResult,
  prepareIsolatedProfile,
  runProbe,
  sanitizeDiagnostic,
  writeEvidence,
} from "../CLI/test-harness.mjs";

function aggregate(checks) {
  return checks.some((check) => check.status === "FAIL")
    ? "FAIL"
    : checks.some((check) => check.status === "SKIP")
      ? "SKIP"
      : "PASS";
}

async function main() {
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    target: `Windows CLI ${EXPECTED_CLI_VERSION} / plugin ${EXPECTED_PLUGIN_VERSION}`,
    suite: "smoke-security",
    checks: [],
    modes: [],
    cleanup: {},
  };
  let owned;
  try {
    owned = createOwnedTestRoot("smoke-security");
    const context = await prepareIsolatedProfile(owned.root, "smoke-security");
    report.host = context.host;
    for (const mode of ["read-only", "workspace-write", "danger-full-access"]) {
      const result = await runProbe(context, "security", mode);
      const evidence = parseProbeResult(result);
      const process = childLifecycleEvidence(result);
      report.modes.push({ mode, process, evidence });
      report.checks.push({
        id: `SMOKE-SEC-${mode}`,
        status: process.ok ? (evidence?.status ?? "FAIL") : "FAIL",
        detail: process.ok
          ? "real Windows CLI ran the official composed security probe"
          : "real Windows CLI security probe child did not close cleanly",
        evidence: process.ok ? { process, probe: evidence } : {
          process,
          probe: evidence ?? null,
          exitCode: result.exitCode,
          stderr: sanitizeDiagnostic(result.stderr),
        },
      });
    }
  } catch (error) {
    if (error?.hostEvidence !== undefined) report.host = error.hostEvidence;
    report.checks.push({
      id: "SMOKE-SEC-STARTUP",
      status: error instanceof SkipError ? "SKIP" : "FAIL",
      detail: sanitizeDiagnostic(error?.stack ?? error),
      ...(error?.hostEvidence === undefined ? {} : { evidence: { host: error.hostEvidence } }),
    });
  } finally {
    if (owned !== undefined) {
      try {
        cleanupOwnedTestRoot(owned.root);
        report.cleanup.temporaryRootRemoved = true;
      } catch (error) {
        report.cleanup.temporaryRootRemoved = false;
        report.checks.push({
          id: "SMOKE-SEC-CLEANUP",
          status: "FAIL",
          detail: sanitizeDiagnostic(error?.stack ?? error),
        });
      }
    }
  }
  report.status = aggregate(report.checks);
  const evidencePath = writeEvidence(RUN_ROOT, `smoke-security-${Date.now()}.json`, report);
  const counts = report.checks.reduce((result, check) => {
    result[check.status] = (result[check.status] ?? 0) + 1;
    return result;
  }, {});
  console.log(`CLI smoke security: ${counts.PASS ?? 0} passed, ${counts.SKIP ?? 0} skipped, ${counts.FAIL ?? 0} failed`);
  console.log(`Evidence: ${evidencePath}`);
  process.exitCode = report.status === "PASS" ? 0 : report.status === "SKIP" ? 2 : 1;
}

await main();
