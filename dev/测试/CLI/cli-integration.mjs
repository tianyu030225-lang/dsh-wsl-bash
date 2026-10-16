#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  EXPECTED_CLI_VERSION,
  EXPECTED_PLUGIN_VERSION,
  RUN_ROOT,
  SkipError,
  cleanupOwnedTestRoot,
  childLifecycleEvidence,
  createOwnedTestRoot,
  dumpConfig,
  parseProbeResult,
  prepareIsolatedProfile,
  profileDir,
  readInstalledManifest,
  runProbe,
  runWindowsDsh,
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
    suite: "integration",
    checks: [],
    cleanup: {},
  };
  let owned;
  try {
    owned = createOwnedTestRoot("cli-integration");
    const context = await prepareIsolatedProfile(owned.root, "cli-integration");
    const processCwd = join(owned.root, "host process cwd 中文 space");
    mkdirSync(processCwd, { recursive: true });
    report.host = {
      ...context.host,
      processCwd: "<owned-test-root>/host process cwd 中文 space",
      agentWorkspace: "<owned-test-root>/workspace 中文 space",
      processCwdDistinctFromWorkspace: processCwd !== context.workspace,
    };
    const plugin = readInstalledManifest(context, "dsh-plugin-bash-wsl");
    const probe = readInstalledManifest(context, "dsh-cli-probe");
    report.checks.push(plugin?.version === EXPECTED_PLUGIN_VERSION
      ? check("CLI-SETUP-01", "PASS", "isolated profile contains dsh-plugin-bash-wsl@0.2.0", { version: plugin.version })
      : check("CLI-SETUP-01", "FAIL", "isolated profile did not contain the expected plugin version", { version: plugin?.version ?? null }));
    report.checks.push(probe?.version === "0.0.0-test"
      ? check("CLI-SETUP-02", "PASS", "isolated profile contains the CLI probe bundle", { version: probe.version })
      : check("CLI-SETUP-02", "FAIL", "isolated profile did not contain the CLI probe bundle", { version: probe?.version ?? null }));

    const dump = await dumpConfig(context);
    const dumpProcess = childLifecycleEvidence(dump);
    const dumpText = `${dump.stdout}\n${dump.stderr}`;
    const requiredRows = [
      "dsh-plugin-bash-wsl",
      "@deepseek-ai/dsh-terminal",
      "dsh-plugin-bash-wsl/persistent",
      "@deepseek-ai/dsh-user-approval",
      "@deepseek-ai/dsh-subprocess-local",
      "@deepseek-ai/dsh-sandbox-policy",
      "@deepseek-ai/dsh-pwsh-sandbox",
      "@deepseek-ai/dsh-tool-pwsh",
    ];
    const missingRows = requiredRows.filter((row) => !dumpText.includes(row));
    report.checks.push(dumpProcess.ok && dump.exitCode === 0 && missingRows.length === 0
      ? check("CLI-SETUP-03", "PASS", "actual Windows CLI dump shows the plugin, official terminal/approval stack, and preserved PowerShell rows", { process: dumpProcess, rows: requiredRows })
      : check("CLI-SETUP-03", "FAIL", "actual Windows CLI dump child or content validation failed", { process: dumpProcess, exitCode: dump.exitCode, missingRows, stderr: dump.stderr.slice(-2000) }));

    const first = await runProbe(
      context,
      "integration",
      "workspace-write",
      { processCwd },
    );
    const firstEvidence = parseProbeResult(first);
    const firstProcess = childLifecycleEvidence(first);
    report.checks.push(!firstProcess.ok
      ? check("CLI-INT-01", "FAIL", "integration probe child did not close cleanly", { process: firstProcess, evidence: firstEvidence ?? null })
      : firstEvidence?.status === "PASS"
      ? check("CLI-INT-01", "PASS", "real Windows CLI profile ran the local integration probe", { process: firstProcess, probe: firstEvidence })
      : firstEvidence?.status === "SKIP"
        ? check("CLI-INT-01", "SKIP", "the real CLI integration probe could not exercise every host capability", firstEvidence)
        : check("CLI-INT-01", "FAIL", "the real Windows CLI integration probe failed or produced no evidence", { exitCode: first.exitCode, evidence: firstEvidence ?? null, stderr: first.stderr.slice(-3000) }));

    const remove = await runWindowsDsh({
      home: context.home,
      workspace: context.workspace,
      args: ["plugin", "--profile", context.profile, "remove", "dsh-cli-probe"],
    });
    const removeProcess = childLifecycleEvidence(remove);
    const afterRemovePath = join(profileDir(context), "package.json");
    const afterRemove = existsSync(afterRemovePath)
      ? JSON.parse(readFileSync(afterRemovePath, "utf8"))
      : undefined;
    report.checks.push(removeProcess.ok && remove.exitCode === 0 && !(afterRemove?.dsh?.profile?.bundles ?? []).includes("dsh-cli-probe")
      ? check("CLI-INT-02", "PASS", "isolated CLI profile removed the probe bundle without touching the real user profile", { process: removeProcess })
      : check("CLI-INT-02", "FAIL", "isolated CLI profile uninstall child or bundle validation failed", { process: removeProcess, exitCode: remove.exitCode, stderr: remove.stderr.slice(-2000), bundles: afterRemove?.dsh?.profile?.bundles ?? null }));

    const readd = await runWindowsDsh({
      home: context.home,
      workspace: context.workspace,
      args: ["plugin", "--profile", context.profile, "add", "--offline", "--ignore-scripts", context.probePackage],
    });
    const readdProcess = childLifecycleEvidence(readd);
    report.checks.push(readdProcess.ok && readd.exitCode === 0
      ? check("CLI-INT-03", "PASS", "the isolated probe bundle was reinstalled after uninstall", { process: readdProcess })
      : check("CLI-INT-03", "FAIL", "the isolated probe bundle could not be reinstalled cleanly", { process: readdProcess, exitCode: readd.exitCode, stderr: readd.stderr.slice(-2000) }));

    const reloaded = await runProbe(
      context,
      "integration",
      "workspace-write",
      { processCwd },
    );
    const reloadEvidence = parseProbeResult(reloaded);
    const reloadProcess = childLifecycleEvidence(reloaded);
    report.checks.push(!reloadProcess.ok
      ? check("CLI-INT-04", "FAIL", "reloaded integration probe child did not close cleanly", { process: reloadProcess, evidence: reloadEvidence ?? null })
      : reloadEvidence?.status === "PASS"
      ? check("CLI-INT-04", "PASS", "the reinstalled isolated profile reloaded in a fresh CLI process and reproduced the probe", { process: reloadProcess, probe: reloadEvidence })
      : reloadEvidence?.status === "SKIP"
        ? check("CLI-INT-04", "SKIP", "fresh-process reload did not have all host capabilities", reloadEvidence)
        : check("CLI-INT-04", "FAIL", "fresh-process reload failed or produced no evidence", { exitCode: reloaded.exitCode, evidence: reloadEvidence ?? null, stderr: reloaded.stderr.slice(-3000) }));
  } catch (error) {
    if (error?.hostEvidence !== undefined) report.host = error.hostEvidence;
    report.checks.push(error instanceof SkipError
      ? check("CLI-SETUP-CAPABILITY", "SKIP", error.message)
      : check("CLI-SETUP-UNCAUGHT", "FAIL", sanitizeDiagnostic(error?.stack ?? error),
        error?.hostEvidence === undefined ? undefined : { host: error.hostEvidence }));
  } finally {
    if (owned !== undefined) {
      try {
        cleanupOwnedTestRoot(owned.root);
        report.cleanup.temporaryRootRemoved = true;
      } catch (error) {
        report.cleanup.temporaryRootRemoved = false;
        report.checks.push(check("CLI-CLEANUP-01", "FAIL", sanitizeDiagnostic(error?.stack ?? error)));
      }
    }
  }
  report.status = aggregate(report.checks);
  const evidencePath = writeEvidence(RUN_ROOT, `cli-integration-${Date.now()}.json`, report);
  const counts = report.checks.reduce((result, item) => {
    result[item.status] = (result[item.status] ?? 0) + 1;
    return result;
  }, {});
  console.log(`CLI integration: ${counts.PASS ?? 0} passed, ${counts.SKIP ?? 0} skipped, ${counts.FAIL ?? 0} failed`);
  console.log(`Evidence: ${evidencePath}`);
  process.exitCode = report.status === "PASS" ? 0 : report.status === "SKIP" ? 2 : 1;
}

await main();
