#!/usr/bin/env node

import { existsSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
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
  profileDir,
  runProbe,
  sanitizeDiagnostic,
  toLocalPath,
  writeEvidence,
} from "./test-harness.mjs";

const MODES = (process.env.DSH_NATIVE_MODES ?? "wsl,git-bash")
  .split(",")
  .map((value) => value.trim())
  .filter((value, index, values) => (value === "wsl" || value === "git-bash") && values.indexOf(value) === index);
if (MODES.length === 0) throw new Error("DSH_NATIVE_MODES must select wsl and/or git-bash");
const NATIVE_TIMEOUT_ONLY = process.env.DSH_NATIVE_TIMEOUT_ONLY === "1";
const CLI_TIMEOUT_MS = Number(process.env.DSH_NATIVE_CLI_TIMEOUT_MS ?? 90_000);
if (!Number.isSafeInteger(CLI_TIMEOUT_MS) || CLI_TIMEOUT_MS < 30_000 || CLI_TIMEOUT_MS > 600_000) {
  throw new Error("DSH_NATIVE_CLI_TIMEOUT_MS must be an integer between 30000 and 600000");
}

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

function replaceProfilePatch(context, mode) {
  const profileRoot = resolve(profileDir(context));
  const patchPath = resolve(profileRoot, "cordis.patch.yml");
  const relativePatch = relative(profileRoot, patchPath);
  if (relativePatch === "" || relativePatch === ".." || relativePatch.startsWith("..\\")
    || relativePatch.startsWith("../")) {
    throw new Error(`profile patch escaped isolated profile: ${patchPath}`);
  }
  const gitBash = process.env.DSH_GIT_BASH_PATH ?? "C:\\Program Files\\Git\\bin\\bash.exe";
  if (mode === "git-bash" && !existsSync(toLocalPath(gitBash))) {
    throw new SkipError(`Git Bash executable not found at ${gitBash}`);
  }
  const backendConfig = mode === "git-bash"
    ? [
      "    persistentShell: git-bash",
      "    backendType: git-bash",
      `    gitBashExecutable: '${gitBash.replaceAll("'", "''")}'`,
      "    shellArgs:",
      "      - --noprofile",
      "      - --norc",
      "      - -i",
    ]
    : [
      "    persistentShell: wsl",
      "    backendType: wsl",
      "    distro: Ubuntu",
      "    shellPath: /bin/bash",
      "    shellArgs:",
      "      - --noprofile",
      "      - --norc",
      "      - -i",
    ];
  const patch = [
    "# Test-only native persistent shell override; isolated profile only.",
    "- id: bash-wsl-backend-and-tools",
    "  config:",
    "    registerModes: false",
    ...backendConfig,
    "    timeoutMs: 10000",
    "    disposeGraceMs: 3000",
    "- id: bash-wsl-persistent-tool",
    "  config:",
    `    backendType: ${mode}`,
    "    timeoutMs: 10000",
    "    maxOutputChars: 16000",
    "    description: |-",
    "      Test-only persistent native shell lifecycle probe.",
    "",
  ].join("\n");
  writeFileSync(patchPath, patch, "utf8");
  return { patchPath: "<isolated-profile>/cordis.patch.yml", mode, gitBash };
}

async function runMode(mode) {
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    target: `Windows CLI ${EXPECTED_CLI_VERSION} / plugin ${EXPECTED_PLUGIN_VERSION}`,
    suite: "native-modes",
    mode,
    checks: [],
    cleanup: {},
  };
  let owned;
  try {
    owned = createOwnedTestRoot(`cli-native-mode-${mode}`);
    const context = await prepareIsolatedProfile(owned.root, `cli-native-${mode}`);
    const patch = replaceProfilePatch(context, mode);
    const caseDiagnostic = join(RUN_ROOT, `cli-native-case-diagnostics-${mode}-${Date.now()}.jsonl`);
    report.host = { ...context.host, patch, cliTimeoutMs: CLI_TIMEOUT_MS };
    const result = await runProbe(context, "native-modes", "workspace-write", {
      cliSuite: "native-modes",
      processCwd: context.workspace,
      persistentShell: mode,
      nativeTimeoutOnly: NATIVE_TIMEOUT_ONLY,
      caseFilter: process.env.DSH_PROBE_CASE_FILTER,
      caseDiagnostic,
      timeoutMs: CLI_TIMEOUT_MS,
    });
    const evidence = parseProbeResult(result);
    const childProcessEvidence = childLifecycleEvidence(result);
    report.raw = {
      process: childProcessEvidence,
      exitCode: result.exitCode,
      signal: result.signal,
      stdout: sanitizeDiagnostic(result.stdout),
      stderr: sanitizeDiagnostic(result.stderr),
      caseDiagnostic,
    };
    report.checks.push(!childProcessEvidence.ok
      ? check(`CLI-NATIVE-${mode}-PROCESS`, "FAIL", "native mode CLI child did not close/reap cleanly", { process: childProcessEvidence, evidence: evidence ?? null })
      : evidence?.status === "PASS"
        ? check(`CLI-NATIVE-${mode}`, "PASS", `real Windows CLI native ${mode} lifecycle probe passed`, evidence)
        : evidence?.status === "SKIP"
          ? check(`CLI-NATIVE-${mode}`, "SKIP", "native mode capability was unavailable; no PASS claim was made", evidence)
          : check(`CLI-NATIVE-${mode}`, "FAIL", "native mode lifecycle probe failed or produced no evidence", { evidence: evidence ?? null, stderr: sanitizeDiagnostic(result.stderr) }));
  } catch (error) {
    report.checks.push(error instanceof SkipError
      ? check(`CLI-NATIVE-${mode}-CAPABILITY`, "SKIP", error.message)
      : check(`CLI-NATIVE-${mode}-UNCAUGHT`, "FAIL", sanitizeDiagnostic(error?.stack ?? error)));
  } finally {
    if (owned !== undefined) {
      try {
        cleanupOwnedTestRoot(owned.root);
        report.cleanup.temporaryRootRemoved = true;
      } catch (error) {
        report.cleanup.temporaryRootRemoved = false;
        report.checks.push(check(`CLI-NATIVE-${mode}-CLEANUP`, "FAIL", sanitizeDiagnostic(error?.stack ?? error)));
      }
    }
  }
  report.status = aggregate(report.checks);
  return report;
}

const reports = [];
for (const mode of MODES) reports.push(await runMode(mode));
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  target: `Windows CLI ${EXPECTED_CLI_VERSION} / plugin ${EXPECTED_PLUGIN_VERSION}`,
  suite: "native-modes",
  status: aggregate(reports),
  modes: reports,
};
const evidencePath = writeEvidence(RUN_ROOT, `cli-native-modes-${Date.now()}.json`, report);
console.log(`CLI native modes: ${reports.map((item) => `${item.mode}=${item.status}`).join(", ")}`);
console.log(`Evidence: ${evidencePath}`);
process.exitCode = report.status === "PASS" ? 0 : report.status === "SKIP" ? 2 : 1;
