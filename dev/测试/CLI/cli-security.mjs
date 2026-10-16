#!/usr/bin/env node

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
} from "./test-harness.mjs";

function check(id, status, detail, evidence = undefined) {
  return { id, status, detail, ...(evidence === undefined ? {} : { evidence }) };
}

function aggregate(checks) {
  return checks.some((item) => item.status === "FAIL")
    ? "FAIL"
    : checks.some((item) => item.status === "SKIP")
      ? "SKIP"
      : "PASS";
}

async function main() {
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    target: `Windows CLI ${EXPECTED_CLI_VERSION} / plugin ${EXPECTED_PLUGIN_VERSION}`,
    suite: "security",
    checks: [],
    modes: [],
    cleanup: {},
  };
  let owned;
  try {
    owned = createOwnedTestRoot("cli-security");
    const context = await prepareIsolatedProfile(owned.root, "cli-security");
    report.host = context.host;
    for (const mode of ["read-only", "workspace-write", "danger-full-access"]) {
      const result = await runProbe(context, "security", mode);
      const evidence = parseProbeResult(result);
      const process = childLifecycleEvidence(result);
      report.modes.push({ mode, process, evidence });
      report.checks.push(!process.ok
        ? check(`CLI-SEC-${mode}`, "FAIL", `security probe child did not close cleanly in ${mode}`, { process, evidence: evidence ?? null })
        : evidence?.status === "PASS"
        ? check(`CLI-SEC-${mode}`, "PASS", `real Windows CLI security probe passed in ${mode}`, evidence)
        : evidence?.status === "SKIP"
          ? check(`CLI-SEC-${mode}`, "SKIP", `security capability was unavailable in ${mode}; no PASS claim was made`, evidence)
          : check(`CLI-SEC-${mode}`, "FAIL", `real Windows CLI security probe failed in ${mode} or produced no evidence`, { exitCode: result.exitCode, evidence: evidence ?? null, stderr: result.stderr.slice(-3000) }));
    }
  } catch (error) {
    if (error?.hostEvidence !== undefined) report.host = error.hostEvidence;
    report.checks.push(error instanceof SkipError
      ? check("CLI-SEC-CAPABILITY", "SKIP", error.message)
      : check("CLI-SEC-UNCAUGHT", "FAIL", sanitizeDiagnostic(error?.stack ?? error),
        error?.hostEvidence === undefined ? undefined : { host: error.hostEvidence }));
  } finally {
    if (owned !== undefined) {
      try {
        cleanupOwnedTestRoot(owned.root);
        report.cleanup.temporaryRootRemoved = true;
      } catch (error) {
        report.cleanup.temporaryRootRemoved = false;
        report.checks.push(check("CLI-SEC-CLEANUP", "FAIL", sanitizeDiagnostic(error?.stack ?? error)));
      }
    }
  }
  report.status = aggregate(report.checks);
  const evidencePath = writeEvidence(RUN_ROOT, `cli-security-${Date.now()}.json`, report);
  const counts = report.checks.reduce((result, item) => {
    result[item.status] = (result[item.status] ?? 0) + 1;
    return result;
  }, {});
  console.log(`CLI security: ${counts.PASS ?? 0} passed, ${counts.SKIP ?? 0} skipped, ${counts.FAIL ?? 0} failed`);
  console.log(`Evidence: ${evidencePath}`);
  process.exitCode = report.status === "PASS" ? 0 : report.status === "SKIP" ? 2 : 1;
}

await main();
