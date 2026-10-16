#!/usr/bin/env node

// Narrow diagnostic only: this intentionally runs the old candidate TGZ to
// establish the registered Git Bash workdir behavior before the new package is
// frozen. It is not release evidence.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
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
    target: `Windows CLI ${EXPECTED_CLI_VERSION} / plugin ${EXPECTED_PLUGIN_VERSION}`,
    suite: "git-workdir-diagnostic",
    diagnosticOnly: true,
    checks: [],
    cleanup: {},
  };
  let owned;
  try {
    owned = createOwnedTestRoot("cli-git-workdir");
    const processCwd = join(owned.root, "host process cwd 中文 space");
    mkdirSync(processCwd, { recursive: true });
    const context = await prepareIsolatedProfile(owned.root, "cli-git-workdir");
    report.host = {
      ...context.host,
      processCwd: "<owned-test-root>/host process cwd 中文 space",
      agentWorkspace: "<owned-test-root>/workspace 中文 space",
      processCwdDistinctFromWorkspace: processCwd !== context.workspace,
      candidatePackageOnly: true,
    };
    const result = await runProbe(
      context,
      "git-workdir",
      "danger-full-access",
      { processCwd },
    );
    const evidence = parseProbeResult(result);
    const process = childLifecycleEvidence(result);
    report.checks.push(!process.ok
      ? {
        id: "CLI-GIT-WORKDIR-01",
        status: "FAIL",
        detail: "real Windows CLI diagnostic child did not close cleanly",
        evidence: { process, probe: evidence ?? null },
      }
      : evidence?.status === "PASS"
        ? {
          id: "CLI-GIT-WORKDIR-01",
          status: "PASS",
          detail: "registered git_bash omitted, relative, and explicit absolute workdir used the agent workspace while UNC/device namespaces were rejected",
          evidence: { process, probe: evidence },
        }
        : evidence?.status === "SKIP"
          ? {
            id: "CLI-GIT-WORKDIR-01",
            status: "SKIP",
            detail: "the real CLI lacked a capability needed for the workdir diagnostic",
            evidence,
          }
          : {
            id: "CLI-GIT-WORKDIR-01",
            status: "FAIL",
            detail: "registered git_bash workdir diagnostic failed or produced no evidence",
            evidence: {
              exitCode: result.exitCode,
              probe: evidence ?? null,
              stderr: sanitizeDiagnostic(result.stderr),
            },
          });
  } catch (error) {
    report.checks.push({
      id: "CLI-GIT-WORKDIR-STARTUP",
      status: error instanceof SkipError ? "SKIP" : "FAIL",
      detail: sanitizeDiagnostic(error?.stack ?? error),
      ...(error?.hostEvidence === undefined ? {} : { evidence: { host: error.hostEvidence } }),
    });
    if (error?.hostEvidence !== undefined) report.host = error.hostEvidence;
  } finally {
    if (owned !== undefined) {
      try {
        cleanupOwnedTestRoot(owned.root);
        report.cleanup.temporaryRootRemoved = true;
      } catch (error) {
        report.cleanup.temporaryRootRemoved = false;
        report.checks.push({
          id: "CLI-GIT-WORKDIR-CLEANUP",
          status: "FAIL",
          detail: sanitizeDiagnostic(error?.stack ?? error),
        });
      }
    }
  }
  report.status = aggregate(report.checks);
  const evidencePath = writeEvidence(
    RUN_ROOT,
    `cli-git-workdir-${Date.now()}.json`,
    report,
  );
  const counts = report.checks.reduce((result, item) => {
    result[item.status] = (result[item.status] ?? 0) + 1;
    return result;
  }, {});
  console.log(`CLI Git Bash workdir diagnostic: ${counts.PASS ?? 0} passed, ${counts.SKIP ?? 0} skipped, ${counts.FAIL ?? 0} failed`);
  console.log(`Evidence: ${evidencePath}`);
  process.exitCode = report.status === "PASS" ? 0 : report.status === "SKIP" ? 2 : 1;
}

await main();
