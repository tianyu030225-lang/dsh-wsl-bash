#!/usr/bin/env node

// This smoke entry deliberately delegates to the real Windows CLI composition.
// It must not copy the persistent-bash framing, registry, or terminal protocol.
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
import { mkdirSync } from "node:fs";
import { join } from "node:path";

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
    suite: "smoke-integration",
    checks: [],
    cleanup: {},
  };
  let owned;
  try {
    owned = createOwnedTestRoot("smoke-integration");
    const context = await prepareIsolatedProfile(owned.root, "smoke-integration");
    const processCwd = join(owned.root, "host process cwd 中文 space");
    mkdirSync(processCwd, { recursive: true });
    report.host = {
      ...context.host,
      processCwd,
      agentWorkspace: context.workspace,
      processCwdDistinctFromWorkspace: processCwd !== context.workspace,
    };
    const result = await runProbe(
      context,
      "integration",
      "workspace-write",
      { processCwd },
    );
    const evidence = parseProbeResult(result);
    const process = childLifecycleEvidence(result);
    if (!process.ok) {
      report.checks.push({
        id: "SMOKE-CLI-01",
        status: "FAIL",
        detail: "real Windows CLI probe child did not close cleanly",
        evidence: { process, probe: evidence ?? null },
      });
    } else if (evidence === undefined) {
      report.checks.push({
        id: "SMOKE-CLI-01",
        status: "FAIL",
        detail: "real Windows CLI did not emit the official probe result",
        evidence: {
          exitCode: result.exitCode,
          process,
          stderr: sanitizeDiagnostic(result.stderr),
        },
      });
    } else {
      report.checks.push({
        id: "SMOKE-CLI-01",
        status: evidence.status,
        detail: "real Windows CLI ran the official composed probe bundle",
        evidence: { process, probe: evidence },
      });
    }
  } catch (error) {
    if (error?.hostEvidence !== undefined) report.host = error.hostEvidence;
    report.checks.push({
      id: "SMOKE-CLI-STARTUP",
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
          id: "SMOKE-CLI-CLEANUP",
          status: "FAIL",
          detail: sanitizeDiagnostic(error?.stack ?? error),
        });
      }
    }
  }
  report.status = aggregate(report.checks);
  const evidencePath = writeEvidence(RUN_ROOT, `smoke-integration-${Date.now()}.json`, report);
  const counts = report.checks.reduce((result, check) => {
    result[check.status] = (result[check.status] ?? 0) + 1;
    return result;
  }, {});
  console.log(`CLI smoke integration: ${counts.PASS ?? 0} passed, ${counts.SKIP ?? 0} skipped, ${counts.FAIL ?? 0} failed`);
  console.log(`Evidence: ${evidencePath}`);
  process.exitCode = report.status === "PASS" ? 0 : report.status === "SKIP" ? 2 : 1;
}

await main();
