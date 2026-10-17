#!/usr/bin/env node

import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  buildGitNormalCloseGapEvidence,
  KNOWN_GIT_NORMAL_CLOSE_ERROR,
  KNOWN_SESSION_DRIVER_SHA256,
} from "./git-normal-close-gap-evidence.mjs";
import { combineOwnedNativeDriverSummaries } from "./combine-owned-gui-native-evidence.mjs";
import { qualifyGitNormalCloseGapForRoster } from "./native-modes-release-validator.mjs";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(TEST_DIR, "../../..");
const RUN_OUTPUT_ROOT = join(ROOT, "测试", "运行产物");

const EXPECTED = {
  modeId: "bash-git-bash",
  fixture: "gui-human-canonical-20261010-2340",
  runtime: "DeepSeek Harness Desktop 0.2.1-rc.2",
  provider: "deepseek-account",
  model: "deepseek-flash",
  candidateSha256: "a".repeat(64),
  appAsarSha256: "b".repeat(64),
  sourceHashes: {
    probe: "c".repeat(64),
    sessionDriver: KNOWN_SESSION_DRIVER_SHA256,
    launcher: "e".repeat(64),
    wrapper: "f".repeat(64),
    candidateBinding: "0".repeat(64),
  },
};

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function clone(value) {
  return structuredClone(value);
}

function makeLineage() {
  return [
    {
      pid: 1001,
      parentPid: 999,
      name: "node.exe",
      creation: "2026-10-16T00:00:00.001Z",
    },
    {
      pid: 1002,
      parentPid: 1001,
      name: "DeepSeek Harness.exe",
      creation: "2026-10-16T00:00:00.002Z",
    },
    {
      pid: 1003,
      parentPid: 1002,
      name: "DeepSeek Harness.exe",
      creation: "2026-10-16T00:00:00.003Z",
    },
    {
      pid: 1004,
      parentPid: 1003,
      name: "DeepSeek Harness.exe",
      creation: "2026-10-16T00:00:00.004Z",
    },
    {
      pid: 1005,
      parentPid: 1004,
      name: "conhost.exe",
      creation: "2026-10-16T00:00:00.005Z",
    },
    {
      pid: 1006,
      parentPid: 1004,
      name: "bash.exe",
      creation: "2026-10-16T00:00:00.006Z",
    },
    {
      pid: 1007,
      parentPid: 1006,
      name: "bash.exe",
      creation: "2026-10-16T00:00:00.007Z",
    },
  ];
}

function makeFixtureValues() {
  const attemptId = "bash-git-bash-offline-attempt-001";
  const sessionIdSha256 = "1".repeat(64);
  const lineage = makeLineage();
  const calls = [
    {
      sequence: 1,
      toolName: "bash",
      callIdSha256: "2".repeat(64),
      resultCallIdSha256: "2".repeat(64),
      accepted: true,
      completed: true,
      parsedExitCode: 0,
      isError: false,
      timedOut: false,
      aborted: false,
      outputMarker: "DSH_GUI_TURN1:DSH_GUI_TURN1",
    },
    {
      sequence: 2,
      toolName: "bash",
      callIdSha256: "3".repeat(64),
      resultCallIdSha256: "3".repeat(64),
      accepted: true,
      completed: true,
      parsedExitCode: 0,
      isError: false,
      timedOut: false,
      aborted: false,
      outputMarker: "DSH_GUI_TURN2:DSH_GUI_TURN1",
    },
  ];
  const permission = {
    mode: "danger-full-access",
    authorizationGranted: true,
    authorizationInput: "DSH_GUI_ALLOW_GIT_FULL_ACCESS=1",
    authorizationSource: "explicit-user-test-authorization",
    authorizationScope: "owned-gui-session",
    command: {
      name: "permission",
      definitionId: "@deepseek-ai/dsh-permission-presets",
      inputHint: "<preset>",
    },
    prePromptProjection: { asOfSeq: 12, currentValue: "danger-full-access" },
    fullAccess: {
      projection: { asOfSeq: 10, currentValue: "danger-full-access" },
    },
  };
  const emptyQuery = {
    available: true,
    verified: false,
    rootPresent: false,
    rootCreation: null,
    rootIdentity: null,
    identities: [],
    remainingIdentityCount: 0,
    markerProcessCount: 0,
  };
  const knownBackendFailure = {
    kind: "native-process-tree",
    source: "owned Windows CIM Win32_Process CreationDate lineage",
    observed: false,
    prepositive: clone(emptyQuery),
    postempty: clone(emptyQuery),
    creationIdentities: [],
    observationErrors: [KNOWN_GIT_NORMAL_CLOSE_ERROR],
  };
  const cleanup = {
    childClosed: true,
    socketClosed: true,
    queueEnded: true,
    reaped: true,
    terminationAttempted: false,
    killAuthorizedByLineage: false,
    officialSessionCancelAttempted: false,
    officialSessionCancelSucceeded: false,
    lineageInitial: {
      available: true,
      verified: true,
      rootPresent: true,
      rootCreation: lineage[1].creation,
      rootIdentity: { pid: lineage[1].pid, creation: lineage[1].creation },
      identities: lineage.slice(1).map((entry) => ({
        pid: entry.pid,
        creation: entry.creation,
      })),
      markerProcessCount: 1,
    },
    lineageBeforeTerminate: clone(emptyQuery),
    lineageAfter: {
      available: true,
      verified: false,
      rootPresent: false,
      rootCreation: null,
      rootIdentity: null,
      identities: [],
      remainingIdentityCount: 0,
      markerProcessCount: 0,
    },
    backendCleanup: clone(knownBackendFailure),
  };
  const candidateBinding = {
    tgzRelativePath: "candidate/dsh-plugin-bash-wsl-0.2.0.tgz",
    expectedSha256: EXPECTED.candidateSha256,
    supplied: true,
    freshRequired: true,
    isCanonical: false,
    candidateIndependent: true,
  };
  const raw = {
    schemaVersion: 2,
    status: "FAIL",
    mode: "real-turn",
    modeId: EXPECTED.modeId,
    attemptId,
    fixture: EXPECTED.fixture,
    runtime: EXPECTED.runtime,
    tgzSha256: EXPECTED.candidateSha256,
    appAsarSha256: EXPECTED.appAsarSha256,
    sessionIdSha256,
    sourceHashes: { ...EXPECTED.sourceHashes },
    candidateBinding,
    provider: EXPECTED.provider,
    model: EXPECTED.model,
    modelRouteObserved: true,
    deepSeekModelObserved: true,
    preflightModelRouteObserved: true,
    promptAccepted: true,
    promptAttempted: true,
    observationReady: true,
    observationChildClosed: true,
    observationElapsedMs: 5_000,
    protocolFailure: false,
    failureReason: null,
    toolCalls: 2,
    toolResults: 2,
    toolErrors: 0,
    toolNames: ["bash", "bash"],
    markers: { DSH_GUI_TURN1: true, DSH_GUI_TURN2: true },
    turnStarts: 1,
    turnEnded: true,
    turnEndKind: "completed",
    cancelAttempted: false,
    cancelSucceeded: false,
    agentPresetRequested: EXPECTED.modeId,
    agentPreset: EXPECTED.modeId,
    agentPresetBinding: {
      requested: EXPECTED.modeId,
      sessionCreate: EXPECTED.modeId,
      sessionHeader: EXPECTED.modeId,
      sessionHeaderIdSha256: sessionIdSha256,
      exact: true,
    },
    cleanup,
    nativeModes: [{
      modeId: EXPECTED.modeId,
      sessionIdSha256,
      agentPresetBinding: {
        requested: EXPECTED.modeId,
        sessionCreate: EXPECTED.modeId,
        sessionHeader: EXPECTED.modeId,
        sessionHeaderIdSha256: sessionIdSha256,
        exact: true,
      },
      calls,
      callOrder: calls.map((call) => ({
        sequence: call.sequence,
        callIdSha256: call.callIdSha256,
        resultCallIdSha256: call.resultCallIdSha256,
      })),
      turnLedger: {
        turnStarts: 1,
        turnEnded: true,
        turnEndKind: "completed",
        toolCalls: 2,
        toolResults: 2,
        toolErrors: 0,
        markers: { DSH_GUI_TURN1: true, DSH_GUI_TURN2: true },
      },
      permission,
      cleanup: clone(cleanup),
      backendCleanup: clone(knownBackendFailure),
      normalExit: { closeObserved: true, reaped: true, aliveAfter: false },
    }],
    toolCallIdsSha256: calls.map((call) => call.callIdSha256),
    toolResultCallIdsSha256: calls.map((call) => call.resultCallIdSha256),
    nativeCallLedger: clone(calls),
    sessionTitle: "offline Git normal-close ordering gap",
    observationReadyAt: "2026-10-16T00:00:01.000Z",
  };
  raw.permission = clone(permission);
  const ready = {
    schemaVersion: 2,
    status: "OBSERVATION_READY",
    mode: "real-turn",
    modeId: EXPECTED.modeId,
    fixture: EXPECTED.fixture,
    runtime: EXPECTED.runtime,
    attemptId,
    resultArtifact: "raw-driver.json",
    observationArtifact: "ready.json",
    sessionIdSha256,
    tgzSha256: EXPECTED.candidateSha256,
    appAsarSha256: EXPECTED.appAsarSha256,
    provider: EXPECTED.provider,
    model: EXPECTED.model,
    followReady: true,
    toolCalls: 2,
    toolResults: 2,
    toolErrors: 0,
    toolNames: ["bash", "bash"],
    markers: { DSH_GUI_TURN1: true, DSH_GUI_TURN2: true },
    turnStarts: 1,
    turnEnded: true,
    turnEndKind: "completed",
    sessionTitle: raw.sessionTitle,
    observationReadyAt: raw.observationReadyAt,
    sourceHashes: clone(raw.sourceHashes),
    candidateBinding: clone(raw.candidateBinding),
    agentPresetBinding: clone(raw.agentPresetBinding),
    permission: clone(raw.permission),
    nativeCallLedger: clone(raw.nativeCallLedger),
    nativeModes: [clone(raw.nativeModes[0])],
  };
  const prepositive = {
    schemaVersion: 1,
    source: "PowerShell Get-CimInstance Win32_Process + Get-Process MainWindowTitle",
    capturedAt: "2026-10-16T00:00:03.000Z",
    attemptId,
    driver: {
      pid: lineage[0].pid,
      parentPid: lineage[0].parentPid,
      creation: lineage[0].creation,
      present: true,
    },
    guiRoot: {
      pid: lineage[1].pid,
      parentPid: lineage[1].parentPid,
      creation: lineage[1].creation,
      name: lineage[1].name,
      mainWindowTitleMatches: true,
      verifiedOwnedByDriver: true,
    },
    lineage,
    fixtureMarkerQueryAvailable: true,
    fixtureMarkerProcessCount: 3,
    fixtureMarkerPids: [lineage[1].pid, lineage[2].pid, lineage[3].pid],
    fixtureMarkerNames: [lineage[1].name, lineage[2].name, lineage[3].name],
    wslLedgerApplicable: false,
  };
  const postempty = {
    schemaVersion: 1,
    status: "POSTEMPTY_VERIFIED_RESULT_FAIL_PRESERVED",
    source: "existing Git result + independent Windows CIM",
    attemptId,
    result: {
      artifact: "raw-driver.json",
      status: "FAIL",
      observationReady: true,
      observationReadyAt: ready.observationReadyAt,
      observationChildClosed: true,
      observationElapsedMs: raw.observationElapsedMs,
      cleanupChildClosed: true,
      cleanupReaped: true,
      cleanupSocketClosed: true,
      terminationAttempted: false,
      toolCalls: 2,
      toolResults: 2,
      toolErrors: 0,
    },
    readyBinding: {
      officialSessionIdSha256: sessionIdSha256,
      modeId: EXPECTED.modeId,
      permission: "danger-full-access",
      authorizationInput: "DSH_GUI_ALLOW_GIT_FULL_ACCESS=1",
      authorizationScope: "owned-gui-session",
      tgzSha256: EXPECTED.candidateSha256,
      toolCalls: calls.map((call) => ({
        sequence: call.sequence,
        callIdSha256: call.callIdSha256,
        resultCallIdSha256: call.resultCallIdSha256,
        outputMarker: call.outputMarker,
        exitCode: call.parsedExitCode,
      })),
    },
    independentCimPostempty: {
      source: "PowerShell Get-CimInstance Win32_Process exact PID+Creation comparison",
      queriedAt: "2026-10-16T00:00:10.000Z",
      querySucceeded: true,
      queryFailureNotCountedAsEmpty: true,
      ownedIdentityMatches: 0,
      fixtureMarkerQueryAvailable: true,
      fixtureMarkerProcessCount: 0,
      identities: lineage.map((entry) => ({
        pid: entry.pid,
        expectedCreation: entry.creation,
        present: false,
        creationMatches: false,
      })),
    },
    wslLedger: { applicable: false },
  };
  const driverLaunch = {
    schemaVersion: 1,
    status: "STARTED",
    attemptId,
    driverPid: lineage[0].pid,
    resultArtifact: "raw-driver.json",
    observationArtifact: "ready.json",
  };
  return { raw, ready, prepositive, postempty, driverLaunch };
}

function writeFixture(mutate = undefined) {
  const root = mkdtempSync(join(RUN_OUTPUT_ROOT, "git-normal-close-gap-offline-"));
  try {
    const values = makeFixtureValues();
    mutate?.(values);
    const files = {
      rawDriver: ["raw-driver.json", "raw"],
      observationReady: ["ready.json", "ready"],
      cimPrepositive: ["prepositive.json", "prepositive"],
      cimPostempty: ["postempty.json", "postempty"],
      driverLaunch: ["driver-launch.json", "driverLaunch"],
    };
    const bindings = {};
    for (const [key, [filename, valueKey]] of Object.entries(files)) {
      const path = join(root, filename);
      writeFileSync(path, `${JSON.stringify(values[valueKey], null, 2)}\n`);
      bindings[key] = {
        path: relative(ROOT, path).replaceAll("\\", "/"),
        sha256: sha256(path),
      };
    }
    return { root, values, bindings };
  } catch (error) {
    removeFixtureRoot(root);
    throw error;
  }
}

function removeFixtureRoot(root) {
  const outputReal = realpathSync(RUN_OUTPUT_ROOT);
  const fixtureReal = realpathSync(root);
  const child = relative(outputReal, fixtureReal);
  assert.ok(child.length > 0 && child !== ".."
    && !child.startsWith(`..${child.includes("\\") ? "\\" : "/"}`)
    && !isAbsolute(child),
  "offline fixture cleanup target must be inside 测试/运行产物");
  rmSync(fixtureReal, { recursive: true, force: true });
  assert.equal(existsSync(fixtureReal), false, "offline fixture cleanup failed");
}

function build(fixture) {
  return buildGitNormalCloseGapEvidence(fixture.bindings, {
    root: ROOT,
    runOutputRoot: fixture.root,
    ...EXPECTED,
  });
}

function withFixture(mutate, callback) {
  let fixture;
  try {
    fixture = writeFixture(mutate);
    return callback(fixture);
  } finally {
    if (fixture?.root !== undefined && existsSync(fixture.root)) {
      removeFixtureRoot(fixture.root);
    }
  }
}

function rejects(name, mutate, pattern) {
  test(name, () => withFixture(mutate, (fixture) => {
    assert.throws(() => build(fixture), pattern);
  }));
}

test("strictly derives a bounded summary while preserving raw FAIL", () => {
  withFixture(undefined, (fixture) => {
    const result = build(fixture);
    assert.equal(result.status, "QUALIFIED_KNOWN_GAP");
    assert.equal(result.rawDriverStatus, "FAIL");
    assert.equal(result.rawFailure, KNOWN_GIT_NORMAL_CLOSE_ERROR);
    assert.equal(result.attemptId, fixture.values.raw.attemptId);
    assert.equal(result.backendCleanup.observed, true);
    assert.equal(result.backendCleanup.prepositive.identities.length, 7);
    assert.equal(result.backendCleanup.postempty.identities.length, 0);
    assert.equal(result.qualification.inputArtifacts.rawDriver.sha256,
      fixture.bindings.rawDriver.sha256);
    assert.equal(result.qualification.inputArtifacts.cimPostempty.sha256,
      fixture.bindings.cimPostempty.sha256);
    assert.equal(fixture.values.raw.status, "FAIL");
  });
});

test("aggregate recomputes the Git supplement without changing immutable raw FAIL", () => {
  withFixture(undefined, (fixture) => {
    const wslSummary = {
      ...clone(fixture.values.raw),
      status: "PASS",
      modeId: "bash-wsl",
      attemptId: "offline-wsl-attempt-001",
      nativeModes: [{ modeId: "bash-wsl" }],
    };
    const gitSummary = clone(fixture.values.raw);
    const result = combineOwnedNativeDriverSummaries(
      wslSummary,
      gitSummary,
      { adapter: "aggregate.json", ready: "aggregate-ready.json" },
      {
        gitNormalCloseGap: {
          bridge: {
            status: "QUALIFIED_KNOWN_GAP",
            rawDriverStatus: "FAIL",
            gapId: "GIT_NORMAL_CLOSE_BACKEND_PREPOSITIVE_AFTER_CLOSE",
            bindings: fixture.bindings,
          },
          root: ROOT,
          runOutputRoot: fixture.root,
          ...EXPECTED,
        },
      },
    );
    assert.equal(gitSummary.status, "FAIL");
    assert.equal(result.adapter.status, "PASS");
    assert.equal(result.adapter.nativeModeQualification.status, "AGGREGATE_QUALIFIED");
    assert.equal(result.adapter.nativeModeQualification.rawDriverStatus, "FAIL");
    assert.equal(result.adapter.nativeModeQualification.independentSupplementStatus,
      "QUALIFIED_KNOWN_GAP");
    assert.equal(result.modes.find((mode) => mode.modeId === "bash-git-bash")
      .backendCleanup.observed, true);
  });
});

test("aggregate refuses a Git raw FAIL without a known-gap bridge", () => {
  withFixture(undefined, (fixture) => {
    const wslSummary = {
      ...clone(fixture.values.raw),
      status: "PASS",
      modeId: "bash-wsl",
      nativeModes: [{ modeId: "bash-wsl" }],
    };
    assert.throws(() => combineOwnedNativeDriverSummaries(
      wslSummary,
      clone(fixture.values.raw),
    ), /requires an explicit known-gap supplement bridge/);
  });
});

test("roster qualification re-reads the same five proof files and recomputes the gap", () => {
  withFixture(undefined, (fixture) => {
    const derived = qualifyGitNormalCloseGapForRoster(
      {
        gitNormalCloseGap: {
          status: "QUALIFIED_KNOWN_GAP",
          rawDriverStatus: "FAIL",
          gapId: "GIT_NORMAL_CLOSE_BACKEND_PREPOSITIVE_AFTER_CLOSE",
          driverSha256: EXPECTED.sourceHashes.sessionDriver,
          bindings: fixture.bindings,
        },
      },
      fixture.bindings.rawDriver,
      {
        root: ROOT,
        runOutputRoot: fixture.root,
        candidateSha256: EXPECTED.candidateSha256,
        expectedAsarSha256: EXPECTED.appAsarSha256,
        driverSourceHashes: EXPECTED.sourceHashes,
      },
    );
    assert.equal(derived.status, "QUALIFIED_KNOWN_GAP");
    assert.equal(derived.rawDriverStatus, "FAIL");
    assert.equal(derived.gapId, "GIT_NORMAL_CLOSE_BACKEND_PREPOSITIVE_AFTER_CLOSE");
    assert.equal(derived.qualification.inputArtifacts.rawDriver.sha256,
      fixture.bindings.rawDriver.sha256);
  });
});

test("roster qualification rejects a bridge whose derived session binding was altered", () => {
  withFixture(undefined, (fixture) => {
    const derived = build(fixture);
    const bridge = {
      status: "QUALIFIED_KNOWN_GAP",
      rawDriverStatus: "FAIL",
      gapId: derived.gapId,
      driverSha256: EXPECTED.sourceHashes.sessionDriver,
      bindings: fixture.bindings,
      derivedNativeMode: {
        ...clone(derived.derivedNativeMode),
        sessionIdSha256: "9".repeat(64),
      },
    };
    assert.equal(qualifyGitNormalCloseGapForRoster(
      { gitNormalCloseGap: bridge },
      fixture.bindings.rawDriver,
      {
        root: ROOT,
        runOutputRoot: fixture.root,
        candidateSha256: EXPECTED.candidateSha256,
        expectedAsarSha256: EXPECTED.appAsarSha256,
        driverSourceHashes: EXPECTED.sourceHashes,
      },
    ), undefined);
  });
});

rejects("ordinary PASS is not accepted as the known-gap input", (values) => {
  values.raw.status = "PASS";
}, /raw driver is not the expected Git real-turn FAIL/);

rejects("short official session SHA is rejected", (values) => {
  values.ready.sessionIdSha256 = "1".repeat(8);
  values.postempty.readyBinding.officialSessionIdSha256 = "1".repeat(8);
}, /official READY artifact/);

rejects("additional backend error is rejected", (values) => {
  values.raw.cleanup.backendCleanup.observationErrors.push("unexpected query error");
  values.raw.nativeModes[0].cleanup.backendCleanup.observationErrors.push("unexpected query error");
  values.raw.nativeModes[0].backendCleanup.observationErrors.push("unexpected query error");
}, /unique known ordering-gap failure/);

rejects("different mode is rejected", (values) => {
  values.raw.modeId = "bash-wsl";
  values.raw.nativeModes[0].modeId = "bash-wsl";
}, /Git native mode envelope is missing/);

rejects("an extra native mode is rejected", (values) => {
  values.raw.nativeModes.push(clone(values.raw.nativeModes[0]));
}, /non-exclusive/);

test("caller cannot retarget the supplement to WSL", () => {
  withFixture(undefined, (fixture) => {
    assert.throws(() => buildGitNormalCloseGapEvidence(fixture.bindings, {
      root: ROOT,
      runOutputRoot: fixture.root,
      ...EXPECTED,
      modeId: "bash-wsl",
    }), /reviewed Git mode/);
  });
});

rejects("aborted tool result is rejected", (values) => {
  values.raw.nativeModes[0].calls[0].aborted = true;
}, /exact successful non-aborted call/);

rejects("forced termination is rejected", (values) => {
  values.raw.cleanup.terminationAttempted = true;
  values.raw.nativeModes[0].cleanup.terminationAttempted = true;
}, /timeout\/cancel\/forced termination/);

rejects("candidate SHA drift is rejected", (values) => {
  values.raw.tgzSha256 = "9".repeat(64);
}, /candidate SHA does not match/);

rejects("source hash drift is rejected", (values) => {
  values.raw.sourceHashes.probe = "9".repeat(64);
}, /driver source hash mismatch/);

test("caller cannot pin a different reviewed driver even with synchronized expectations", () => {
  withFixture(undefined, (fixture) => {
    assert.throws(() => buildGitNormalCloseGapEvidence(fixture.bindings, {
      root: ROOT,
      runOutputRoot: fixture.root,
      ...EXPECTED,
      sourceHashes: {
        ...EXPECTED.sourceHashes,
        sessionDriver: "9".repeat(64),
      },
    }), /reviewed driver/);
  });
});

rejects("attempt mismatch is rejected", (values) => {
  values.prepositive.attemptId = "other-attempt";
}, /CIM prepositive source\/attempt/);

rejects("mode callOrder must be derived directly from mode calls", (values) => {
  values.raw.nativeModes[0].callOrder[0].callIdSha256 = "9".repeat(64);
}, /mode callOrder does not directly match/);

test("path outside run output is rejected", () => {
  withFixture(undefined, (fixture) => {
    fixture.bindings.rawDriver.path = "README.md";
    assert.throws(() => build(fixture), /escapes the run output root/);
  });
});

test("bound file SHA mismatch is rejected before JSON qualification", () => {
  withFixture(undefined, (fixture) => {
    fixture.bindings.rawDriver.sha256 = "0".repeat(64);
    assert.throws(() => build(fixture), /content SHA-256 does not match/);
  });
});

rejects("duplicate prepositive PID is rejected", (values) => {
  values.prepositive.lineage[3].pid = values.prepositive.lineage[2].pid;
}, /duplicate PIDs/);

rejects("non-ISO process Creation is rejected", (values) => {
  values.prepositive.lineage[3].creation = "10/16/2026 00:00:00";
}, /complete ISO timestamp with timezone/);

rejects("prepositive GUI PID must anchor the raw initial lineage", (values) => {
  values.prepositive.guiRoot.pid = 9999;
}, /anchored to the raw driver lineage initial PID/);

rejects("prepositive after normal close but before postempty is rejected", (values) => {
  values.prepositive.capturedAt = "2026-10-16T00:00:07.000Z";
}, /timing does not straddle the normal close boundary/);

rejects("wrapper driver PID mismatch is rejected", (values) => {
  values.driverLaunch.driverPid = 7777;
}, /driver launch binding is not exact/);

rejects("same-named Host/helper tree with a broken parent edge is rejected", (values) => {
  values.prepositive.lineage[3].parentPid = values.prepositive.guiRoot.pid;
}, /Host -> helper -> ConHost\/Bash ownership/);

rejects("official READY permission drift is rejected", (values) => {
  values.ready.permission.mode = "workspace-write";
}, /source\/candidate\/session\/permission binding is not exact/);

rejects("official READY call ledger drift is rejected", (values) => {
  values.ready.nativeCallLedger[0].callIdSha256 = "9".repeat(64);
}, /source\/candidate\/session\/permission binding is not exact/);

rejects("caller source hash extras are rejected", (values) => {
  values.raw.sourceHashes.extra = "8".repeat(64);
}, /exactly the reviewed five keys/);

rejects("contradictory mode normal-exit facts are rejected", (values) => {
  values.raw.nativeModes[0].normalExit.aliveAfter = true;
}, /cleanup\/permission\/normal-exit facts contradict/);

rejects("missing ConHost/Bash chain is rejected", (values) => {
  values.prepositive.lineage.find((entry) => entry.name.toLowerCase() === "conhost.exe").name = "other.exe";
}, /Host\/helper\/ConHost\/Bash chain/);

rejects("prepositive after postempty is rejected", (values) => {
  values.prepositive.capturedAt = "2026-10-16T00:00:30.000Z";
}, /timing does not straddle the normal close boundary/);

rejects("postempty query failure is rejected", (values) => {
  values.postempty.independentCimPostempty.querySucceeded = false;
}, /postempty CIM query/);

rejects("postempty marker residual is rejected", (values) => {
  values.postempty.independentCimPostempty.fixtureMarkerProcessCount = 1;
}, /postempty CIM query/);

rejects("PID reuse without a different Creation is rejected", (values) => {
  values.postempty.independentCimPostempty.identities[0].present = true;
  values.postempty.independentCimPostempty.identities[0].observedCreation =
    values.postempty.independentCimPostempty.identities[0].expectedCreation;
}, /PID reuse was not explicitly distinguished/);

rejects("PID reuse with a non-ISO Creation is rejected", (values) => {
  values.postempty.independentCimPostempty.identities[0].present = true;
  values.postempty.independentCimPostempty.identities[0].observedCreation =
    "10/16/2026 00:00:05";
}, /complete ISO timestamp with timezone/);

rejects("PID reuse with a future Creation is rejected", (values) => {
  values.postempty.independentCimPostempty.identities[0].present = true;
  values.postempty.independentCimPostempty.identities[0].observedCreation =
    "2026-10-16T00:00:10.001Z";
}, /later than the old identity and no later than query/);

test("PID reuse with an explicitly different Creation is not called residual", () => {
  withFixture((values) => {
    values.postempty.independentCimPostempty.identities[0].present = true;
    values.postempty.independentCimPostempty.identities[0].observedCreation =
      "2026-10-16T00:00:05.001Z";
  }, (fixture) => {
    assert.equal(build(fixture).status, "QUALIFIED_KNOWN_GAP");
  });
});

console.log("Git normal-close gap offline regressions: strict positive and negative cases passed");

