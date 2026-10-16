#!/usr/bin/env node

// Narrow real-tool regression. The low visible/spill caps are applied only to
// this owned profile overlay; production defaults remain unchanged.
import {
  EXPECTED_CLI_VERSION,
  EXPECTED_PLUGIN_VERSION,
  RUN_ROOT,
  SkipError,
  childLifecycleEvidence,
  cleanupOwnedTestRoot,
  createOwnedTestRoot,
  parseProbeResult,
  prepareIsolatedProfile,
  runProbe,
  sanitizeDiagnostic,
  writeEvidence,
} from "./test-harness.mjs";

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
    target: "Windows CLI " + EXPECTED_CLI_VERSION + " / plugin " + EXPECTED_PLUGIN_VERSION,
    suite: "output-cap",
    lowCapFixtureOnly: true,
    checks: [],
    cleanup: {},
  };
  let owned;
  try {
    owned = createOwnedTestRoot("cli-output-cap");
    const context = await prepareIsolatedProfile(
      owned.root,
      "cli-output-cap",
      { oneShotLimits: { memoryLimit: 4, spillLimit: 8 } },
    );
    report.host = context.host;
    report.fixture = {
      oneShotMaxOutputBytes: 4,
      oneShotMaxSpillBytes: 8,
      profileOverride: context.persistentTimeout,
      productionDefaultsUntouched: true,
    };
    const result = await runProbe(context, "output-cap", "workspace-write");
    const evidence = parseProbeResult(result);
    const process = childLifecycleEvidence(result);
    report.checks.push(!process.ok
      ? {
        id: "CLI-OUTPUT-CAP-01",
        status: "FAIL",
        detail: "real Windows CLI malformed UTF-8 cap child did not close cleanly",
        evidence: { process, probe: evidence ?? null },
      }
      : evidence?.status === "PASS"
        ? {
          id: "CLI-OUTPUT-CAP-01",
          status: "PASS",
          detail: "registered wsl_bash and git_bash marked malformed UTF-8 output truncated within the owned low cap",
          evidence: { process, probe: evidence },
        }
        : evidence?.status === "SKIP"
          ? {
            id: "CLI-OUTPUT-CAP-01",
            status: "SKIP",
            detail: "the real CLI lacked a capability needed for malformed UTF-8 cap validation",
            evidence,
          }
          : {
            id: "CLI-OUTPUT-CAP-01",
            status: "FAIL",
            detail: "registered malformed UTF-8 cap probe failed or produced no evidence",
            evidence: {
              exitCode: result.exitCode,
              probe: evidence ?? null,
              stderr: sanitizeDiagnostic(result.stderr),
            },
          });
  } catch (error) {
    if (error?.hostEvidence !== undefined) report.host = error.hostEvidence;
    report.checks.push({
      id: "CLI-OUTPUT-CAP-STARTUP",
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
          id: "CLI-OUTPUT-CAP-CLEANUP",
          status: "FAIL",
          detail: sanitizeDiagnostic(error?.stack ?? error),
        });
      }
    }
  }
  report.status = aggregate(report.checks);
  const evidencePath = writeEvidence(
    RUN_ROOT,
    "cli-output-cap-" + Date.now() + ".json",
    report,
  );
  const counts = report.checks.reduce((result, item) => {
    result[item.status] = (result[item.status] ?? 0) + 1;
    return result;
  }, {});
  console.log("CLI malformed UTF-8 cap: " + (counts.PASS ?? 0) + " passed, " +
    (counts.SKIP ?? 0) + " skipped, " + (counts.FAIL ?? 0) + " failed");
  console.log("Evidence: " + evidencePath);
  process.exitCode = report.status === "PASS" ? 0 : report.status === "SKIP" ? 2 : 1;
}

await main();
