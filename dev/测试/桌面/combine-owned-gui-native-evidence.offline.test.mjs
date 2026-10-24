#!/usr/bin/env node

import test from "node:test";
import assert from "node:assert/strict";
import { combineOwnedNativeDriverSummaries } from "./combine-owned-gui-native-evidence.mjs";

const hash = (value) => String(value).padEnd(64, "0").slice(0, 64);

function summary(modeId) {
  return {
    schemaVersion: 2,
    attemptId: `attempt-${modeId}`,
    mode: "real-turn",
    status: "PASS",
    fixture: "gui-human-canonical-20261010-2340",
    runtime: "DeepSeek Harness Desktop 0.2.1-rc.3",
    tgzSha256: hash("candidate"),
    appAsarSha256: hash("asar"),
    cwd: "owned fixture workspace 中文 space",
    provider: "deepseek-account",
    model: "deepseek-flash",
    preflightProvider: "deepseek-account",
    preflightModel: "deepseek-flash",
    sourceHashes: { probe: hash("probe") },
    candidateBinding: {
      candidateIndependent: true,
      freshRequired: true,
      isCanonical: false,
      expectedSha256: hash("candidate"),
      tgzRelativePath: "new-candidate/dsh-plugin-bash-wsl-0.2.0.tgz",
    },
    nativeModes: [{ modeId }],
    sessionIdSha256: hash(modeId),
    agentPresetRequested: modeId,
    agentPresetBinding: { requested: modeId, exact: true },
    sessionTitle: `owned-${modeId}`,
    followReady: true,
    toolCalls: 2,
    toolResults: 2,
    toolErrors: 0,
    toolNames: ["bash", "bash"],
    toolCallIdsSha256: [hash(`${modeId}-call-1`), hash(`${modeId}-call-2`)],
    toolResultCallIdsSha256: [hash(`${modeId}-call-1`), hash(`${modeId}-call-2`)],
    markers: { DSH_GUI_TURN1: true, DSH_GUI_TURN2: true },
    turnStarts: 1,
    turnEnded: true,
    turnEndKind: "completed",
    cleanup: {
      childClosed: true,
      socketClosed: true,
      queueEnded: true,
      reaped: true,
    },
    promptAttempted: true,
    promptAccepted: true,
    modelRouteObserved: true,
    deepSeekModelObserved: true,
    preflightModelRouteObserved: true,
    protocolFailure: false,
    failureReason: null,
    accountCredentialsRead: false,
    accountCredentialsPersisted: false,
    ephemeralLocalTransportAuthHandled: true,
    userConversationRead: false,
    cancelAttempted: false,
    observationReady: true,
    observationChildClosed: true,
    nativeCallLedger: [],
  };
}

test("two one-preset PASS summaries merge with WSL as the D16 base", () => {
  const result = combineOwnedNativeDriverSummaries(
    summary("bash-wsl"),
    summary("bash-git-bash"),
    { adapter: "aggregate.json", ready: "aggregate-ready.json" },
  );
  assert.deepEqual(result.modes.map((mode) => mode.modeId), ["bash-wsl", "bash-git-bash"]);
  assert.equal(result.adapter.sessionIdSha256, summary("bash-wsl").sessionIdSha256);
  assert.equal(result.adapter.resultArtifact, "aggregate.json");
  assert.equal(result.ready.status, "OBSERVATION_READY");
  assert.deepEqual(result.ready.nativeModes, result.modes);
});

test("aggregate rejects duplicate or missing native modes", () => {
  assert.throws(
    () => combineOwnedNativeDriverSummaries(summary("bash-wsl"), summary("bash-wsl")),
    /duplicate mode/,
  );
  assert.throws(
    () => combineOwnedNativeDriverSummaries(summary("bash-git-bash"), summary("bash-git-bash")),
    /duplicate mode/,
  );
});
