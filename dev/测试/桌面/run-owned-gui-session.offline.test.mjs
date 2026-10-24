import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";

import {
  AsyncQueue,
  CANONICAL_TGZ_SHA256,
  OBSERVATION_WINDOW_MS,
  TURN_TIMEOUT_MS,
  buildFollowRequest,
  buildSessionTitle,
  exitCodeForStatus,
  EXPECTED_COMMANDS,
  EXPECTED_OUTPUT_LINES,
  formatRpcError,
  markerLine,
  parseRenderedExitCode,
  nativeModeEnvelope,
  observeOwnedChild,
  cleanupScopePass,
  gitFullAccessAuthorized,
  requireGitFullAccessAuthorization,
  permissionAckEvidence,
  permissionCommandEvidence,
  permissionEnvelopeEvidence,
  permissionProjectionEvidence,
  parseServerFrame,
  projectionMatchesTarget,
  safeAttemptId,
  selectDriverMode,
  selectDeepSeekCatalogModel,
  selectSessionPreset,
  requireFreshNativePreset,
  combineNativeModeEnvelopes,
  snapshotShapeDiagnostic,
  shouldIgnoreFollowCleanupError,
  summarizeEvent,
  validCommand,
} from "./run-owned-gui-session.mjs";

function extractPureModeFunction(source, name) {
  const match = source.match(new RegExp(
    `function ${name}\\(args = \\[\\]\\) \\{[\\s\\S]*?\\n\\}`,
  ));
  assert.ok(match, `${name} must be present as a pure function`);
  return new Function(`return (${match[0]});`)();
}

function makeSummary() {
  return {
    eventTypes: {},
    markers: { DSH_GUI_TURN1: false, DSH_GUI_TURN2: false },
    systemPromptUsageObserved: false,
    provider: null,
    model: null,
    modelRouteObserved: false,
    deepSeekModelObserved: false,
    preflightModelRouteObserved: true,
    preflightProvider: "deepseek-account",
    preflightModel: "catalog-model-id",
    turnStarts: 0,
    turnEnded: false,
    turnEndKind: null,
    toolCalls: 0,
    toolResults: 0,
    toolErrors: 0,
    toolNames: [],
    toolCallIdsSha256: [],
    toolResultCallIdsSha256: [],
    protocolFailure: false,
    failureReason: null,
  };
}

function makeState() {
  const state = {
    summary: makeSummary(),
    pending: new Map(),
    seenCallIds: new Set(),
    turnId: undefined,
    turnEnded: false,
    lastSeq: undefined,
    failure: undefined,
    abort: () => {},
  };
  return state;
}

function event(seq, type, data) {
  return { type, seq, time: seq, data };
}

function toolCall(seq, index, callId, overrides = {}) {
  return event(seq, "tool/call", {
    turn: 1,
    step: index,
    callId,
    name: "bash",
    arguments: JSON.stringify({ command: EXPECTED_COMMANDS[index] }),
    ...overrides,
  });
}

function toolResult(seq, index, callId) {
  return event(seq, "tool/result", {
    turn: 1,
    step: index,
    message: {
      role: "tool",
      toolCallId: callId,
      source: { kind: "tool", callId },
      content: [{
        type: "text",
        text: `${EXPECTED_OUTPUT_LINES[index]}\n[Command finished with exit code 0]`,
      }],
    },
  });
}

function snapshot(sessionId = "owned-session") {
  return {
    type: "snapshot",
    header: {
      version: 1,
      id: sessionId,
      createdAt: 1_760_000_000_000,
      isSeeded: false,
      cwd: "C:/owned/workspace",
      agentPreset: "standard",
    },
    cursor: 0,
    records: [{
      type: "event",
      event: {
        type: "turn/start",
        seq: 0,
        time: 1_760_000_000_000,
        data: { turn: 1 },
      },
    }],
    hasMore: false,
    projections: { asOfSeq: 0, values: {} },
  };
}

test("snapshot validation follows the rc.3 wire shape and owns the created session", () => {
  const value = snapshot();
  const shape = snapshotShapeDiagnostic(value, "owned-session");
  assert.equal(shape.valid, true);
  assert.equal(shape.headerIdMatchesExpected, true);
  assert.equal(shape.cursorType, "number");
  assert.equal(shape.recordsIsArray, true);
  assert.equal(shape.recordsLength, 1);
  assert.equal(shape.hasMoreType, "boolean");
  assert.equal(shape.projectionsIsRecord, true);
  assert.deepEqual(shape.headerFieldTypes, {
    agentPreset: "string",
    createdAt: "number",
    cwd: "string",
    id: "string",
    isSeeded: "boolean",
    version: "number",
  });
  assert.doesNotMatch(JSON.stringify(shape), /owned-session|workspace/);

  const wrongOwner = snapshotShapeDiagnostic(value, "other-session");
  assert.equal(wrongOwner.valid, false);
  assert.equal(wrongOwner.headerIdMatchesExpected, false);
});

test("snapshot validation rejects the earlier false shape and missing required fields", () => {
  const value = snapshot();
  const createdAtText = structuredClone(value);
  createdAtText.header.createdAt = new Date(1_760_000_000_000).toISOString();
  assert.equal(snapshotShapeDiagnostic(createdAtText, "owned-session").valid, false);

  const cursorText = structuredClone(value);
  cursorText.cursor = "0";
  assert.equal(snapshotShapeDiagnostic(cursorText, "owned-session").valid, false);

  const missingProjection = structuredClone(value);
  delete missingProjection.projections;
  assert.equal(snapshotShapeDiagnostic(missingProjection, "owned-session").valid, false);

  const invalidRecord = structuredClone(value);
  invalidRecord.records[0].event.ignorable = false;
  assert.equal(snapshotShapeDiagnostic(invalidRecord, "owned-session").valid, false);
});

test("only an actual tool result line can satisfy a marker", () => {
  assert.equal(markerLine(`${EXPECTED_OUTPUT_LINES[1]}\n`, EXPECTED_OUTPUT_LINES[1]), true);
  assert.equal(markerLine("DSH_GUI_TURN2:DSH_GUI_TURN2\n", EXPECTED_OUTPUT_LINES[1]), false);

  const state = makeState();
  summarizeEvent(event(1, "user/message", {
    message: { content: [{ type: "text", text: EXPECTED_OUTPUT_LINES[0] }] },
  }), state);
  assert.equal(state.failure, undefined);
  assert.equal(state.summary.markers.DSH_GUI_TURN1, false);
  assert.equal(state.summary.toolResults, 0);
});

test("the official rendered tool result supplies the exit code", () => {
  assert.equal(parseRenderedExitCode(
    `${EXPECTED_OUTPUT_LINES[0]}\n[Command finished with exit code 0]`,
  ), 0);
  assert.equal(parseRenderedExitCode(
    `${EXPECTED_OUTPUT_LINES[0]}\n[Command finished with exit code 17]`,
  ), 17);
  assert.equal(parseRenderedExitCode(EXPECTED_OUTPUT_LINES[0]), undefined);
  assert.equal(parseRenderedExitCode(
    `${EXPECTED_OUTPUT_LINES[0]}\n[Command finished with exit code 0]\n[Command finished with exit code 0]`,
  ), undefined);
});

test("the fixed two commands and second stateful output are accepted exactly", () => {
  assert.equal(validCommand(EXPECTED_COMMANDS[0], 0), true);
  assert.equal(validCommand(EXPECTED_COMMANDS[1], 1), true);
  assert.equal(validCommand(`${EXPECTED_COMMANDS[0]}; printf injected`, 0), false);
  assert.equal(validCommand(EXPECTED_COMMANDS[1].replace("DSH_GUI_STATE", "OTHER_STATE"), 1), false);

  const objectArguments = makeState();
  summarizeEvent(event(1, "turn/start", { turn: 1 }), objectArguments);
  const objectCall = toolCall(2, 0, "object-call");
  objectCall.data.arguments = { command: EXPECTED_COMMANDS[0] };
  summarizeEvent(objectCall, objectArguments);
  assert.match(objectArguments.failure?.message ?? "", /turn\/step\/callId\/name\/arguments/);

  const state = makeState();
  summarizeEvent(event(1, "turn/start", { turn: 1 }), state);
  summarizeEvent(event(2, "request/header", { header: { config: {
    provider: "deepseek-account", model: "catalog-model-id",
  } } }), state);
  summarizeEvent(toolCall(3, 0, "call-1"), state);
  summarizeEvent(toolResult(4, 0, "call-1"), state);
  summarizeEvent(toolCall(5, 1, "call-2"), state);
  summarizeEvent(toolResult(6, 1, "call-2"), state);
  summarizeEvent(event(7, "turn/end", { turn: 1, reason: { kind: "completed" } }), state);

  assert.equal(state.failure, undefined);
  assert.equal(state.summary.markers.DSH_GUI_TURN1, true);
  assert.equal(state.summary.markers.DSH_GUI_TURN2, true);
  assert.equal(state.summary.toolCalls, 2);
  assert.equal(state.summary.toolResults, 2);
  assert.equal(state.summary.turnEnded, true);
  assert.equal(state.summary.modelRouteObserved, true);
  assert.notEqual(state.summary.toolCallIdsSha256[0], state.summary.toolCallIdsSha256[1]);
});

test("preflight chooses the catalog model id without inventing an endpoint or model id", () => {
  const route = selectDeepSeekCatalogModel({
    routableProviders: ["deepseek-account"],
    default: { provider: "deepseek-account", model: "catalog-model-id" },
    groups: [{
      id: "deepseek-account",
      name: "DeepSeek",
      models: [
        { id: "other-catalog-model", name: "V4.1 Flash" },
        { id: "catalog-model-id", name: "V4.1 Flash", reasoning: { defaultEffort: "medium" } },
      ],
    }],
  });
  assert.deepEqual(route, {
    provider: "deepseek-account",
    model: "catalog-model-id",
    reasoningEffort: "medium",
  });
  assert.equal(selectDeepSeekCatalogModel({
    routableProviders: ["other-provider"], groups: [],
  }), undefined);
});

test("driver mode validation rejects unknown, duplicate, and combined flags", () => {
  assert.equal(selectDriverMode([]), "real-turn");
  assert.equal(selectDriverMode(["--preflight-only"]), "preflight-only");
  assert.equal(selectDriverMode(["--owned-linux-ledger-baseline"]), "owned-linux-ledger-baseline");
  assert.equal(selectDriverMode(["--owned-lineage-self-check"]), "owned-lineage-self-check");
  assert.throws(() => selectDriverMode(["--linux-ledger-baseline"]), /unknown driver mode flag/);
  assert.throws(() => selectDriverMode(["--preflight-only", "--preflight-only"]), /at most one mode flag/);
  assert.throws(() => selectDriverMode(["--preflight-only", "--owned-lineage-self-check"]), /at most one mode flag/);

  const wrapperSource = readFileSync(new URL("./run-owned-gui-session-wrapper.mjs", import.meta.url), "utf8");
  const selectWrapperMode = extractPureModeFunction(wrapperSource, "selectWrapperMode");
  assert.equal(selectWrapperMode([]), "real-turn");
  assert.equal(selectWrapperMode(["--capability-only"]), "capability-only");
  assert.equal(selectWrapperMode(["--preflight-only"]), "preflight-only");
  assert.throws(() => selectWrapperMode(["--unknown"]), /unknown wrapper mode flag/);
  assert.throws(() => selectWrapperMode(["--capability-only", "--preflight-only"]), /at most one mode flag/);
  const validationOffset = wrapperSource.indexOf("const wrapperMode = selectWrapperMode(process.argv.slice(2));");
  const capabilityOffset = wrapperSource.indexOf("const capabilityScript");
  assert.ok(validationOffset >= 0 && validationOffset < capabilityOffset);
});

test("preset selection is a small allowlist and fresh candidates cannot fall back to Standard", () => {
  assert.equal(selectSessionPreset("standard"), "standard");
  assert.equal(selectSessionPreset("bash-wsl"), "bash-wsl");
  assert.equal(selectSessionPreset("bash-git-bash"), "bash-git-bash");
  assert.throws(() => selectSessionPreset("bash-wsl;pwsh"), /must be one of/);
  assert.throws(() => requireFreshNativePreset({ freshRequired: true }, "standard"), /fresh GUI candidate/);
  assert.equal(requireFreshNativePreset({ freshRequired: true }, "bash-wsl"), "bash-wsl");
  assert.equal(requireFreshNativePreset({ freshRequired: true }, "bash-git-bash"), "bash-git-bash");
  assert.equal(requireFreshNativePreset({ freshRequired: false }, "standard"), "standard");
});

test("Git full access requires the exact explicit authorization input", () => {
  assert.equal(gitFullAccessAuthorized("1"), true);
  assert.equal(gitFullAccessAuthorized(undefined), false);
  assert.equal(gitFullAccessAuthorized("true"), false);
  assert.equal(gitFullAccessAuthorized("0"), false);
  assert.equal(requireGitFullAccessAuthorization("bash-wsl", undefined), "bash-wsl");
  assert.throws(
    () => requireGitFullAccessAuthorization("bash-git-bash", undefined),
    /DSH_GUI_ALLOW_GIT_FULL_ACCESS=1/,
  );
  assert.throws(
    () => requireGitFullAccessAuthorization("bash-git-bash", "true"),
    /DSH_GUI_ALLOW_GIT_FULL_ACCESS=1/,
  );
  assert.equal(
    requireGitFullAccessAuthorization("bash-git-bash", "1"),
    "bash-git-bash",
  );
});

test("permission command catalog is unique and bound to the official definition", () => {
  const catalog = [{
    definitionId: "@deepseek-ai/dsh-permission-presets",
    name: "permission",
    description: "safe test descriptor",
    input: { hint: "<preset>" },
  }];
  assert.deepEqual(permissionCommandEvidence(catalog), {
    name: "permission",
    definitionId: "@deepseek-ai/dsh-permission-presets",
    inputHint: "<preset>",
  });
  assert.throws(
    () => permissionCommandEvidence([]),
    /exactly one permission command/,
  );
  assert.throws(
    () => permissionCommandEvidence([...catalog, catalog[0]]),
    /exactly one permission command/,
  );
  assert.throws(
    () => permissionCommandEvidence([{
      ...catalog[0],
      definitionId: "other-definition",
    }]),
    /definitionId did not match/,
  );
  assert.throws(
    () => permissionCommandEvidence([{
      ...catalog[0],
      input: { hint: "wrong" },
    }]),
    /input hint did not match/,
  );
});

test("permission acknowledgement and projection require exact per-session state", () => {
  const ack = permissionAckEvidence({
    commandId: "cmd-owned-1",
    result: {
      kind: "success",
      text: "preset workspace-write",
      sourceEventSeq: 12,
    },
  }, "workspace-write");
  assert.equal(ack.kind, "success");
  assert.equal(ack.text, "preset workspace-write");
  assert.equal(ack.sourceEventSeq, 12);
  assert.equal(ack.commandIdSha256.length, 64);
  assert.throws(
    () => permissionAckEvidence({
      commandId: "cmd-owned-2",
      result: { kind: "success", text: "preset danger-full-access" },
    }, "workspace-write"),
    /did not confirm/,
  );
  assert.throws(
    () => permissionAckEvidence({
      commandId: "cmd-owned-3",
      result: { kind: "error", text: "rejected" },
    }, "workspace-write"),
    /did not confirm/,
  );
  const projection = permissionProjectionEvidence({
    asOfSeq: 13,
    values: { permissions: { currentValue: "workspace-write" } },
  }, "workspace-write");
  assert.deepEqual(projection, {
    asOfSeq: 13,
    currentValue: "workspace-write",
  });
  assert.throws(
    () => permissionProjectionEvidence({
      asOfSeq: 14,
      values: { permissions: { currentValue: "danger-full-access" } },
    }, "workspace-write"),
    /requested permission preset/,
  );
  assert.throws(
    () => permissionProjectionEvidence({
      asOfSeq: 14,
      values: {},
    }, "workspace-write"),
    /requested permission preset/,
  );
});

test("native permission evidence is copied as the same whitelisted session binding", () => {
  const evidence = permissionEnvelopeEvidence({
    mode: "workspace-write",
    authorizationGranted: null,
    authorizationInput: null,
    authorizationSource: null,
    authorizationScope: null,
    command: {
      name: "permission",
      definitionId: "@deepseek-ai/dsh-permission-presets",
      inputHint: "<preset>",
    },
    workspaceWrite: {
      ack: {
        commandIdSha256: "a".repeat(64),
        kind: "success",
        text: "preset workspace-write",
        sourceEventSeq: 2,
      },
      projection: { asOfSeq: 3, currentValue: "workspace-write" },
    },
    fullAccess: null,
    prePromptProjection: { asOfSeq: 4, currentValue: "workspace-write" },
    secret: "must-not-appear",
  });
  assert.equal(evidence.mode, "workspace-write");
  assert.equal(evidence.workspaceWrite.ack.text, "preset workspace-write");
  assert.equal(evidence.prePromptProjection.currentValue, "workspace-write");
  assert.equal(Object.hasOwn(evidence, "secret"), false);
});

test("reused protected fixture cleanup is N/A for transient-root removal", () => {
  const hash = CANONICAL_TGZ_SHA256;
  const valid = {
    strategy: "reused-protected-owned-fixture",
    temporaryRootCreated: false,
    temporaryRootRemoved: false,
    temporaryRootNotApplicable: true,
    profileContained: true,
    protectedFixtureReused: true,
    protectedFixturePreserved: true,
    canonicalTgzPreserved: true,
    canonicalTgzSha256: hash,
    canonicalTgzBeforeSha256: hash,
    canonicalTgzAfterSha256: hash,
    profileContainment: {
      available: true,
      allInside: true,
      entries: [
        { exists: true, contained: true },
        { exists: true, contained: true },
        { exists: true, contained: true },
      ],
    },
  };
  assert.equal(cleanupScopePass(valid), true);
  assert.equal(cleanupScopePass({ ...valid, temporaryRootRemoved: true }), false);
  assert.equal(cleanupScopePass({ ...valid, temporaryRootNotApplicable: false }), false);
  assert.equal(cleanupScopePass({ ...valid, canonicalTgzAfterSha256: "b".repeat(64) }), false);
  assert.equal(cleanupScopePass({ ...valid, profileContained: false }), false);
  assert.equal(cleanupScopePass({
    ...valid,
    profileContainment: { ...valid.profileContainment, entries: valid.profileContainment.entries.slice(0, 2) },
  }), false);
  assert.equal(cleanupScopePass({
    ...valid,
    profileContainment: {
      ...valid.profileContainment,
      entries: [{ exists: true, contained: true }, { exists: true, contained: false }, { exists: true, contained: true }],
    },
  }), false);
  assert.equal(cleanupScopePass({ ...valid, canonicalTgzSha256: "a".repeat(64) }), false);
});

test("native mode envelope binds actual preset/header and never invents backend evidence", () => {
  const base = {
    modeId: "bash-wsl",
    sessionIdSha256: "a".repeat(64),
    agentPreset: "bash-wsl",
    agentPresetBinding: {
      requested: "bash-wsl",
      sessionCreate: "bash-wsl",
      sessionHeader: "bash-wsl",
      sessionHeaderIdSha256: "a".repeat(64),
      exact: true,
    },
    nativeCallLedger: [1, 2].map((sequence) => ({
      sequence,
      toolName: "bash",
      callIdSha256: `${sequence}`.repeat(64).slice(0, 64),
      resultCallIdSha256: `${sequence}`.repeat(64).slice(0, 64),
      accepted: true,
      completed: true,
      parsedExitCode: 0,
      isError: false,
      timedOut: false,
      aborted: false,
      outputMarker: EXPECTED_OUTPUT_LINES[sequence - 1],
    })),
    turnStarts: 1,
    turnEnded: true,
    turnEndKind: "completed",
    toolCalls: 2,
    toolResults: 2,
    toolErrors: 0,
    markers: { DSH_GUI_TURN1: true, DSH_GUI_TURN2: true },
    cleanup: {
      childClosed: true,
      reaped: true,
      lineageInitial: { rootPresent: true, identities: [{ pid: 1, creation: "x" }] },
      lineageAfter: { available: true, rootPresent: false, identities: [] },
      wslLedgerBefore: { available: true, identities: [{ pid: 1 }] },
      wslLedgerAfter: { available: true, identities: [] },
      backendCleanup: {
        kind: "wsl-public-session",
        source: "owned Linux ledger",
        observed: true,
        prepositive: { available: true, markerCount: 1 },
        postempty: { available: true, markerCount: 0 },
        creationIdentities: [],
        observationErrors: [],
      },
    },
    permission: {
      mode: "workspace-write",
      authorizationGranted: null,
      authorizationInput: null,
      authorizationSource: null,
      authorizationScope: null,
      command: {
        name: "permission",
        definitionId: "@deepseek-ai/dsh-permission-presets",
        inputHint: "<preset>",
      },
      workspaceWrite: {
        ack: {
          commandIdSha256: "b".repeat(64),
          kind: "success",
          text: "preset workspace-write",
          sourceEventSeq: 7,
        },
        projection: { asOfSeq: 8, currentValue: "workspace-write" },
      },
      fullAccess: null,
      prePromptProjection: { asOfSeq: 9, currentValue: "workspace-write" },
    },
    publicSessionObserved: true,
  };
  const envelope = nativeModeEnvelope(base);
  assert.equal(envelope.length, 1);
  assert.equal(envelope[0].agentPresetBinding.sessionCreate, "bash-wsl");
  assert.equal(envelope[0].agentPresetBinding.sessionHeader, "bash-wsl");
  assert.equal(envelope[0].agentPresetBinding.exact, true);
  assert.equal(envelope[0].agentPresetBinding.sessionHeaderIdSha256, "a".repeat(64));
  assert.equal(envelope[0].turnLedger.toolResults, 2);
  assert.equal(envelope[0].permission.mode, "workspace-write");
  assert.equal(envelope[0].permission.workspaceWrite.ack.text, "preset workspace-write");
  assert.equal(envelope[0].permission.prePromptProjection.currentValue, "workspace-write");
  assert.equal(Object.hasOwn(envelope[0], "backendType"), false);
  assert.equal(Object.hasOwn(envelope[0], "serialOrder"), false);
  assert.equal(Object.hasOwn(envelope[0], "rawFrames"), false);
  assert.equal(envelope[0].backendCleanup.kind, "wsl-public-session");
});

test("native driver results merge only one exact entry per new preset", () => {
  const one = { nativeModes: [{ modeId: "bash-wsl" }] };
  const two = { nativeModes: [{ modeId: "bash-git-bash" }] };
  assert.deepEqual(
    combineNativeModeEnvelopes([two, one]).map((entry) => entry.modeId),
    ["bash-wsl", "bash-git-bash"],
  );
  assert.throws(
    () => combineNativeModeEnvelopes([one, { nativeModes: [{ modeId: "bash-wsl" }] }]),
    /one bash-wsl and one bash-git-bash/,
  );
  assert.throws(
    () => combineNativeModeEnvelopes([one]),
    /exactly one result from each native preset/,
  );
});

test("projections never fall back to lastUsed when a non-null next route disagrees", () => {
  const target = { provider: "deepseek-account", model: "catalog-model-id" };
  assert.equal(projectionMatchesTarget({
    next: { provider: "other-provider", model: "other-model" },
    lastUsed: target,
  }, target), false);
  assert.equal(projectionMatchesTarget({ next: null, lastUsed: target }, target), true);
});

test("duplicate, out-of-order, and uncorrelated events fail closed", () => {
  const duplicate = makeState();
  summarizeEvent(event(1, "turn/start", { turn: 1 }), duplicate);
  summarizeEvent(event(1, "request/header", { header: { config: {
    provider: "deepseek-account", model: "catalog-model-id",
  } } }), duplicate);
  assert.match(duplicate.failure?.message ?? "", /repeated or out of order/);

  const outOfOrder = makeState();
  summarizeEvent(toolResult(2, 0, "missing-call"), outOfOrder);
  assert.match(outOfOrder.failure?.message ?? "", /not correlated/);

  const wrongOrder = makeState();
  summarizeEvent(event(1, "turn/start", { turn: 1 }), wrongOrder);
  summarizeEvent(toolCall(2, 0, "call-1"), wrongOrder);
  summarizeEvent(toolCall(3, 1, "call-2"), wrongOrder);
  assert.match(wrongOrder.failure?.message ?? "", /before the previous tool\/result/);
});

test("tool/call is turn-scoped, schema-shaped, and callId-unique", () => {
  const beforeTurn = makeState();
  summarizeEvent(toolCall(1, 0, "before-turn"), beforeTurn);
  assert.match(beforeTurn.failure?.message ?? "", /before turn\/start/);

  const wrongTurn = makeState();
  summarizeEvent(event(1, "turn/start", { turn: 1 }), wrongTurn);
  summarizeEvent(toolCall(2, 0, "wrong-turn", { turn: 2 }), wrongTurn);
  assert.match(wrongTurn.failure?.message ?? "", /turn\/step\/callId\/name\/arguments/);

  const missingStep = makeState();
  summarizeEvent(event(1, "turn/start", { turn: 1 }), missingStep);
  const malformed = toolCall(2, 0, "missing-step");
  delete malformed.data.step;
  summarizeEvent(malformed, missingStep);
  assert.match(missingStep.failure?.message ?? "", /turn\/step\/callId\/name\/arguments/);

  const reusedCallId = makeState();
  summarizeEvent(event(1, "turn/start", { turn: 1 }), reusedCallId);
  summarizeEvent(toolCall(2, 0, "same-call"), reusedCallId);
  summarizeEvent(toolResult(3, 0, "same-call"), reusedCallId);
  summarizeEvent(toolCall(4, 1, "same-call"), reusedCallId);
  assert.match(reusedCallId.failure?.message ?? "", /reuses a previous callId/);
  assert.equal(reusedCallId.summary.toolCalls, 1);
  assert.deepEqual([...reusedCallId.seenCallIds], ["same-call"]);
});

test("an observed non-DeepSeek route fails immediately", () => {
  const state = makeState();
  summarizeEvent(event(1, "request/header", { header: { config: {
    provider: "other-provider", model: "other-model",
  } } }), state);
  assert.match(state.failure?.message ?? "", /does not match the preflight-selected/);
  assert.equal(state.summary.deepSeekModelObserved, false);
});

test("an already-aborted queue signal never consumes queued values", async () => {
  const queued = new AsyncQueue();
  queued.push("must-remain-queued");
  const controller = new AbortController();
  controller.abort(new Error("already stopped"));
  await assert.rejects(queued.next(controller.signal), /already stopped/);
  assert.deepEqual(queued.values, ["must-remain-queued"]);

  const waiting = new AsyncQueue();
  const waitController = new AbortController();
  const pending = waiting.next(waitController.signal);
  waitController.abort(new Error("stop waiting"));
  await assert.rejects(pending, /stop waiting/);
  waiting.push("after-abort");
  assert.deepEqual(waiting.values, ["after-abort"]);
});

test("malformed official Remote frames are rejected", () => {
  assert.throws(() => parseServerFrame("not-json"), /not JSON/);
  assert.throws(() => parseServerFrame(JSON.stringify({
    type: "item", streamId: "s", value: {}, extra: true,
  })), /violates rc\.3 schema/);
  assert.throws(() => parseServerFrame(JSON.stringify({
    type: "item", streamId: "s",
  })), /violates rc\.3 schema/);
  assert.throws(() => parseServerFrame(JSON.stringify({
    type: "error", streamId: "s", error: {
      code: "E", message: "bad", details: {}, extra: "unexpected",
    },
  })), /violates rc\.3 schema/);
});

test("rc.3 follow request omits assistantStream or uses only literal true", () => {
  const omitted = buildFollowRequest("session-id");
  assert.deepEqual(omitted, {
    address: { kind: "session", sessionId: "session-id" },
    maxMessages: 50,
  });
  assert.deepEqual(buildFollowRequest("session-id", true), {
    address: { kind: "session", sessionId: "session-id" },
    assistantStream: true,
    maxMessages: 50,
  });
  assert.throws(() => buildFollowRequest("session-id", false), /literal true or omission/);
});

test("preflight cleanup abort is ignored only for the owned cleanup reason", () => {
  const state = makeState();
  const cleanupReason = new Error("owned Desktop driver cleanup");
  state.followReady = true;
  state.cleaningUp = true;
  state.cleanupReason = cleanupReason;
  assert.equal(shouldIgnoreFollowCleanupError(state, true, cleanupReason), true);
  assert.equal(shouldIgnoreFollowCleanupError(state, true, new Error(cleanupReason.message)), false);
  state.failure = new Error("protocol failure");
  assert.equal(shouldIgnoreFollowCleanupError(state, true, cleanupReason), false);
  assert.equal(exitCodeForStatus("PREFLIGHT_PASS"), 0);
  assert.equal(exitCodeForStatus("PASS"), 0);
  assert.equal(exitCodeForStatus("FAIL"), 1);
});

test("session title has a short attempt and session hash suffix", () => {
  const title = buildSessionTitle("attempt-20261011-long-value", "abcdef0123456789");
  assert.match(title, /^GUI Bash WSL smoke 20261011-attempt-20261011-abcdef01$/);
  assert.match(buildSessionTitle("attempt-20261011-long-value", "abcdef0123456789", "bash-git-bash"), /^GUI Bash Git Bash smoke 20261011-attempt-20261011-abcdef01$/);
});

test("Gateway validation errors expose only safe schema fields", () => {
  const message = formatRpcError("session/follow", {
    code: "input-invalid",
    details: {
      issues: [{ path: ["request", "assistantStream"], expected: "true", type: "literal" }],
      content: "do not leak prompt",
      token: "do not leak token",
    },
  });
  assert.match(message, /input-invalid/);
  assert.match(message, /path=request\.assistantStream/);
  assert.match(message, /expected=true/);
  assert.match(message, /type=literal/);
  assert.doesNotMatch(message, /do not leak/);
});

test("the Windows wrapper keeps driver stdout detached and durable", () => {
  const source = readFileSync(new URL("./run-owned-gui-session-wrapper.mjs", import.meta.url), "utf8");
  const driverSource = readFileSync(new URL("./run-owned-gui-session.mjs", import.meta.url), "utf8");
  assert.match(source, /detached:\s*true/);
  assert.match(source, /stdio:\s*\["ignore", "ignore", stderrFd\]/);
  assert.doesNotMatch(source, /openSync\("NUL", "w"\)/);
  assert.match(source, /child\.once\("spawn", \(\) => \{[\s\S]*child\.unref\(\)/);
  assert.match(source, /spawnSync\(appExe, \["--expose-internals", "--eval"/);
  assert.match(source, /ELECTRON_RUN_AS_NODE:\s*"1"/);
  assert.match(source, /isAbsolute\(localAppData\)/);
  assert.doesNotMatch(source, /resolve\(localAppData\)\.includes/);
  assert.match(source, /const wsModule = join\(appAsar, "dsh", "node_modules", "ws"/);
  assert.match(source, /--capability-only/);
  assert.match(source, /--preflight-only/);
  assert.match(source, /resultArtifact/);
  assert.match(source, /observationArtifact/);
  assert.doesNotMatch(source, /spawn\(process\.execPath/);
  assert.match(driverSource, /const OBSERVATION_WINDOW_MS = 600_000/);
  assert.match(driverSource, /const TURN_TIMEOUT_MS = 120_000/);
  assert.match(driverSource, /status: "OBSERVATION_READY"/);
  assert.match(driverSource, /writeObservationReady\(summary\)/);
  assert.match(driverSource, /read-only Linux ledger of owned bwrap/);
  assert.match(driverSource, /sessionId !== undefined && summary\.promptAttempted && !summary\.turnEnded/);
  assert.match(driverSource, /officialSessionCancelSucceeded/);
  assert.doesNotMatch(driverSource, /assistantStream:\s*false/);
  assert.match(driverSource, /maxMessages:\s*50/);
  assert.match(driverSource, /buildFollowRequest\(sessionId\)/);
  assert.doesNotMatch(driverSource, /args: \{ request: \{[^}]*signal/);
  assert.match(driverSource, /--preflight-only/);
  assert.match(driverSource, /await followReadyPromise/);
  assert.match(driverSource, /preflightOnlyPromptSkipped/);
  assert.match(driverSource, /shouldIgnoreFollowCleanupError/);
  assert.match(driverSource, /exitCodeForStatus/);
  assert.match(driverSource, /buildSessionTitle\(ATTEMPT_ID, summary\.sessionIdSha256(?:, SESSION_PRESET)?\)/);
  assert.match(driverSource, /lineageInitial/);
  assert.match(driverSource, /lineageBeforeTerminate/);
    assert.ok(
      driverSource.indexOf("summary.cleanup.lineageBeforeTerminate = await queryOwnedLineage")
        < driverSource.indexOf("const observation = await observeOwnedChild"),
      "native prepositive lineage must be captured before waiting for normal GUI close",
    );
  assert.match(driverSource, /backendCleanupEvidence/);
  assert.match(driverSource, /owned Windows CIM Win32_Process CreationDate lineage/);
  assert.match(driverSource, /SESSION_PRESET !== "bash-git-bash"/);
  assert.match(driverSource, /markerValue=ConvertFrom-Json/);
  assert.match(driverSource, /expectedValue=ConvertFrom-Json/);
  assert.match(driverSource, /nestedMarker/);
  assert.match(driverSource, /nestedExpected/);
  assert.match(driverSource, /--owned-lineage-self-check/);
  assert.match(driverSource, /identityQueueMatched/);
  assert.match(driverSource, /--owned-linux-ledger-baseline/);
  assert.match(driverSource, /gui-owned-linux-ledger-baseline-20261011\.json/);
  assert.match(driverSource, /session\/modelCatalog/);
  assert.match(driverSource, /session\/selectModel/);
  assert.match(driverSource, /session\/projections/);
  assert.match(driverSource, /commands\/list/);
  assert.match(driverSource, /commands\/execute/);
  assert.match(driverSource, /permissionCommandEvidence/);
  assert.match(driverSource, /permissionAckEvidence/);
  assert.match(driverSource, /permissionProjectionEvidence/);
  assert.match(driverSource, /DSH_GUI_ALLOW_GIT_FULL_ACCESS=1/);
  assert.match(driverSource, /cleanupScopePass/);
  assert.match(driverSource, /temporaryRootNotApplicable/);
  assert.match(driverSource, /protectedFixturePreserved/);
  assert.match(driverSource, /canonicalTgzPreserved/);
  assert.ok(
    driverSource.indexOf('rpc("session/create"')
      < driverSource.indexOf('rpc("commands/list"'),
  );
  assert.ok(
    driverSource.indexOf('rpc("commands/list"')
      < driverSource.indexOf('rpc("session/prompt"'),
  );
  assert.ok(
    driverSource.indexOf("requireGitFullAccessAuthorization(SESSION_PRESET)")
      < driverSource.indexOf("child = spawn(appExe"),
  );
  assert.match(driverSource, /preflightModelRouteObserved/);
  assert.match(driverSource, /comm.*bwrap/);
  assert.match(driverSource, /bash\|script\|stty/);
  assert.match(driverSource, /DSH_SHELL\*/);
  assert.match(driverSource, /DSH_SESSION_ID\*/);
  assert.match(driverSource, /DSH_PTY_SESSION_ID\*/);
});

test("observation wait has an independent long window and preserves early/deadline semantics", async () => {
  assert.equal(TURN_TIMEOUT_MS, 120_000);
  assert.equal(OBSERVATION_WINDOW_MS, 600_000);
  const driverSource = readFileSync(
    new URL("./run-owned-gui-session.mjs", import.meta.url),
    "utf8",
  );
  assert.match(driverSource, /real session follow timed out.*TURN_TIMEOUT_MS/);
  assert.match(driverSource, /observeOwnedChild\(child, OBSERVATION_WINDOW_MS\)/);

  const earlyChild = new EventEmitter();
  earlyChild.exitCode = null;
  earlyChild.signalCode = null;
  const earlyPromise = observeOwnedChild(earlyChild, 50);
  earlyChild.emit("close");
  const early = await earlyPromise;
  assert.equal(early.closed, true);
  assert.equal(earlyChild.listenerCount("close"), 0);
  assert.equal(earlyChild.listenerCount("error"), 0);

  const deadlineChild = new EventEmitter();
  deadlineChild.exitCode = null;
  deadlineChild.signalCode = null;
  const deadline = await observeOwnedChild(deadlineChild, 20);
  assert.equal(deadline.closed, false);
  assert.ok(deadline.elapsedMs >= 10);
  assert.equal(deadlineChild.listenerCount("close"), 0);
  assert.equal(deadlineChild.listenerCount("error"), 0);
});

test("attempt identifiers are filesystem-safe and each run gets a distinct suffix", () => {
  assert.equal(safeAttemptId("owned attempt/with spaces"), "owned-attempt-with-spaces");
  assert.match(safeAttemptId(""), /^attempt-/);
});
