#!/usr/bin/env node

/**
 * Synthetic validator-only regressions. These cases are self-contained and
 * never qualify a real CLI/Desktop run or replace runtime evidence.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  validateNativeModesCliEvidence,
  validateNativeModesGuiRosterEvidence,
} from "./native-modes-release-validator.mjs";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(TEST_DIR, "../../..");
const RUN_OUTPUT_ROOT = join(ROOT, "测试", "运行产物");

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

const CANDIDATE_SHA = "a".repeat(64);
const PROBE_SOURCE_SHA = "b".repeat(64);
const PROBE_OBSERVER_SHA = "e".repeat(64);
const DIST_SHA = "c".repeat(64);
const CLI_PACKAGE_SHA = "d".repeat(64);
const EXPECTED_CLI_VERSION = "0.2.2-alpha.2";
const GUI_CANDIDATE_SHA = CANDIDATE_SHA;
const GUI_ASAR_SHA = DIST_SHA;
const GUI_EXECUTABLE_SHA = CLI_PACKAGE_SHA;
const GUI_NATIVE_PROBE_SHA = PROBE_SOURCE_SHA;
const NATIVE_FIXTURE_TEMPLATE_PATH = join(
  TEST_DIR,
  "fixtures",
  "native-runtime-validator.json",
);

const WSL_CASES = [
  "CLI-NATIVE-01",
  "CLI-NATIVE-03",
  "CLI-NATIVE-04",
  "CLI-NATIVE-05",
  "CLI-NATIVE-06",
  "CLI-NATIVE-07",
  "CLI-NATIVE-08",
  "CLI-NATIVE-09",
];

const GIT_CASES = [
  ...WSL_CASES,
  "CLI-NATIVE-02",
  "CLI-NATIVE-10",
  "CLI-NATIVE-11",
];

function managedSettlements() {
  return [{
    index: 0,
    doneError: null,
    done: { exitCode: 0, signal: null, timedOut: false },
    waitError: null,
    waitForExit: true,
  }];
}

function nativeCleanup(helperPid, shellPid) {
  return {
    helperPid,
    shellPid,
    managedDone: true,
    managedWaitForExit: true,
    managedSettlements: managedSettlements(),
    observerHostAliveAfterExit: true,
    observationError: null,
    afterDispose: {
      helper: null,
      top: null,
      shell: null,
      remaining: [],
      helperChildren: [],
    },
  };
}

function aggregateNativeCleanup() {
  const trees = [0, 1].map((index) => {
    const helperPid = 2001 + index * 10;
    const topPid = helperPid + 1;
    const shellPid = helperPid + 2;
    const conhostPid = helperPid + 3;
    const date = (offset) => `2026-10-13T00:00:0${index}${offset}.000Z`;
    return {
      helperPid,
      topPid,
      shellPid,
      helper: { ProcessId: helperPid, ParentProcessId: 1, CreationDate: date(1) },
      top: { ProcessId: topPid, ParentProcessId: helperPid, CreationDate: date(2) },
      shell: { ProcessId: shellPid, ParentProcessId: topPid, CreationDate: date(3) },
      conhost: { ProcessId: conhostPid, ParentProcessId: helperPid, CreationDate: date(4) },
    };
  });
  const nativeManagedSettlements = trees.map((tree, index) => ({
    index,
    waitForExit: true,
    waitError: null,
    done: { exitCode: 0, signal: null, timedOut: false },
    doneError: null,
  }));
  return {
    managedDone: true,
    managedWaitForExit: true,
    nativeManagedSettlements,
    observerHostAliveAfterExit: true,
    observationError: null,
    trees,
    afterDispose: {
      helper: null,
      top: null,
      shell: null,
      remaining: [],
      helperChildren: [],
      trees: trees.map((_tree, index) => ({
        remaining: [],
        helperDescendants: [],
        observedAt: 1791845120000 + index,
      })),
    },
  };
}

function wslCleanup(sessionId) {
  return {
    managedDone: true,
    managedWaitForExit: true,
    managedSettlements: managedSettlements(),
    publicSession: [{ type: "wsl", sessionId }],
    observationError: null,
  };
}

function cancellationEvidence() {
  return {
    started: true,
    aborted: true,
    controllerSignalAborted: true,
    typedEnvelopeAbort: true,
    abortErrorInfo: { name: "AbortError", code: "ABORTED" },
    leakMarkerCreated: false,
    resetVerified: true,
    nativeManagedSettlements: managedSettlements(),
    nativeProcess: nativeCleanup(1001, 1002),
  };
}

function wslCancellationEvidence() {
  return {
    started: true,
    aborted: true,
    controllerSignalAborted: true,
    typedEnvelopeAbort: true,
    abortErrorInfo: { name: "AbortError", code: "ABORTED" },
    leakMarkerCreated: false,
    resetVerified: true,
    cancellationActivityCleared: true,
    finalActivityCleared: true,
    ...wslCleanup("synthetic-wsl-cancel"),
  };
}

function timeoutEvidence() {
  const native = aggregateNativeCleanup();
  return {
    ready: true,
    timedOut: true,
    cleanReset: true,
    cwdReset: true,
    timeoutOwnerActivityCleared: true,
    naturalExit: true,
    naturalOwnerActivityCleared: true,
    naturalCleanReset: true,
    leakMarkerCreated: false,
    nativeManagedSettlements: native.nativeManagedSettlements,
    nativeProcess: native,
    nativeHelpers: [{
      argv: ["C:\\Program Files\\nodejs\\node.exe", "<test-root>\\pty-helper.js", "<host-anchor>"],
      controlPipe: true,
    }],
  };
}

function wslTimeoutEvidence() {
  return {
    ready: true,
    timedOut: true,
    cleanReset: true,
    cwdReset: true,
    timeoutOwnerActivityCleared: true,
    naturalExit: true,
    naturalOwnerActivityCleared: true,
    naturalCleanReset: true,
    leakMarkerCreated: false,
    finalActivityCleared: true,
    ...wslCleanup("synthetic-wsl-timeout"),
  };
}

function naturalEvidence(noisy) {
  return {
    markerCreated: false,
    noisyOk: true,
    noisyOutputObserved: noisy,
    observerHostAliveAfterExit: true,
    observationError: null,
    processLedger: {
      available: true,
      afterDelayRows: [],
      remaining: [],
      frame: { shellWinPid: 1201, backgroundWinPid: 1202 },
    },
    nativeProcess: {
      afterDispose: { remaining: [], helperDescendants: [] },
    },
  };
}

function check(prefix, evidence = {}) {
  return { id: `${prefix} synthetic`, status: "PASS", evidence };
}

function makeMode(modeId) {
  const cases = (modeId === "wsl" ? WSL_CASES : GIT_CASES)
    .map((prefix) => check(prefix));
  const find = (prefix) => cases.find((item) => item.id.startsWith(`${prefix} `));
  find("CLI-NATIVE-05").evidence = modeId === "wsl" ? wslCancellationEvidence() : cancellationEvidence();
  find("CLI-NATIVE-06").evidence = modeId === "wsl" ? wslTimeoutEvidence() : timeoutEvidence();
  if (modeId === "wsl") {
    find("CLI-NATIVE-03").evidence = {
      cwdAndEnvPersisted: true,
      ownerActivityCleared: true,
      ...wslCleanup("synthetic-wsl-state"),
    };
    find("CLI-NATIVE-04").evidence = {
      ownerADisposed: true,
      ownerBStayedAlive: true,
      naturalExit: true,
      naturalOwnerActivityCleared: true,
      ...wslCleanup("synthetic-wsl-owner"),
    };
  }
  if (modeId === "git-bash") {
    find("CLI-NATIVE-03").evidence.nativeProcess = nativeCleanup(1301, 1302);
    find("CLI-NATIVE-04").evidence = {
      ownerADisposed: true,
      ownerBStayedAlive: true,
      naturalExit: true,
      nativeProcess: nativeCleanup(1401, 1402),
    };
    find("CLI-NATIVE-10").evidence = naturalEvidence(false);
    find("CLI-NATIVE-11").evidence = naturalEvidence(true);
  }
  const outerEvidence = {
    schemaVersion: 1,
    suite: "native-modes",
    mode: "workspace-write",
    status: "PASS",
    checks: cases,
  };
  return {
    schemaVersion: 1,
    suite: "native-modes",
    mode: modeId,
    status: "PASS",
    cleanup: { temporaryRootRemoved: true },
    host: {
      cliVersion: EXPECTED_CLI_VERSION,
      hostPlatform: "win32",
      cliPackageSha256: CLI_PACKAGE_SHA,
      pluginTgzSha256: CANDIDATE_SHA,
      sourceDistSha256: DIST_SHA,
      installedDistSha256: DIST_SHA,
      distHashesMatch: true,
      probeSourceIndexSha256: PROBE_SOURCE_SHA,
      probeInstalledIndexSha256: PROBE_SOURCE_SHA,
      probeIndexHashesMatch: true,
      probeObserverRequired: true,
      probeSourceObserverSha256: PROBE_OBSERVER_SHA,
      probeInstalledObserverSha256: PROBE_OBSERVER_SHA,
      probeObserverHashesMatch: true,
      patch: { mode: modeId },
    },
    raw: {
      process: {
        exitCode: 0,
        signal: null,
        timedOut: false,
        error: null,
        closeObserved: true,
        reaped: true,
      },
    },
    checks: [{ id: `CLI-NATIVE-${modeId}`, status: "PASS", evidence: outerEvidence }],
  };
}

function makeFixture() {
  return {
    report: {
      syntheticValidatorOnly: true,
      schemaVersion: 1,
      suite: "native-modes",
      status: "PASS",
      modes: [makeMode("wsl"), makeMode("git-bash")],
    },
    options: {
      candidateSha256: CANDIDATE_SHA,
      cliProbeSourceSha256: PROBE_SOURCE_SHA,
      cliProbeObserverSha256: PROBE_OBSERVER_SHA,
      expectedCliVersion: EXPECTED_CLI_VERSION,
      expectedCliPackageSha256: CLI_PACKAGE_SHA,
    },
  };
}

function mode(report, modeId) {
  return report.modes.find((item) => item.mode === modeId);
}

function nested(report, modeId, prefix) {
  return mode(report, modeId).checks[0].evidence.checks
    .find((item) => item.id.startsWith(`${prefix} `));
}

function expectRejected(name, mutate, pattern) {
  const fixture = makeFixture();
  mutate(fixture.report, fixture.options);
  const result = validateNativeModesCliEvidence(fixture.report, fixture.options);
  assert.equal(result.ok, false, `${name} unexpectedly passed`);
  assert.match(result.detail, pattern, `${name} reported an unexpected failure`);
  console.log(`PASS ${name}`);
}

const accepted = makeFixture();
assert.equal(
  validateNativeModesCliEvidence(accepted.report, accepted.options).ok,
  true,
);
console.log("PASS synthetic validator-only baseline (not runtime qualification)");

const sameTopShellFixture = makeFixture();
const sameTopShellTree = nested(sameTopShellFixture.report, "git-bash", "CLI-NATIVE-06")
  .evidence.nativeProcess.trees[0];
sameTopShellTree.shellPid = sameTopShellTree.topPid;
sameTopShellTree.shell = structuredClone(sameTopShellTree.top);
assert.equal(
  validateNativeModesCliEvidence(sameTopShellFixture.report, sameTopShellFixture.options).ok,
  true,
);
console.log("PASS aggregate validator does not assume top and shell must differ");

expectRejected("missing mandatory nested case", (report) => {
  const checks = mode(report, "wsl").checks[0].evidence.checks;
  mode(report, "wsl").checks[0].evidence.checks = checks.filter(
    (item) => !item.id.startsWith("CLI-NATIVE-08 "),
  );
}, /missing, duplicated, or not PASS/);

expectRejected("duplicate mandatory nested case", (report) => {
  const checks = mode(report, "wsl").checks[0].evidence.checks;
  checks.push(structuredClone(nested(report, "wsl", "CLI-NATIVE-06")));
}, /missing, duplicated, or not PASS/);

expectRejected("SKIP mandatory nested case", (report) => {
  nested(report, "wsl", "CLI-NATIVE-07").status = "SKIP";
}, /missing, duplicated, or not PASS/);

expectRejected("old candidate SHA", (_report, options) => {
  options.candidateSha256 = "d".repeat(64);
}, /explicit candidate TGZ SHA/);

expectRejected("old probe source SHA", (_report, options) => {
  options.cliProbeSourceSha256 = "e".repeat(64);
}, /source\/installed probe identity/);

expectRejected("missing Windows observer identity", (report) => {
  delete mode(report, "wsl").host.probeSourceObserverSha256;
}, /source\/installed Windows observer identity/);

expectRejected("mismatched Windows observer identity", (report) => {
  mode(report, "git-bash").host.probeInstalledObserverSha256 = "f".repeat(64);
}, /source\/installed Windows observer identity/);

expectRejected("bad host dist identity", (report) => {
  mode(report, "git-bash").host.installedDistSha256 = "f".repeat(64);
}, /source\/installed dist identity/);

expectRejected("wrong CLI version", (report) => {
  mode(report, "wsl").host.cliVersion = "0.2.0-rc.2";
}, /host identity/);

expectRejected("non-Windows host platform", (report) => {
  mode(report, "wsl").host.hostPlatform = "linux";
}, /host identity/);

expectRejected("wrong CLI manifest SHA", (report) => {
  mode(report, "git-bash").host.cliPackageSha256 = "e".repeat(64);
}, /host identity/);

expectRejected("false cleanup", (report) => {
  mode(report, "wsl").cleanup.temporaryRootRemoved = false;
}, /temporary profile cleanup/);

expectRejected("unsafe cancellation pseudo-PASS", (report) => {
  Object.assign(nested(report, "git-bash", "CLI-NATIVE-05").evidence, {
    controllerSignalAborted: false,
    typedEnvelopeAbort: false,
    abortErrorInfo: { name: "AbortError", code: "OTHER" },
    rejectionClassifiedAsAbort: true,
  });
}, /typed ABORTED, real signal/);

expectRejected("cancellation marker/reset without managed cleanup", (report) => {
  delete nested(report, "git-bash", "CLI-NATIVE-05").evidence.nativeProcess;
}, /cancellation lacks/);

expectRejected("managed completion missing exit outcome fields", (report) => {
  nested(report, "git-bash", "CLI-NATIVE-05").evidence.nativeManagedSettlements[0].done = {};
}, /cancellation lacks/);

expectRejected("unsafe timeout pseudo-PASS", (report) => {
  nested(report, "git-bash", "CLI-NATIVE-06").evidence.cleanReset = false;
}, /timeout lacks bounded reset/);

expectRejected("timeout helper argv without managed cleanup", (report) => {
  delete nested(report, "git-bash", "CLI-NATIVE-06").evidence.nativeProcess;
}, /timeout lacks bounded reset/);

expectRejected("aggregate timeout empty tree list", (report) => {
  nested(report, "git-bash", "CLI-NATIVE-06").evidence.nativeProcess.trees = [];
}, /timeout case lacks bounded timeout/);

expectRejected("aggregate timeout forged PID", (report) => {
  const tree = nested(report, "git-bash", "CLI-NATIVE-06").evidence.nativeProcess.trees[0];
  tree.helper.ProcessId = 0;
}, /timeout case lacks bounded timeout/);

expectRejected("aggregate timeout missing creation identity", (report) => {
  const tree = nested(report, "git-bash", "CLI-NATIVE-06").evidence.nativeProcess.trees[0];
  delete tree.conhost.CreationDate;
}, /timeout case lacks bounded timeout/);

expectRejected("aggregate timeout partial managed settlement", (report) => {
  nested(report, "git-bash", "CLI-NATIVE-06").evidence.nativeManagedSettlements.pop();
}, /timeout case lacks bounded timeout/);

expectRejected("aggregate timeout duplicate managed settlement", (report) => {
  const settlements = nested(report, "git-bash", "CLI-NATIVE-06")
    .evidence.nativeManagedSettlements;
  settlements[1] = structuredClone(settlements[0]);
}, /timeout case lacks bounded timeout/);

expectRejected("native completion duplicate managed settlement", (report) => {
  const settlements = nested(report, "git-bash", "CLI-NATIVE-05")
    .evidence.nativeManagedSettlements;
  settlements.push(structuredClone(settlements[0]));
}, /cancellation lacks/);

expectRejected("aggregate timeout nested residual after-dispose identity", (report) => {
  nested(report, "git-bash", "CLI-NATIVE-06").evidence.nativeProcess
    .afterDispose.trees[0].remaining = [{ pid: 2099 }];
}, /timeout case lacks bounded timeout/);

expectRejected("aggregate timeout nested observation query error", (report) => {
  nested(report, "git-bash", "CLI-NATIVE-06").evidence.nativeProcess
    .afterDispose.trees[0].observationError = "query failed";
}, /timeout case lacks bounded timeout/);

expectRejected("aggregate timeout residual after-dispose identity", (report) => {
  nested(report, "git-bash", "CLI-NATIVE-06").evidence.nativeProcess.afterDispose.remaining = [{ pid: 2099 }];
}, /timeout case lacks bounded timeout/);

expectRejected("state observation error", (report) => {
  nested(report, "git-bash", "CLI-NATIVE-03").evidence.nativeProcess.observationError = "query failed";
}, /state case lacks zero observed identities/);

expectRejected("owner identity residual", (report) => {
  nested(report, "git-bash", "CLI-NATIVE-04").evidence.nativeProcess.afterDispose.remaining = [{ pid: 1403 }];
}, /owner isolation case lacks zero observed identities/);

expectRejected("WSL state missing managed completion", (report) => {
  delete nested(report, "wsl", "CLI-NATIVE-03").evidence.managedWaitForExit;
}, /WSL state case lacks public WSL session/);

expectRejected("WSL public session forged Windows PID", (report) => {
  nested(report, "wsl", "CLI-NATIVE-03").evidence.publicSession[0].pid = 4321;
}, /WSL state case lacks public WSL session/);

expectRejected("natural noisy observation error", (report) => {
  nested(report, "git-bash", "CLI-NATIVE-11").evidence.observationError = "snapshot failed";
}, /CLI Git Bash CLI-NATIVE-11 lacks zero identity/);

function guiRosterFixture(
  source = "@oai/sky",
  independent = true,
  candidateSha = CANONICAL_TGZ_SHA256,
) {
  return {
    schemaVersion: 1,
    status: "PASS",
    source,
    independent,
    desktopIdentity: {
      tgzSha256: candidateSha,
      appAsarSha256: candidateSha === CANONICAL_TGZ_SHA256
        ? PROBE_SOURCE_SHA
        : GUI_ASAR_SHA,
      executableSha256: candidateSha === CANONICAL_TGZ_SHA256
        ? DIST_SHA
        : GUI_EXECUTABLE_SHA,
    },
    roster: {
      modeIds: ["bash-wsl", "bash-git-bash"],
      uniqueOwnedWindow: true,
      pluginEnabled: true,
      modeMenuVisible: true,
      bashWslVisible: true,
      gitBashVisible: true,
      pwshVisible: true,
      selectedDefault: "standard",
    },
    cleanup: {
      temporaryRootRemoved: true,
      profileContained: true,
    },
  };
}

const CANONICAL_TGZ_SHA256 =
  "9cb01907dd7a9558255b6b8d5fe5ef03349927711fef0aadf9456656fe2b6f63";
const REUSE_DRIVER_SOURCE_HASHES = {
  probe: "1".repeat(64),
  sessionDriver: "2".repeat(64),
  launcher: "3".repeat(64),
  wrapper: "4".repeat(64),
  candidateBinding: "5".repeat(64),
};

function reusePermission(modeId) {
  const git = modeId === "bash-git-bash";
  const transition = (preset, marker) => ({
    ack: {
      commandIdSha256: marker.repeat(64),
      kind: "success",
      text: `preset ${preset}`,
      sourceEventSeq: 7,
    },
    projection: { asOfSeq: 8, currentValue: preset },
  });
  return {
    mode: git ? "danger-full-access" : "workspace-write",
    authorizationGranted: git ? true : null,
    authorizationInput: git ? "DSH_GUI_ALLOW_GIT_FULL_ACCESS=1" : null,
    authorizationSource: git ? "explicit-user-test-authorization" : null,
    authorizationScope: git ? "owned-gui-session" : null,
    command: {
      name: "permission",
      definitionId: "@deepseek-ai/dsh-permission-presets",
      inputHint: "<preset>",
    },
    workspaceWrite: transition("workspace-write", "6"),
    fullAccess: git ? transition("danger-full-access", "7") : null,
    prePromptProjection: {
      asOfSeq: 9,
      currentValue: git ? "danger-full-access" : "workspace-write",
    },
  };
}

function reuseCleanup(modeId) {
  const base = {
    strategy: "reused-protected-owned-fixture",
    temporaryRootCreated: false,
    temporaryRootRemoved: false,
    temporaryRootNotApplicable: true,
    profileContained: true,
    profileContainment: {
      available: true,
      allInside: true,
      entries: [
        { exists: true, contained: true },
        { exists: true, contained: true },
        { exists: true, contained: true },
      ],
    },
    protectedFixtureReused: true,
    protectedFixturePreserved: true,
    canonicalTgzPreserved: true,
    canonicalTgzSha256: CANONICAL_TGZ_SHA256,
    canonicalTgzBeforeSha256: CANONICAL_TGZ_SHA256,
    canonicalTgzAfterSha256: CANONICAL_TGZ_SHA256,
    childClosed: true,
    socketClosed: true,
    queueEnded: true,
    terminationAttempted: false,
    killAuthorizedByLineage: false,
    reaped: true,
    lineageInitial: {
      available: true,
      verified: true,
      rootPresent: true,
      rootCreation: "before",
      rootIdentity: {
        pid: modeId === "bash-wsl" ? 4101 : 4201,
        creation: "before",
      },
      identities: [{
        pid: modeId === "bash-wsl" ? 4101 : 4201,
        creation: "before",
      }],
      markerProcessCount: 1,
    },
    lineageAfter: {
      available: true,
      rootCreation: null,
      rootIdentity: null,
      rootPresent: false,
      identities: [],
      remainingIdentityCount: 0,
      markerProcessCount: 0,
      observationErrors: [],
      errors: [],
    },
  };
  if (modeId === "bash-wsl") {
    return {
      ...base,
      wslLedgerBefore: {
        available: true,
        markerCount: 1,
        identities: [{ pid: 4102 }],
      },
      wslLedgerAfter: {
        available: true,
        markerCount: 0,
        identities: [],
      },
    };
  }
  return {
    ...base,
    backendCleanup: {
      kind: "native-process-tree",
      observed: true,
      prepositive: structuredClone(base.lineageInitial),
      postempty: structuredClone(base.lineageAfter),
      observationErrors: [],
    },
  };
}

function reuseDriverSummary(modeId) {
  const sessionIdSha256 = modeId === "bash-wsl"
    ? "8".repeat(64)
    : "9".repeat(64);
  return {
    schemaVersion: 2,
    status: "PASS",
    mode: "real-turn",
    modeId,
    agentPresetRequested: modeId,
    agentPreset: modeId,
    tgzSha256: GUI_CANDIDATE_SHA,
    appAsarSha256: GUI_ASAR_SHA,
    sessionIdSha256,
    sourceHashes: { ...REUSE_DRIVER_SOURCE_HASHES },
    candidateBinding: {
      tgzRelativePath: "new-modes/dsh-plugin-bash-wsl-0.2.0.tgz",
      expectedSha256: GUI_CANDIDATE_SHA,
      supplied: true,
      freshRequired: true,
      isCanonical: false,
      candidateIndependent: true,
    },
    agentPresetBinding: {
      requested: modeId,
      sessionCreate: modeId,
      sessionHeader: modeId,
      sessionHeaderIdSha256: sessionIdSha256,
      exact: true,
    },
    permission: reusePermission(modeId),
    observationChildClosed: true,
    cleanup: reuseCleanup(modeId),
  };
}

function reuseRosterFixture(mutateSummary, mutateEvidence) {
  mkdirSync(RUN_OUTPUT_ROOT, { recursive: true });
  const fixtureRoot = mkdtempSync(join(RUN_OUTPUT_ROOT, "native-roster-reuse-offline-"));
  try {
    const summaries = new Map([
      ["bash-wsl", reuseDriverSummary("bash-wsl")],
      ["bash-git-bash", reuseDriverSummary("bash-git-bash")],
    ]);
    mutateSummary?.(summaries);
    const modeDriverArtifacts = [];
    for (const [modeId, summary] of summaries) {
      const artifactPath = join(fixtureRoot, `${modeId}.json`);
      writeFileSync(artifactPath, `${JSON.stringify(summary)}\n`);
      modeDriverArtifacts.push({
        modeId,
        path: relative(ROOT, artifactPath).replaceAll("\\", "/"),
        sha256: sha256(artifactPath),
      });
    }
    const nativeArtifactPath = join(fixtureRoot, "native-runtime-validator.json");
    writeFileSync(nativeArtifactPath, readFileSync(NATIVE_FIXTURE_TEMPLATE_PATH));
    const nativeArtifactSha256 = sha256(nativeArtifactPath);
    const evidence = {
      ...guiRosterFixture("mcp__windows_mcp", true, GUI_CANDIDATE_SHA),
      cleanup: reuseCleanup("bash-wsl"),
      modeDriverArtifacts,
      pwshPreservation: {
        source: "actual-desktop-runtime",
        candidateTgzSha256: GUI_CANDIDATE_SHA,
        appAsarSha256: GUI_ASAR_SHA,
        executableSha256: GUI_EXECUTABLE_SHA,
        probeSourceSha256: GUI_NATIVE_PROBE_SHA,
        artifact: {
          path: relative(ROOT, nativeArtifactPath).replaceAll("\\", "/"),
          sha256: nativeArtifactSha256,
        },
      },
    };
    mutateEvidence?.(evidence, fixtureRoot);
    return validateNativeModesGuiRosterEvidence(evidence, {
      candidateSha256: GUI_CANDIDATE_SHA,
      expectedAsarSha256: GUI_ASAR_SHA,
      expectedExecutableSha256: GUI_EXECUTABLE_SHA,
      root: ROOT,
      runOutputRoot: RUN_OUTPUT_ROOT,
      fileSha256: sha256,
      driverSourceHashes: REUSE_DRIVER_SOURCE_HASHES,
      nativeProbeSourceSha256: GUI_NATIVE_PROBE_SHA,
    });
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

function expectReuseRosterRejected(name, mutateSummary, mutateEvidence, pattern) {
  const result = reuseRosterFixture(mutateSummary, mutateEvidence);
  assert.equal(result.ok, false, `${name} unexpectedly passed`);
  assert.match(result.detail, pattern, `${name} reported an unexpected failure`);
  console.log(`PASS ${name}`);
}

function expectGuiRosterRejected(name, source, independent, pattern) {
  const result = validateNativeModesGuiRosterEvidence(
    guiRosterFixture(source, independent),
    {
      candidateSha256: CANONICAL_TGZ_SHA256,
      expectedAsarSha256: PROBE_SOURCE_SHA,
      expectedExecutableSha256: DIST_SHA,
    },
  );
  assert.equal(result.ok, false, `${name} unexpectedly passed`);
  assert.match(result.detail, pattern, `${name} reported an unexpected failure`);
  console.log(`PASS ${name}`);
}

assert.equal(
  validateNativeModesGuiRosterEvidence(guiRosterFixture("mcp__windows_mcp"), {
    candidateSha256: CANONICAL_TGZ_SHA256,
    expectedAsarSha256: PROBE_SOURCE_SHA,
    expectedExecutableSha256: DIST_SHA,
  }).ok,
  true,
);
console.log("PASS independent Windows MCP GUI roster source (synthetic, not runtime qualification)");
expectGuiRosterRejected("GUI roster unknown source", "unknown-gui-driver", true, /allowlisted GUI observation/);
expectGuiRosterRejected("GUI roster driver source", "run-owned-gui-session-driver", true, /allowlisted GUI observation/);
expectGuiRosterRejected("GUI roster synthetic source", "synthetic-fixture", true, /allowlisted GUI observation/);
expectGuiRosterRejected("GUI roster non-independent source", "mcp__windows_mcp", false, /allowlisted GUI observation/);

assert.equal(
  reuseRosterFixture().ok,
  true,
);
console.log("PASS protected-fixture reuse roster with bound driver artifacts (synthetic, not runtime qualification)");
expectReuseRosterRejected("reuse roster requires actual Desktop pwsh preservation evidence", undefined, (evidence) => {
  delete evidence.pwshPreservation;
}, /pwsh preservation/);
expectReuseRosterRejected("reuse roster rejects a native artifact hash mismatch", undefined, (evidence) => {
  evidence.pwshPreservation.artifact.sha256 = "0".repeat(64);
}, /pwsh preservation/);
expectReuseRosterRejected("reuse roster rejects a stale native probe source", undefined, (evidence) => {
  evidence.pwshPreservation.probeSourceSha256 = "0".repeat(64);
}, /pwsh preservation/);
expectReuseRosterRejected("reuse roster rejects only a self-declared pwsh boolean", undefined, (evidence) => {
  evidence.roster.pwshVisible = true;
  delete evidence.pwshPreservation;
}, /pwsh preservation/);
expectReuseRosterRejected("reuse roster rejects a non-native Desktop artifact", undefined, (evidence, fixtureRoot) => {
  const path = join(fixtureRoot, "invalid-native.json");
  writeFileSync(path, JSON.stringify({ schemaVersion: 1, status: "PASS" }));
  evidence.pwshPreservation.artifact = {
    path: relative(ROOT, path).replaceAll("\\", "/"),
    sha256: sha256(path),
  };
}, /pwsh preservation/);
expectReuseRosterRejected("reuse roster requires complete prepositive PID/CreationDate identity", (summaries) => {
  delete summaries.get("bash-wsl").cleanup.lineageInitial.rootIdentity;
}, undefined, /driver artifacts/);
expectReuseRosterRejected("reuse roster rejects mismatched rootCreation identity", (summaries) => {
  summaries.get("bash-git-bash").cleanup.lineageInitial.rootCreation = "different";
}, undefined, /driver artifacts/);
expectReuseRosterRejected("reuse roster rejects explicit post lineage error objects", (summaries) => {
  summaries.get("bash-wsl").cleanup.lineageAfter.errors = { query: "failed" };
}, undefined, /driver artifacts/);
expectReuseRosterRejected("reuse roster rejects explicit pre lineage observation errors", (summaries) => {
  summaries.get("bash-git-bash").cleanup.lineageInitial.observationErrors = "query failed";
}, undefined, /driver artifacts/);
expectReuseRosterRejected("reuse roster requires both bound driver artifacts", (summaries) => {
  summaries.delete("bash-git-bash");
}, undefined, /driver artifacts/);
expectReuseRosterRejected("reuse roster rejects a missing cleanup field", (summaries) => {
  delete summaries.get("bash-wsl").cleanup.profileContainment;
}, undefined, /driver artifacts/);
expectReuseRosterRejected("reuse roster rejects contradictory transient-root cleanup", (summaries) => {
  summaries.get("bash-wsl").cleanup.temporaryRootRemoved = true;
}, undefined, /driver artifacts/);
expectReuseRosterRejected("reuse roster rejects canonical TGZ hash drift", (summaries) => {
  summaries.get("bash-git-bash").cleanup.canonicalTgzAfterSha256 = "0".repeat(64);
}, undefined, /driver artifacts/);
expectReuseRosterRejected("reuse roster rejects profile containment drift", (summaries) => {
  summaries.get("bash-wsl").cleanup.profileContainment.entries[1].contained = false;
}, undefined, /driver artifacts/);
expectReuseRosterRejected("reuse roster rejects a WSL cleanup query error", (summaries) => {
  summaries.get("bash-wsl").cleanup.wslLedgerAfter.available = false;
}, undefined, /driver artifacts/);
expectReuseRosterRejected("reuse roster rejects force-kill cleanup", (summaries) => {
  summaries.get("bash-git-bash").cleanup.terminationAttempted = true;
}, undefined, /driver artifacts/);
expectReuseRosterRejected("reuse roster rejects a stale driver source hash", (summaries) => {
  summaries.get("bash-wsl").sourceHashes.probe = "0".repeat(64);
}, undefined, /driver artifacts/);
expectReuseRosterRejected("reuse roster rejects a stale candidate identity", (summaries) => {
  summaries.get("bash-git-bash").tgzSha256 = "0".repeat(64);
}, undefined, /driver artifacts/);
expectReuseRosterRejected("reuse roster rejects a missing permission envelope", (summaries) => {
  delete summaries.get("bash-wsl").permission;
}, undefined, /driver artifacts/);
expectReuseRosterRejected("reuse roster rejects a non-explicit Git permission scope", (summaries) => {
  summaries.get("bash-git-bash").permission.authorizationScope = "fixture-default";
}, undefined, /driver artifacts/);
expectReuseRosterRejected("reuse roster rejects a bound artifact hash mismatch", undefined, (evidence) => {
  evidence.modeDriverArtifacts[0].sha256 = "0".repeat(64);
}, /driver artifacts/);
expectReuseRosterRejected("reuse roster rejects an artifact path outside run output", undefined, (evidence) => {
  evidence.modeDriverArtifacts[0].path = "README.md";
}, /driver artifacts/);

console.log("Native mode release-validator offline regressions: 61 passed, 0 failed");
