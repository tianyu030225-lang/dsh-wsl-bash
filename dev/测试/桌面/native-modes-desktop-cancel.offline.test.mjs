#!/usr/bin/env node

/**
 * Synthetic validator-only Desktop cancel regressions.
 * This never qualifies a real Desktop run and deliberately models the public
 * evidence fields emitted by new-modes-desktop-artifact.mjs.
 */

import assert from "node:assert/strict";
import { validateNativeModesDesktopEvidence } from "./native-modes-release-validator.mjs";

const CANDIDATE_SHA = "a".repeat(64);
const PROBE_SOURCE_SHA = "b".repeat(64);
const ASAR_SHA = "c".repeat(64);
const EXE_SHA = "d".repeat(64);
const DIST_SHA = "e".repeat(64);
const MODE_IDS = ["bash-wsl", "bash-git-bash"];
const TOP_REQUIRED = [
  "desktop-runtime-version",
  "desktop-runtime-hashes",
  "tgz-content-dependency-path-audit",
  "desktop-profile-installed-dist-identity",
  "desktop-profile-offline-install",
  "disabled-before:desktop-child",
  "enabled-retained:desktop-child",
  "disabled-after:desktop-child",
  "owned-profile-revision-scope",
  "protected-stock-default-profile",
];
const DISABLED_REQUIRED = [
  "disabled-roster",
  "disabled-tools-and-backends",
  "disabled-standard-agent-capability",
  "disabled-standard-preserved",
];
const ENABLED_REQUIRED = [
  "host-anchor",
  "official-service-presence",
  "mode-roster",
  "default-unchanged",
  "standard-doc-unchanged-before",
  "pwsh-preserved-root",
  "plugin-fiber-visible",
  "retained-agent-setup",
  "plugin-unload-retained-revision",
  "plugin-unload-root-cleanup",
  "plugin-unload-retained-prompt",
  "retained-revision-release",
  "stock-default-after-unload",
];
const ENABLED_PROBE_REQUIRED = ENABLED_REQUIRED.filter((id) => ![
  "mode-roster",
  "default-unchanged",
  "plugin-unload-retained-revision",
  "plugin-unload-root-cleanup",
  "retained-revision-release",
].includes(id));
const ADVANCED_COMMON = [
  "background-process-cleanup",
  "natural-exit-reset",
  "timeout-reset",
  "cancel-reset",
  "cross-agent-isolation",
];
const ADVANCED_GIT = [
  "standing-full-access",
  "native-pid-pty",
  "helper-job-quiescence",
  "natural-exit-delayed-background",
  "natural-exit-noisy-background",
];
const CONTROLLED_PROMPT_CONTRACT_WSL =
  "OSC133D-BEL+__DSH_PERSISTENT_BASH_PROMPT__ ";
const CONTROLLED_PROMPT_CONTRACT_GIT =
  "OSC133D-BEL+canonical-status;__DSH_PERSISTENT_BASH_PROMPT__+visible-__DSH_PERSISTENT_BASH_PROMPT__";

function check(id, evidence = {}) {
  return { id, status: "PASS", evidence };
}

function cleanResult(output) {
  return {
    parsedExitCode: 0,
    isError: false,
    error: null,
    timedOut: false,
    aborted: false,
    output,
  };
}

function managedSettlements() {
  return [{
    status: "fulfilled",
    value: { done: { exitCode: 0, signal: null }, waitForExit: true },
  }];
}

function managedCapabilities() {
  return [{
    hasDone: true,
    hasWaitForExit: true,
    hasTerminate: true,
    resolveError: null,
  }];
}

function terminalSnapshots(modeId, suffix) {
  return [{
    sessionId: `${modeId}-${suffix}`,
    type: modeId,
    status: "running",
    pid: modeId === "bash-git-bash" ? 2001 : null,
  }];
}

function backgroundEvidence(modeId) {
  const backendType = modeId === "bash-git-bash" ? "git-bash" : "wsl";
  const promptContract = backendType === "git-bash"
    ? CONTROLLED_PROMPT_CONTRACT_GIT
    : CONTROLLED_PROMPT_CONTRACT_WSL;
  const hasDisplayCsiGap = backendType === "git-bash";
  const nonce = "a1b2c3d4-1234";
  const endIndex = hasDisplayCsiGap ? 105 : 80;
  const promptAt = hasDisplayCsiGap ? 110 : 100;
  const promptOscAt = 90;
  const promptOscEndAt = 100;
  const promptControlPayload = hasDisplayCsiGap
    ? "133;D;0;__DSH_PERSISTENT_BASH_PROMPT__"
    : "133;D;0";
  const promptControlToken = `\u001b]${promptControlPayload}\u0007`;
  const visibleToken = hasDisplayCsiGap
    ? "__DSH_PERSISTENT_BASH_PROMPT__"
    : "__DSH_PERSISTENT_BASH_PROMPT__ ";
  const readinessPair = {
    kind: hasDisplayCsiGap ? "native-full-control" : "wsl-adjacent-visible",
    complete: true,
    controlAt: promptOscAt,
    controlEndAt: promptOscEndAt,
    controlToken: promptControlToken,
    controlPayload: promptControlPayload,
    controlStatusText: "0",
    controlStatus: 0,
    completeValidControl: hasDisplayCsiGap,
    legacyControlValid: !hasDisplayCsiGap,
    visibleAt: promptAt,
    visibleEndAt: promptAt + 31,
    visibleToken,
    byteAdjacent: !hasDisplayCsiGap,
    gapAt: promptOscEndAt,
    gapEndAt: promptAt,
    gapBytes: hasDisplayCsiGap ? 10 : 0,
    gapText: "",
    displayCsiComplete: hasDisplayCsiGap,
    displayCsiWellFormed: true,
  };
  const frame = (source) => {
    const publicVisible = source === "official-terminals.read";
    return ({
    nonce,
    startIndex: 10,
    endIndex,
    nextStartIndex: null,
    exitCode: 0,
    startObserved: true,
    endObserved: true,
    promptAfterEnd: true,
    promptAt,
    promptEndAt: promptAt + 31,
    publicVisiblePrompt: publicVisible,
    promptOscAt: publicVisible ? null : promptOscAt,
    promptOscEndAt: publicVisible ? null : promptOscEndAt,
    promptControlAt: publicVisible ? null : promptOscAt,
    promptControlEndAt: publicVisible ? null : promptOscEndAt,
    promptControlToken: publicVisible ? null : promptControlToken,
    promptControlPayload: publicVisible ? null : promptControlPayload,
    promptControlStatusText: publicVisible ? null : "0",
    promptControlStatus: publicVisible ? null : 0,
    promptControlCompleteValid: publicVisible ? false : hasDisplayCsiGap,
    promptControlLegacyValid: publicVisible ? false : !hasDisplayCsiGap,
    promptControlByteAdjacent: publicVisible ? false : !hasDisplayCsiGap,
    readinessPair: publicVisible ? null : readinessPair,
    promptContract,
    promptVisibleGap: "",
    promptDisplayCsiComplete: publicVisible ? false : hasDisplayCsiGap,
    promptDisplayCsiWellFormed: true,
    promptDisplayCsi: !publicVisible && backendType === "git-bash"
      ? [
        { token: "\u001b[2J", at: 100, endAt: 104 },
        { token: "\u001b[m", at: 104, endAt: 107 },
        { token: "\u001b[H", at: 107, endAt: 110 },
      ]
      : [],
    oscInFrame: !publicVisible && source === "public-subprocess.stdout data",
    noisyAfterStart: true,
    noisyAfterEnd: false,
    isNew: true,
    rollingWindowSha256: "f".repeat(64),
    rollingWindowBytes: 65_536,
    source,
    backendType,
    });
  };
  const publicFrame = frame("official-terminals.read");
  const rawFrame = frame("public-subprocess.stdout data");
  const publicStreamTrace = {
    frameStarts: [{ nonce, at: 10 }],
    frameEnds: [{ nonce, exitCode: 0, at: endIndex }],
    observationMode: "public-visible",
    hasVisiblePrompt: true,
    hasControlledPrompt: false,
    promptPairs: [{
      publicVisible: true,
      readinessPair: null,
      completeValidControl: false,
      legacyControlValid: false,
      byteAdjacent: false,
    }],
  };
  const rawStreamTrace = {
    frameStarts: [{ nonce, at: 10 }],
    frameEnds: [{ nonce, exitCode: 0, at: endIndex }],
    observationMode: "raw",
  };
  return {
    backgroundOk: true,
    noisyOutputObserved: true,
    start: cleanResult("background-start"),
    stop: cleanResult("bg-reaped pid=7001 jobPresentBefore=1 aliveBefore=1 killAttempted=1 killStatus=0 waitAttempted=1 waitStatus=143 aliveAfter=0 jobsBefore=7001 jobsAfter="),
    publicTerminalObservations: [{
      source: "official-terminals.read rolling64KiB snapshots",
      observerDeadlineExceeded: false,
      snapshots: [{
        observation: {
          listAvailable: true,
          readAvailable: true,
          observationErrors: [],
          reads: [{ sessionId: `${modeId}-background`, streamTrace: publicStreamTrace }],
        },
      }],
    }],
    frameContracts: {
      publicFreshFrame: publicFrame,
      rawFreshFrame: rawFrame,
      sameFreshFrameNonce: true,
      publicCandidates: [publicFrame],
      rawCandidates: [rawFrame],
    },
    rollingTrace: {
      observed: true,
      snapshotCount: 1,
      observationErrors: [],
      requiredTokens: [
        promptContract,
        "current START nonce",
        "current END:0",
      ],
      tokenSnapshots: [{
        backendType,
        promptContract,
        hasControlledPrompt: false,
        streamTrace: {
          observationMode: "public-visible",
          hasVisiblePrompt: true,
          hasControlledPrompt: false,
          promptPairs: [{
            publicVisible: true,
            readinessPair: null,
            completeValidControl: false,
            legacyControlValid: false,
            byteAdjacent: false,
          }],
        },
      }],
    },
    rawStdoutTrace: {
      source: "public-subprocess.stdout data",
      observerCount: 1,
      observed: true,
      snapshots: [{
        source: "public-subprocess.stdout data",
        available: true,
        installed: true,
        error: null,
        streamTrace: rawStreamTrace,
      }],
    },
    backgroundReap: {
      backgroundLinuxPid: 7001,
      jobPresentBefore: 1,
      aliveBefore: 1,
      killAttempted: 1,
      killStatus: 0,
      waitAttempted: 1,
      waitStatus: 143,
      aliveAfter: 0,
      jobsAfter: "",
      pidMatchesStart: true,
    },
    backgroundReapOk: true,
  };
}

function timeoutEvidence(modeId) {
  const timeoutOutput = [
    "Your command timed out after 10 seconds or experienced an OOM error. Below is partial output:",
    "[Command timed out or OOM]",
    "The persistent bash shell was reset; the next bash call starts from the workspace with a fresh current directory and environment.",
  ].join("\n");
  return {
    timeoutOk: true,
    timeout: {
      timedOut: null,
      aborted: null,
      output: timeoutOutput,
    },
    timeoutContract: { officialTimeoutText: true, timeoutMs: 10_000 },
    reset: cleanResult("timeout-state-reset\ntimeout-reset"),
    resetTool: {
      initial: { status: "fulfilled", value: null },
      afterAbort: null,
      timedOut: false,
      signalAborted: false,
    },
    readyObserved: true,
    timeoutGuarded: false,
    timeoutCallError: null,
    timeoutLeakCreated: false,
    nativeWindowsPids: modeId === "bash-git-bash" ? [3001, 3002] : [],
    timeoutHandleSettlements: managedSettlements(),
    timeoutHandlesToSettleCount: 1,
    timeoutHandleQuiesced: true,
    timeoutNewHandleCount: 1,
    timeoutExistingHandleObserved: true,
    timeoutExistingIdentityObserved: modeId === "bash-git-bash",
    timeoutExistingManagedHandles: managedCapabilities(),
    timeoutExistingTerminalSnapshots: terminalSnapshots(modeId, "timeout-old"),
    ...(modeId === "bash-wsl"
      ? {
        timeoutPublicSessionAtBarrier: {
          listAvailable: true,
          readAvailable: true,
          snapshots: [{ sessionId: "bash-wsl-timeout-public", type: "wsl" }],
          observationErrors: [],
        },
      }
      : {}),
    timeoutProcess: {
      required: modeId === "bash-git-bash",
      availableBefore: true,
      availableAfterDelay: true,
      hostAliveBefore: true,
      hostAliveAfterDelay: true,
      ownedIdentityCount: modeId === "bash-git-bash" ? 2 : 0,
      remaining: [],
      observationErrors: [],
    },
  };
}

function cancelEvidence(modeId) {
  return {
    cancelOk: true,
    cancelTimedOut: false,
    cancelStarted: true,
    abortSignalAborted: true,
    abortSignalReasonName: "AbortError",
    abortSignalReasonCode: null,
    abortContract: true,
    typedAbort: true,
    emptyOutputAbortContract: false,
    cancelError: { name: "AbortError", code: "ABORTED", message: "cancelled" },
    cancelResult: null,
    cancelLeakCreated: false,
    staleEnvironmentClean: true,
    cancelExistingHandleObserved: true,
    cancelExistingIdentityObserved: true,
    nativeWindowsPids: modeId === "bash-git-bash" ? [2001, 2002] : [],
    cancelHandleQuiesced: true,
    cancelHandlesToSettleCount: 1,
    cancelHandleSettlements: managedSettlements(),
    cancelExistingManagedHandles: managedCapabilities(),
    cancelExistingTerminalSnapshots: terminalSnapshots(modeId, "old-session"),
    reset: cleanResult("cancel-state-reset\ncancel-reset\n"),
    resetTool: {
      initial: { status: "fulfilled", value: null },
      afterAbort: null,
      timedOut: false,
      signalAborted: false,
    },
    ...(modeId === "bash-git-bash"
      ? {
        cancelProcess: {
          required: true,
          availableBefore: true,
          availableAfterDelay: true,
          hostAliveBefore: true,
          hostAliveAfterDelay: true,
          ownedIdentityCount: 2,
          remaining: [],
          observationErrors: [],
        },
      }
      : {
        publicSessionAtBarrier: {
          listAvailable: true,
          readAvailable: true,
          snapshots: [{ sessionId: "wsl-old-session", type: "wsl" }],
          observationErrors: [],
        },
      }),
  };
}

function modeLifecycleChecks(modeId) {
  const clean = cleanResult("ok");
  const checks = [
    ...ENABLED_REQUIRED.map((id) => check(`${modeId}:${id}`)),
    check(`${modeId}:standard-composition`, {
      mode: { id: modeId },
      rowPreservesStandard: true,
      deepConfigMatch: true,
      jsNodeCountMatch: true,
      stockBashRemoved: true,
      pluginRows: 1,
      persistentRows: 1,
      isolatedTerminalGroups: 1,
      nativeModeGroups: 1,
      configOk: true,
    }),
    check(`${modeId}:system-prompt`, {
      sectionCount: 1,
      sectionPresent: true,
      interpolate: false,
      exactInstalledText: true,
      oppositeHeaderAbsent: true,
      hasModeHeader: true,
      renderedPluginMarker: true,
      promptSchemaHasPwsh: true,
    }),
    check(`${modeId}:native-lifecycle`, {
      observerInstalled: true,
      positiveSpawnDelta: 1,
      firstResult: clean,
      secondResult: clean,
      output: "new-mode-owner-a\nnew-mode-owner-a-persisted\n",
    }),
    check(`${modeId}:owner-dispose`, {
      nativeHandlesSettled: true,
      nativeHandleCount: 1,
      nativeHandleApiOk: true,
      processCleanupOk: true,
      processAfterOwnerDisposeRows: [],
      nativeHandleCapabilities: managedCapabilities(),
      nativeHandleSettlements: managedSettlements(),
      afterActivity: false,
      snapshotsAfterDispose: [],
      processObservationErrors: [],
      cleanupObservationError: null,
    }),
    check(`${modeId}:background-process-cleanup`, backgroundEvidence(modeId)),
    check(`${modeId}:natural-exit-reset`, {
      naturalOk: true,
      naturalExit: { ...cleanResult("natural"), shellExited: true },
      reset: cleanResult("natural-exit-reset"),
      ...(modeId === "bash-git-bash"
        ? {
          processLedger: {
            available: true,
            ownedIdentityCount: 2,
            delayedMarkerCreated: false,
            afterDelayRows: [],
            remainingBeforeOwnerDispose: [],
            frame: { shellWinPid: 2101, backgroundWinPid: 2102 },
          },
        }
        : {}),
    }),
    check(`${modeId}:timeout-reset`, timeoutEvidence(modeId)),
    check(`${modeId}:cancel-reset`, cancelEvidence(modeId)),
    check(`${modeId}:cross-agent-isolation`, { crossOk: true }),
  ];
  if (modeId === "bash-git-bash") {
    checks.push(
      check(`${modeId}:standing-full-access`, { permissionAfter: "danger-full-access" }),
      check(`${modeId}:native-pid-pty`, { nativePid: 2201, truePty: true, helperSpawnObserved: true }),
      check(`${modeId}:helper-job-quiescence`, {
        nativeHandlesSettled: true,
        nativeHandleApiOk: true,
        processCleanupOk: true,
        processAfterOwnerDisposeRows: [],
        afterActivity: false,
        snapshotsAfterDispose: [],
        nativeHandleCapabilities: managedCapabilities(),
        nativeHandleSettlements: managedSettlements(),
        processObservationErrors: [],
      }),
    );
    for (const suffix of ["natural-exit-delayed-background", "natural-exit-noisy-background"]) {
      checks.push(check(`${modeId}:${suffix}`, {
        noisyOk: true,
        noisyOutputObserved: suffix.endsWith("noisy-background"),
        processLedger: {
          available: true,
          ownedIdentityCount: 2,
          markerCreated: false,
          afterDelayRows: [],
          remaining: [],
          frame: { shellWinPid: 2301, backgroundWinPid: 2302 },
        },
      }));
    }
  }
  return checks;
}

function phase(label, checks) {
  return {
    label,
    status: "PASS",
    exitCode: 0,
    signal: null,
    timedOut: false,
    error: null,
    closeObserved: true,
    reaped: true,
    evidence: { checks },
  };
}

function makeDesktopFixture() {
  const topChecks = TOP_REQUIRED.map((id) => {
    if (id === "desktop-runtime-hashes") return check(id, { appAsarSha256: ASAR_SHA, executableSha256: EXE_SHA });
    if (id === "tgz-content-dependency-path-audit") return check(id, {
      sha256: CANDIDATE_SHA,
      sourceDistHashes: { "dist/tools/persistent.js": DIST_SHA },
      tarDistHashes: { "dist/tools/persistent.js": DIST_SHA },
    });
    if (id.endsWith(":desktop-child")) return {
      id,
      status: "PASS",
      evidence: { childExitCode: 0, signal: null, timedOut: false, error: null, closeObserved: true, reaped: true },
    };
    return check(id);
  });
  const disabledChecks = [
    check("disabled-roster", { roster: [] }),
    check("disabled-tools-and-backends", { toolNames: [], terminalBackends: [] }),
    check("disabled-standard-agent-capability"),
    check("disabled-standard-preserved"),
  ];
  return {
    schemaVersion: 1,
    status: "PASS",
    probeIdentity: {
      sourcePath: "dev/测试/桌面/new-modes-desktop-artifact.mjs",
      sourceSha256: PROBE_SOURCE_SHA,
    },
    cleanup: { temporaryRootRemoved: true },
    checks: topChecks,
    phases: [
      phase("disabled-before", disabledChecks),
      phase("enabled-retained", [
        ...ENABLED_PROBE_REQUIRED.map((id) => check(id)),
        ...MODE_IDS.flatMap(modeLifecycleChecks),
        check("mode-roster", { ids: MODE_IDS }),
        check("default-unchanged", { defaultBefore: "standard", defaultAfter: ["standard"] }),
        check("plugin-unload-root-cleanup", { bundleReloadAttempted: true, pluginBashRemovedOrStockRestored: true, standardScopePreserved: true, globalPromptModeSections: [] }),
        check("plugin-unload-retained-revision", { unloadError: null, bundleReloadAttempted: true, retainedOutput: "retained-after-unload" }),
        check("retained-revision-release", { retainedActivityAfterDispose: false, retainedSnapshotsAfterDispose: [] }),
        check("bash-git-bash:no-implicit-escalation", { directDenied: true, directSpawnedSession: null, spawnDelta: 0, nativeSpawns: [] }),
      ]),
      phase("disabled-after", disabledChecks),
    ],
  };
}

const options = {
  candidateSha256: CANDIDATE_SHA,
  expectedAsarSha256: ASAR_SHA,
  expectedExecutableSha256: EXE_SHA,
  probeSourceSha256: PROBE_SOURCE_SHA,
};

function runCase(name, mutate, pattern, modeId = "bash-wsl") {
  const report = makeDesktopFixture();
  const cancel = report.phases[1].evidence.checks.find((item) => item.id === `${modeId}:cancel-reset`).evidence;
  mutate(cancel);
  const result = validateNativeModesDesktopEvidence(report, options);
  assert.equal(result.ok, false, `${name} unexpectedly passed`);
  assert.match(result.detail, pattern, `${name} failure detail changed`);
  console.log(`PASS ${name}`);
}

function runLifecycleCase(name, checkId, mutate, pattern, modeId = "bash-git-bash") {
  const report = makeDesktopFixture();
  const checkEvidence = report.phases[1].evidence.checks
    .find((item) => item.id === `${modeId}:${checkId}`).evidence;
  mutate(checkEvidence);
  const result = validateNativeModesDesktopEvidence(report, options);
  assert.equal(result.ok, false, `${name} unexpectedly passed`);
  assert.match(result.detail, pattern, `${name} failure detail changed`);
  console.log(`PASS ${name}`);
}

function runLifecyclePositiveCase(name, mutate, modeId = "bash-git-bash") {
  const report = makeDesktopFixture();
  const background = report.phases[1].evidence.checks
    .find((item) => item.id === `${modeId}:background-process-cleanup`).evidence;
  mutate(background.frameContracts.rawFreshFrame);
  const result = validateNativeModesDesktopEvidence(report, options);
  assert.equal(result.ok, true, `${name} unexpectedly failed: ${result.detail}`);
  console.log(`PASS ${name}`);
}

const baseline = validateNativeModesDesktopEvidence(makeDesktopFixture(), options);
assert.equal(baseline.ok, true);
console.log("PASS synthetic Desktop cancel baseline (not runtime qualification)");

runLifecyclePositiveCase("Git full control with ordinary body and zero CSI", (frame) => {
  frame.promptDisplayCsi = [];
  frame.promptDisplayCsiComplete = false;
  frame.promptDisplayCsiWellFormed = true;
  frame.promptVisibleGap = "ordinary-body";
  frame.readinessPair.gapText = "ordinary-body";
  frame.readinessPair.gapBytes = Buffer.byteLength("ordinary-body");
  frame.readinessPair.displayCsiComplete = false;
  frame.readinessPair.displayCsiWellFormed = true;
});

runLifecyclePositiveCase("Git full control after END with direct visible token", (frame) => {
  const controlAt = frame.endIndex + 1;
  const controlEndAt = controlAt + 14;
  frame.promptControlAt = controlAt;
  frame.promptControlEndAt = controlEndAt;
  frame.promptOscAt = controlAt;
  frame.promptOscEndAt = controlEndAt;
  frame.promptAt = controlEndAt;
  frame.promptDisplayCsi = [];
  frame.promptDisplayCsiComplete = true;
  frame.promptDisplayCsiWellFormed = true;
  frame.promptVisibleGap = "";
  frame.promptControlByteAdjacent = true;
  frame.readinessPair.controlAt = controlAt;
  frame.readinessPair.controlEndAt = controlEndAt;
  frame.readinessPair.visibleAt = controlEndAt;
  frame.readinessPair.visibleEndAt = controlEndAt + 31;
  frame.readinessPair.byteAdjacent = true;
  frame.readinessPair.gapAt = controlEndAt;
  frame.readinessPair.gapEndAt = controlEndAt;
  frame.readinessPair.gapBytes = 0;
  frame.readinessPair.gapText = "";
  frame.readinessPair.displayCsiComplete = true;
  frame.readinessPair.displayCsiWellFormed = true;
});

runCase("missing typed abort", (cancel) => {
  cancel.typedAbort = false;
  cancel.cancelError = null;
}, /typed AbortError\/ABORTED/);
runCase("empty generic error", (cancel) => {
  cancel.typedAbort = false;
  cancel.emptyOutputAbortContract = true;
  cancel.cancelError = { name: "Error", code: null, message: "" };
}, /typed AbortError\/ABORTED/);
runCase("cancel was not started", (cancel) => {
  cancel.cancelStarted = false;
}, /typed AbortError\/ABORTED/);
runCase("existing handle was not settled", (cancel) => {
  cancel.cancelHandleQuiesced = false;
  cancel.cancelHandleSettlements = [{ status: "pending" }];
}, /typed AbortError\/ABORTED/);
runCase("old identity remained", (cancel) => {
  cancel.cancelProcess.remaining = [{ pid: 2001, identity: "old" }];
}, /typed AbortError\/ABORTED/, "bash-git-bash");

console.log("Desktop cancel schema offline regressions: 6 passed, 0 failed");

runLifecycleCase("owner capabilities empty", "owner-dispose", (owner) => {
  owner.nativeHandleCapabilities = [];
}, /owner-dispose did not prove/);
runLifecycleCase("owner count mismatch", "owner-dispose", (owner) => {
  owner.nativeHandleCount = 2;
}, /owner-dispose did not prove/);
runLifecycleCase("owner done outcome missing", "owner-dispose", (owner) => {
  owner.nativeHandleSettlements[0].value.done = null;
}, /owner-dispose did not prove/);
runLifecycleCase("owner empty done outcome", "owner-dispose", (owner) => {
  owner.nativeHandleSettlements[0].value.done = {};
}, /owner-dispose did not prove/);
runLifecycleCase("helper capabilities empty", "helper-job-quiescence", (helper) => {
  helper.nativeHandleCapabilities = [];
}, /helper-job-quiescence did not prove/);
runLifecycleCase("helper settlement mismatch", "helper-job-quiescence", (helper) => {
  helper.nativeHandleSettlements = [];
}, /helper-job-quiescence did not prove/);
runLifecycleCase("helper done outcome missing", "helper-job-quiescence", (helper) => {
  helper.nativeHandleSettlements[0].value.done = null;
}, /helper-job-quiescence did not prove/);
runLifecycleCase("helper incomplete done outcome", "helper-job-quiescence", (helper) => {
  helper.nativeHandleSettlements[0].value.done = { exitCode: 0 };
}, /helper-job-quiescence did not prove/);
runLifecycleCase("timeout official text missing", "timeout-reset", (timeout) => {
  timeout.timeoutContract.officialTimeoutText = false;
}, /timeout-reset did not prove the official 10-second timeout text/);
runLifecycleCase("WSL timeout public read missing", "timeout-reset", (timeout) => {
  timeout.timeoutPublicSessionAtBarrier.readAvailable = false;
}, /timeout-reset did not prove the official 10-second timeout text/, "bash-wsl");

console.log("Desktop owner/helper/timeout schema offline regressions: 10 passed, 0 failed");

runLifecycleCase("background public/raw nonce mismatch", "background-process-cleanup", (background) => {
  background.frameContracts.sameFreshFrameNonce = false;
}, /background-process-cleanup did not prove/);
runLifecycleCase("background selected frame borrowed a foreign nonce", "background-process-cleanup", (background) => {
  background.frameContracts.rawFreshFrame.nonce = "foreign-frame";
}, /background-process-cleanup did not prove/);
runLifecycleCase("background next-frame boundary overlaps END", "background-process-cleanup", (background) => {
  background.frameContracts.publicFreshFrame.nextStartIndex = 70;
}, /background-process-cleanup did not prove/);
runLifecycleCase("background public query had zero observations", "background-process-cleanup", (background) => {
  background.publicTerminalObservations[0].snapshots = [];
}, /background-process-cleanup did not prove/);
runLifecycleCase("background raw observer had zero snapshots", "background-process-cleanup", (background) => {
  background.rawStdoutTrace.snapshots = [];
}, /background-process-cleanup did not prove/);
runLifecycleCase("background PID reap status was not observed", "background-process-cleanup", (background) => {
  background.backgroundReap.aliveAfter = 1;
}, /background-process-cleanup did not prove/);
runLifecycleCase("background natural completion was not active kill", "background-process-cleanup", (background) => {
  background.backgroundReap.jobPresentBefore = 0;
}, /background-process-cleanup did not prove/);
runLifecycleCase("background wait used non-kill status", "background-process-cleanup", (background) => {
  background.backgroundReap.waitStatus = 0;
}, /background-process-cleanup did not prove/);
runLifecycleCase("background prompt token was not after current END", "background-process-cleanup", (background) => {
  background.frameContracts.publicFreshFrame.promptAfterEnd = false;
}, /background-process-cleanup did not prove/);

runLifecycleCase("background raw fresh frame was missing", "background-process-cleanup", (background) => {
  delete background.frameContracts.rawFreshFrame;
}, /background-process-cleanup did not prove/);

runLifecycleCase("background public fresh frame reused a baseline seed", "background-process-cleanup", (background) => {
  background.frameContracts.publicFreshFrame.isNew = false;
}, /background-process-cleanup did not prove/);

runLifecycleCase("public observer forged a raw OSC control field", "background-process-cleanup", (background) => {
  const frame = background.frameContracts.publicFreshFrame;
  frame.promptControlToken = "\u001b]133;D;0;__DSH_PERSISTENT_BASH_PROMPT__\u0007";
}, /background-process-cleanup did not prove/);

runLifecycleCase("public observer forged a readiness pair", "background-process-cleanup", (background) => {
  background.frameContracts.publicFreshFrame.readinessPair = {
    complete: true,
    completeValidControl: true,
  };
}, /background-process-cleanup did not prove/);

runLifecycleCase("background prompt contract used the retired Git literal", "background-process-cleanup", (background) => {
  background.frameContracts.rawFreshFrame.promptContract = "ansi-stripped-literal-dsh>";
}, /background-process-cleanup did not prove/);

runLifecycleCase("Git background used the WSL trailing-space contract", "background-process-cleanup", (background) => {
  background.frameContracts.rawFreshFrame.promptContract =
    CONTROLLED_PROMPT_CONTRACT_WSL;
}, /background-process-cleanup did not prove/);

runLifecycleCase("Git background accepted a non-display CSI query in the prompt gap", "background-process-cleanup", (background) => {
  background.frameContracts.rawFreshFrame.promptDisplayCsi = [
    { token: "\u001b[6n", at: 100, endAt: 104 },
  ];
}, /background-process-cleanup did not prove/);

runLifecycleCase("Git background omitted its prompt display-CSI evidence", "background-process-cleanup", (background) => {
  delete background.frameContracts.rawFreshFrame.promptDisplayCsi;
}, /background-process-cleanup did not prove/);

runLifecycleCase("Git background accepted a non-canonical prompt status", "background-process-cleanup", (background) => {
  const frame = background.frameContracts.rawFreshFrame;
  frame.promptControlStatusText = "01";
  frame.promptControlStatus = 1;
  frame.readinessPair.controlStatusText = "01";
  frame.readinessPair.controlStatus = 1;
}, /background-process-cleanup did not prove/);

runLifecycleCase("Git background accepted a prompt control without full readiness pair", "background-process-cleanup", (background) => {
  delete background.frameContracts.rawFreshFrame.readinessPair;
}, /background-process-cleanup did not prove/);

runLifecycleCase("Git background accepted a prompt control before START", "background-process-cleanup", (background) => {
  const frame = background.frameContracts.rawFreshFrame;
  frame.promptControlAt = frame.startIndex;
  frame.readinessPair.controlAt = frame.promptControlAt;
}, /background-process-cleanup did not prove/);

runLifecycleCase("WSL background accepted a non-adjacent prompt", "background-process-cleanup", (background) => {
  const frame = background.frameContracts.rawFreshFrame;
  frame.promptControlByteAdjacent = false;
  frame.readinessPair.byteAdjacent = false;
}, /background-process-cleanup did not prove/, "bash-wsl");

runLifecycleCase("WSL background used the Git display-CSI contract", "background-process-cleanup", (background) => {
  background.frameContracts.rawFreshFrame.promptContract =
    CONTROLLED_PROMPT_CONTRACT_GIT;
}, /background-process-cleanup did not prove/, "bash-wsl");

runLifecycleCase("background prompt positions were not bound to the atomic OSC pair", "background-process-cleanup", (background) => {
  const frame = background.frameContracts.rawFreshFrame;
  frame.promptOscAt = 91;
}, /background-process-cleanup did not prove/);

runLifecycleCase("background rolling snapshot falsely claimed a raw controlled prompt", "background-process-cleanup", (background) => {
  const trace = background.rollingTrace.tokenSnapshots[0].streamTrace;
  trace.hasControlledPrompt = true;
  trace.hasVisiblePrompt = false;
}, /background-process-cleanup did not prove/);

console.log("Desktop background frame/reap schema offline regressions: 25 passed, 0 failed");
