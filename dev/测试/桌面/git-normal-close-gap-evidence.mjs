import {
  lstatSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import {
  basename,
  isAbsolute,
  relative,
  resolve,
} from "node:path";
import { createHash } from "node:crypto";

export const KNOWN_GIT_NORMAL_CLOSE_GAP_ID =
  "GIT_NORMAL_CLOSE_BACKEND_PREPOSITIVE_AFTER_CLOSE";
export const KNOWN_GIT_NORMAL_CLOSE_ERROR =
  "owned Windows CIM prepositive lineage unavailable";
export const KNOWN_GIT_MODE_ID = "bash-git-bash";
export const KNOWN_SESSION_DRIVER_SHA256 =
  "3afd079a242a0de07e53f9c98672a2119e4d402f8689006dac13fd93c90674ce";

const SOURCE_HASH_NAMES = [
  "probe",
  "sessionDriver",
  "launcher",
  "wrapper",
  "candidateBinding",
];
const GAP_BINDING_NAMES = [
  "rawDriver",
  "observationReady",
  "cimPrepositive",
  "cimPostempty",
  "driverLaunch",
];

const ISO_INSTANT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?(?:Z|[+-]\d{2}:\d{2})$/;

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSha256(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/i.test(value);
}

function fail(detail) {
  throw new Error(`git-normal-close-gap: ${detail}`);
}

function requireCondition(condition, detail) {
  if (!condition) fail(detail);
}

function sameStringArray(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function normalizeJson(value) {
  if (Array.isArray(value)) return value.map(normalizeJson);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, normalizeJson(value[key])]),
  );
}

function sameJson(left, right) {
  return JSON.stringify(normalizeJson(left)) === JSON.stringify(normalizeJson(right));
}

function strictGapBindings(bindings) {
  requireCondition(isRecord(bindings)
    && sameStringArray(Object.keys(bindings).sort(), GAP_BINDING_NAMES.slice().sort()),
  "known-gap supplement must provide exactly five proof bindings");
}

function sameKeys(left, right) {
  return isRecord(left) && isRecord(right)
    && sameStringArray(Object.keys(left).sort(), Object.keys(right).sort());
}

function isContainedChild(parent, child) {
  const childRelative = relative(parent, child);
  return childRelative.length > 0
    && childRelative !== ".."
    && !childRelative.startsWith(`..${child.includes("\\") ? "\\" : "/"}`)
    && !isAbsolute(childRelative);
}

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function isoTimestamp(value, label) {
  requireCondition(typeof value === "string" && value.length > 0,
    `${label} timestamp is missing`);
  requireCondition(ISO_INSTANT_PATTERN.test(value),
    `${label} timestamp is not a complete ISO timestamp with timezone`);
  const time = Date.parse(value);
  requireCondition(Number.isFinite(time), `${label} timestamp is not parseable`);
  return time;
}

function positivePid(value, label) {
  requireCondition(Number.isSafeInteger(value) && value > 0,
    `${label} PID is invalid`);
}

function strictCreation(value, label) {
  isoTimestamp(value, `${label} Creation`);
  return value;
}

function identityKey(identity) {
  return `${identity.pid}:${identity.creation}`;
}

function readBoundJson(root, runOutputRoot, binding, label) {
  requireCondition(isRecord(binding), `${label} binding is missing`);
  requireCondition(typeof binding.path === "string" && binding.path.length > 0,
    `${label} binding path is missing`);
  requireCondition(isSha256(binding.sha256), `${label} binding SHA-256 is invalid`);
  const outputReal = realpathSync(resolve(runOutputRoot));
  const path = realpathSync(resolve(root, binding.path));
  requireCondition(isContainedChild(outputReal, path),
    `${label} path escapes the run output root`);
  requireCondition(lstatSync(path).isFile(), `${label} path is not a regular file`);
  const bytes = readFileSync(path);
  const actualSha = sha256Bytes(bytes);
  requireCondition(actualSha === binding.sha256,
    `${label} content SHA-256 does not match its binding`);
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    fail(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  requireCondition(isRecord(value), `${label} JSON root is not an object`);
  return {
    value,
    sha256: actualSha,
    realpath: path,
    relativePath: relative(resolve(root), path).replaceAll("\\", "/"),
    basename: basename(path),
  };
}

function strictSourceHashes(actual, expected) {
  const expectedKeys = SOURCE_HASH_NAMES.slice().sort();
  requireCondition(sameStringArray(Object.keys(actual ?? {}).sort(), expectedKeys)
    && sameStringArray(Object.keys(expected ?? {}).sort(), expectedKeys)
    && sameKeys(actual, expected),
  "driver source hash key set is not exactly the reviewed five keys");
  requireCondition(expected?.sessionDriver === KNOWN_SESSION_DRIVER_SHA256,
    "driver session source SHA is not the reviewed driver");
  for (const name of SOURCE_HASH_NAMES) {
    requireCondition(isSha256(expected?.[name]) && actual?.[name] === expected[name],
      `driver source hash mismatch: ${name}`);
  }
}

function strictCandidateBinding(summary, expected) {
  requireCondition(summary.tgzSha256 === expected.candidateSha256,
    "raw driver candidate SHA does not match");
  const binding = summary.candidateBinding;
  requireCondition(isRecord(binding)
    && binding.candidateIndependent === true
    && binding.freshRequired === true
    && binding.isCanonical === false
    && binding.expectedSha256 === expected.candidateSha256
    && typeof binding.tgzRelativePath === "string"
    && binding.tgzRelativePath.length > 0
    && !isAbsolute(binding.tgzRelativePath)
    && !binding.tgzRelativePath.split(/[\\/]/).includes(".."),
  "raw driver candidate binding is incomplete or path-unsafe");
}

function strictPermission(mode) {
  const permission = mode?.permission;
  requireCondition(isRecord(permission)
    && permission.mode === "danger-full-access"
    && permission.authorizationGranted === true
    && permission.authorizationInput === "DSH_GUI_ALLOW_GIT_FULL_ACCESS=1"
    && permission.authorizationSource === "explicit-user-test-authorization"
    && permission.authorizationScope === "owned-gui-session"
    && permission.command?.name === "permission"
    && permission.command?.definitionId === "@deepseek-ai/dsh-permission-presets"
    && permission.command?.inputHint === "<preset>"
    && permission.prePromptProjection?.currentValue === "danger-full-access"
    && permission.fullAccess?.projection?.currentValue === "danger-full-access",
  "Git permission/authorization projection is not exact");
}

function strictCallFacts(mode) {
  const calls = mode?.calls;
  requireCondition(Array.isArray(calls) && calls.length === 2,
    "raw driver must contain exactly two Git calls");
  const callIds = [];
  for (const [index, call] of calls.entries()) {
    requireCondition(call?.sequence === index + 1
      && call.toolName === "bash"
      && call.accepted === true
      && call.completed === true
      && call.parsedExitCode === 0
      && call.isError === false
      && call.timedOut === false
      && call.aborted === false
      && call.outputMarker === [
        "DSH_GUI_TURN1:DSH_GUI_TURN1",
        "DSH_GUI_TURN2:DSH_GUI_TURN1",
      ][index]
      && isSha256(call.callIdSha256)
      && call.callIdSha256 === call.resultCallIdSha256,
    `raw Git call ${index + 1} is not an exact successful non-aborted call`);
    callIds.push(call.callIdSha256);
  }
  requireCondition(new Set(callIds).size === 2, "raw Git call IDs are not unique");
  return {
    calls,
    callIds,
    resultCallIds: calls.map((call) => call.resultCallIdSha256),
    callOrder: calls.map((call) => ({
      sequence: call.sequence,
      callIdSha256: call.callIdSha256,
      resultCallIdSha256: call.resultCallIdSha256,
    })),
  };
}

function callLedgerEquivalent(left, right) {
  requireCondition(Array.isArray(left) && Array.isArray(right)
    && left.length === right.length,
  "native call ledger length does not match mode calls");
  for (const [index, call] of right.entries()) {
    const ledger = left[index];
    requireCondition(isRecord(ledger)
      && ledger.sequence === call.sequence
      && ledger.toolName === call.toolName
      && ledger.callIdSha256 === call.callIdSha256
      && ledger.resultCallIdSha256 === call.resultCallIdSha256
      && ledger.accepted === call.accepted
      && ledger.completed === call.completed
      && ledger.parsedExitCode === call.parsedExitCode
      && ledger.isError === call.isError
      && ledger.timedOut === call.timedOut
      && ledger.aborted === call.aborted
      && ledger.outputMarker === call.outputMarker,
    `native call ledger entry ${index + 1} does not match mode calls`);
  }
}

function strictTurnLedger(ledger, raw, callFacts) {
  requireCondition(isRecord(ledger)
    && ledger.turnStarts === raw.turnStarts
    && ledger.turnEnded === raw.turnEnded
    && ledger.turnEndKind === raw.turnEndKind
    && ledger.toolCalls === raw.toolCalls
    && ledger.toolResults === raw.toolResults
    && ledger.toolErrors === raw.toolErrors
    && sameJson(ledger.markers, raw.markers),
  "native turn ledger does not match raw turn facts");
  requireCondition(sameStringArray(callFacts.callIds, raw.toolCallIdsSha256)
    && sameStringArray(callFacts.resultCallIds, raw.toolResultCallIdsSha256),
  "top-level call/result SHA arrays do not match mode calls");
}

function strictRawLineageAfter(cleanup) {
  const lineage = cleanup?.lineageAfter;
  requireCondition(isRecord(lineage)
    && lineage.available === true
    && lineage.rootPresent === false
    && Array.isArray(lineage.identities)
    && lineage.identities.length === 0
    && lineage.remainingIdentityCount === 0
    && lineage.markerProcessCount === 0,
  "raw driver postempty lineage is not strict");
}

function strictKnownRawFailure(raw, mode, expected) {
  requireCondition(raw.schemaVersion === 2
    && raw.status === "FAIL"
    && raw.mode === "real-turn"
    && raw.modeId === expected.modeId
    && raw.fixture === expected.fixture
    && raw.runtime === expected.runtime,
  "raw driver is not the expected Git real-turn FAIL artifact");
  requireCondition(typeof raw.attemptId === "string" && raw.attemptId.length > 0,
    "raw driver attemptId is missing");
  requireCondition(raw.protocolFailure === false && raw.failureReason === null,
    "raw driver reports a protocol/failure reason outside the known ordering gap");
  requireCondition(raw.modelRouteObserved === true
    && raw.deepSeekModelObserved === true
    && raw.preflightModelRouteObserved === true
    && raw.promptAccepted === true
    && raw.observationReady === true
    && raw.observationChildClosed === true
    && typeof raw.observationReadyAt === "string"
    && Number.isSafeInteger(raw.observationElapsedMs)
    && raw.observationElapsedMs >= 0
    && raw.observationElapsedMs < expected.observationWindowMs,
  "raw Git route/observation timing facts are incomplete");
  isoTimestamp(raw.observationReadyAt, "raw observationReadyAt");
  requireCondition(raw.toolCalls === 2 && raw.toolResults === 2 && raw.toolErrors === 0
    && sameStringArray(raw.toolNames, ["bash", "bash"])
    && raw.turnStarts === 1
    && raw.turnEnded === true
    && raw.turnEndKind === "completed"
    && raw.markers?.DSH_GUI_TURN1 === true
    && raw.markers?.DSH_GUI_TURN2 === true,
  "raw Git turn/call marker facts are incomplete");
  requireCondition(raw.promptAttempted === true
    && raw.cancelAttempted === false
    && raw.cancelSucceeded === false,
  "raw Git prompt/cancel facts are not the normal-close path");
  requireCondition(typeof raw.sessionTitle === "string" && raw.sessionTitle.length > 0,
    "raw Git session title is missing");
  requireCondition(raw.provider === expected.provider && raw.model === expected.model,
    "raw Git provider/model route does not match expected host route");
  requireCondition(isSha256(raw.sessionIdSha256),
    "raw Git official session SHA is not a full SHA-256");
  requireCondition(raw.agentPresetRequested === expected.modeId
    && raw.agentPreset === expected.modeId
    && raw.agentPresetBinding?.requested === expected.modeId
    && raw.agentPresetBinding?.sessionCreate === expected.modeId
    && raw.agentPresetBinding?.sessionHeader === expected.modeId
    && raw.agentPresetBinding?.exact === true
    && raw.agentPresetBinding?.sessionHeaderIdSha256 === raw.sessionIdSha256,
  "raw Git preset/session header binding is incomplete");
  strictCandidateBinding(raw, expected);
  strictSourceHashes(raw.sourceHashes, expected.sourceHashes);
  requireCondition(raw.appAsarSha256 === expected.appAsarSha256,
    "raw Git Desktop app.asar SHA does not match");
  strictPermission(mode);
  requireCondition(sameJson(mode.permission, raw.permission)
    && sameJson(mode.cleanup, raw.cleanup)
    && sameJson(mode.normalExit, {
      closeObserved: true,
      reaped: true,
      aliveAfter: false,
    }),
  "raw Git mode cleanup/permission/normal-exit facts contradict top-level facts");
  requireCondition(mode.sessionIdSha256 === raw.sessionIdSha256
    && sameJson(mode.agentPresetBinding, raw.agentPresetBinding),
  "raw Git mode session/preset binding is not exact");
  const callFacts = strictCallFacts(mode);
  requireCondition(sameJson(mode.callOrder, callFacts.callOrder),
    "raw Git mode callOrder does not directly match its call sequence");
  strictTurnLedger(mode.turnLedger, raw, callFacts);
  callLedgerEquivalent(raw.nativeCallLedger, mode.calls);
  requireCondition(raw.nativeCallLedger?.length === mode.calls.length,
    "raw native call ledger is missing");

  const cleanup = raw.cleanup;
  requireCondition(isRecord(cleanup)
    && cleanup.childClosed === true
    && cleanup.socketClosed === true
    && cleanup.queueEnded === true
    && cleanup.reaped === true
    && cleanup.terminationAttempted === false
    && cleanup.killAuthorizedByLineage === false
    && cleanup.officialSessionCancelAttempted === false
    && cleanup.officialSessionCancelSucceeded === false,
  "raw Git cleanup indicates timeout/cancel/forced termination");
  strictRawLineageAfter(cleanup);
  const backend = mode.backendCleanup;
  const cleanupBackend = cleanup.backendCleanup;
  for (const [label, value] of [["native mode", backend], ["cleanup", cleanupBackend]]) {
    requireCondition(isRecord(value)
      && value.kind === "native-process-tree"
      && value.observed === false
      && Array.isArray(value.observationErrors)
      && value.observationErrors.length === 1
      && value.observationErrors[0] === KNOWN_GIT_NORMAL_CLOSE_ERROR,
    `${label} backend cleanup is not the unique known ordering-gap failure`);
    for (const [stage, lineage] of [["prepositive", value.prepositive], ["postempty", value.postempty]]) {
      requireCondition(isRecord(lineage)
        && lineage.available === true
        && lineage.verified === false
        && lineage.rootPresent === false
        && lineage.rootCreation === null
        && lineage.rootIdentity === null
        && Array.isArray(lineage.identities)
        && lineage.identities.length === 0
        && lineage.remainingIdentityCount === 0
        && lineage.markerProcessCount === 0,
      `${label} ${stage} is not the known post-close empty query shape`);
    }
  }
  requireCondition(isRecord(cleanup.lineageBeforeTerminate)
    && cleanup.lineageBeforeTerminate.rootPresent === false
    && cleanup.lineageBeforeTerminate.identities?.length === 0,
  "raw Git lineageBeforeTerminate is not the known post-close empty query");
}

function strictReady(raw, mode, ready, expected, rawArtifact) {
  requireCondition(ready.schemaVersion === 2
    && ready.status === "OBSERVATION_READY"
    && ready.mode === "real-turn"
    && ready.modeId === expected.modeId
    && ready.fixture === expected.fixture
    && ready.runtime === expected.runtime
    && ready.attemptId === raw.attemptId
    && ready.sessionIdSha256 === raw.sessionIdSha256
    && ready.tgzSha256 === expected.candidateSha256
    && ready.appAsarSha256 === expected.appAsarSha256
    && ready.provider === expected.provider
    && ready.model === expected.model
    && ready.followReady === true
    && ready.toolCalls === 2
    && ready.toolResults === 2
    && ready.toolErrors === 0
    && sameStringArray(ready.toolNames, ["bash", "bash"])
    && ready.markers?.DSH_GUI_TURN1 === true
    && ready.markers?.DSH_GUI_TURN2 === true
    && ready.turnStarts === 1
    && ready.turnEnded === true
    && ready.turnEndKind === "completed",
  "official READY artifact is not bound to the same Git turn");
  requireCondition(ready.resultArtifact === rawArtifact.basename,
    "official READY resultArtifact does not name the raw driver artifact");
  requireCondition(typeof ready.sessionTitle === "string"
    && ready.sessionTitle === raw.sessionTitle
    && sameJson(ready.sourceHashes, raw.sourceHashes)
    && sameJson(ready.candidateBinding, raw.candidateBinding)
    && sameJson(ready.agentPresetBinding, raw.agentPresetBinding)
    && sameJson(ready.permission, mode.permission)
    && sameJson(ready.nativeCallLedger, raw.nativeCallLedger),
  "official READY source/candidate/session/permission binding is not exact");
  requireCondition(Array.isArray(ready.nativeModes)
    && ready.nativeModes.length === 1
    && ready.nativeModes[0]?.modeId === expected.modeId,
  "official READY native mode envelope is not exactly Git Bash");
  const readyMode = ready.nativeModes[0];
  requireCondition(readyMode.sessionIdSha256 === raw.sessionIdSha256
    && sameJson(readyMode.agentPresetBinding, raw.agentPresetBinding)
    && sameJson(readyMode.calls, mode.calls)
    && sameJson(readyMode.callOrder, mode.callOrder)
    && sameJson(readyMode.turnLedger, mode.turnLedger)
    && sameJson(readyMode.permission, mode.permission),
  "official READY calls/order/ledger/session binding does not match raw mode");
  requireCondition(ready.agentPresetBinding?.sessionHeaderIdSha256 === raw.sessionIdSha256,
    "official READY uses a short or different session identity");
  return readyMode;
}

function strictDriverLaunch(launch, raw, rawArtifact, readyArtifact, pre) {
  requireCondition(launch.schemaVersion === 1
    && launch.status === "STARTED"
    && launch.attemptId === raw.attemptId
    && launch.driverPid === pre.driver.pid
    && launch.resultArtifact === rawArtifact.basename
    && launch.observationArtifact === readyArtifact.basename,
  "owned GUI driver launch binding is not exact");
}

function strictPrepositive(pre, raw, expected) {
  requireCondition(pre.schemaVersion === 1
    && typeof pre.source === "string"
    && pre.source.includes("Get-CimInstance Win32_Process")
    && pre.attemptId === raw.attemptId
    && pre.wslLedgerApplicable === false,
  "CIM prepositive source/attempt is not the native Git observation");
  const capturedAt = isoTimestamp(pre.capturedAt, "CIM prepositive capturedAt");
  const driver = pre.driver;
  const guiRoot = pre.guiRoot;
  positivePid(driver?.pid, "CIM driver");
  positivePid(guiRoot?.pid, "CIM GUI root");
  strictCreation(driver?.creation, "CIM driver");
  strictCreation(guiRoot?.creation, "CIM GUI root");
  requireCondition(driver.present === true
    && guiRoot.parentPid === driver.pid
    && guiRoot.mainWindowTitleMatches === true
    && guiRoot.verifiedOwnedByDriver === true,
  "CIM prepositive driver/GUI ownership is incomplete");
  const initialRoot = raw.cleanup?.lineageInitial?.rootIdentity;
  requireCondition(raw.cleanup?.lineageInitial?.rootPresent === true
    && isRecord(initialRoot)
    && initialRoot.pid === guiRoot.pid,
  "CIM GUI root is not anchored to the raw driver lineage initial PID");
  const lineage = pre.lineage;
  requireCondition(Array.isArray(lineage) && lineage.length >= 6,
    "CIM prepositive native lineage is too short");
  const byPid = new Map();
  const byIdentity = new Set();
  for (const [index, entry] of lineage.entries()) {
    positivePid(entry?.pid, `CIM lineage[${index}]`);
    positivePid(entry?.parentPid, `CIM lineage[${index}] parent`);
    strictCreation(entry?.creation, `CIM lineage[${index}]`);
    requireCondition(typeof entry.name === "string" && entry.name.length > 0,
      `CIM lineage[${index}] process name is missing`);
    requireCondition(!byPid.has(entry.pid), "CIM prepositive contains duplicate PIDs");
    const key = `${entry.pid}:${entry.creation}`;
    requireCondition(!byIdentity.has(key), "CIM prepositive contains duplicate PID+Creation identities");
    byPid.set(entry.pid, entry);
    byIdentity.add(key);
    if (index > 0) requireCondition(byPid.has(entry.parentPid),
      `CIM lineage[${index}] parent is not in the owned prefix`);
  }
  requireCondition(lineage[0].pid === driver.pid
    && lineage[0].creation === driver.creation
    && lineage[1].pid === guiRoot.pid
    && lineage[1].creation === guiRoot.creation,
  "CIM prepositive lineage does not start driver -> GUI");
  const names = lineage.map((entry) => entry.name.toLowerCase());
  requireCondition(names.includes("conhost.exe")
    && names.filter((name) => name === "bash.exe").length >= 2
    && names.filter((name) => name === "deepseek harness.exe").length >= 3,
  "CIM prepositive lacks the Host/helper/ConHost/Bash chain");
  const ancestorsReach = (pid, ancestorPid) => {
    const seen = new Set();
    let current = pid;
    while (current !== ancestorPid) {
      if (seen.has(current)) return false;
      seen.add(current);
      const entry = byPid.get(current);
      if (entry === undefined) return false;
      current = entry.parentPid;
    }
    return true;
  };
  const conhosts = lineage.filter((entry) => entry.name.toLowerCase() === "conhost.exe");
  const bashes = lineage.filter((entry) => entry.name.toLowerCase() === "bash.exe");
  requireCondition(conhosts.length === 1 && bashes.length === 2,
    "CIM prepositive must contain one ConHost and exactly two Bash processes");
  const conhost = conhosts[0];
  const helper = byPid.get(conhost.parentPid);
  requireCondition(helper?.name.toLowerCase() === "deepseek harness.exe",
    "CIM ConHost is not owned by the explicit native helper");
  const topBashes = bashes.filter((entry) => entry.parentPid === helper.pid);
  requireCondition(topBashes.length === 1,
    "CIM top Bash is not a direct child of the native helper");
  const topBash = topBashes[0];
  const childBashes = bashes.filter((entry) => entry.parentPid === topBash.pid);
  requireCondition(childBashes.length === 1,
    "CIM second Bash is not a child of the top Bash");
  const host = byPid.get(helper.parentPid);
  requireCondition(host?.name.toLowerCase() === "deepseek harness.exe"
    && host.pid !== guiRoot.pid
    && ancestorsReach(host.pid, guiRoot.pid)
    && ancestorsReach(helper.pid, guiRoot.pid)
    && ancestorsReach(conhost.pid, guiRoot.pid)
    && ancestorsReach(topBash.pid, guiRoot.pid)
    && ancestorsReach(childBashes[0].pid, guiRoot.pid),
  "CIM prepositive native chain is missing Host -> helper -> ConHost/Bash ownership");
  const capturedAtMs = capturedAt;
  for (const entry of lineage) {
    const entryTime = isoTimestamp(entry.creation, `CIM lineage PID ${entry.pid}`);
    requireCondition(entryTime <= capturedAtMs,
      `CIM lineage PID ${entry.pid} was created after prepositive capture`);
    const parent = byPid.get(entry.parentPid);
    if (parent !== undefined) {
      requireCondition(isoTimestamp(parent.creation, `CIM lineage parent PID ${parent.pid}`)
        <= entryTime,
      `CIM lineage parent PID ${parent.pid} was created after child PID ${entry.pid}`);
    }
  }
  requireCondition(pre.fixtureMarkerQueryAvailable === true
    && Number.isSafeInteger(pre.fixtureMarkerProcessCount)
    && Array.isArray(pre.fixtureMarkerPids)
    && pre.fixtureMarkerProcessCount === pre.fixtureMarkerPids.length
    && pre.fixtureMarkerPids.length === new Set(pre.fixtureMarkerPids).size
    && pre.fixtureMarkerPids.every((pid) => byPid.has(pid))
    && pre.fixtureMarkerPids.includes(guiRoot.pid)
    && pre.fixtureMarkerPids.includes(helper.pid),
  "CIM prepositive fixture marker is not a positive owned set");
  const markerNames = pre.fixtureMarkerNames;
  requireCondition(Array.isArray(markerNames)
    && markerNames.length === pre.fixtureMarkerPids.length,
  "CIM prepositive marker PID/name evidence is incomplete");
  requireCondition(markerNames.every((name, index) =>
    name === byPid.get(pre.fixtureMarkerPids[index]).name),
  "CIM prepositive marker PID/name evidence does not match lineage");
  requireCondition(pre.fixtureMarkerPids.every((pid) =>
    isoTimestamp(byPid.get(pid).creation, `CIM marker PID ${pid}`) <= capturedAtMs),
  "CIM prepositive marker Creation evidence is after capture");
  return { capturedAt, lineage, driver, guiRoot, helper, host, byPid };
}

function strictPostempty(post, raw, preEvidence, expected) {
  requireCondition(post.schemaVersion === 1
    && post.status === "POSTEMPTY_VERIFIED_RESULT_FAIL_PRESERVED"
    && post.attemptId === raw.attemptId
    && post.result?.status === "FAIL"
    && post.result?.observationReady === true
    && post.result?.observationReadyAt === raw.observationReadyAt
    && post.result?.observationElapsedMs === raw.observationElapsedMs
    && post.result?.observationChildClosed === true
    && post.result?.cleanupChildClosed === true
    && post.result?.cleanupReaped === true
    && post.result?.cleanupSocketClosed === true
    && post.result?.terminationAttempted === false
    && post.result?.toolCalls === 2
    && post.result?.toolResults === 2
    && post.result?.toolErrors === 0
    && post.wslLedger?.applicable === false,
  "postempty receipt does not preserve the original normal-close FAIL");
  const readyBinding = post.readyBinding;
  requireCondition(isRecord(readyBinding)
    && readyBinding.modeId === expected.modeId
    && readyBinding.officialSessionIdSha256 === raw.sessionIdSha256
    && isSha256(readyBinding.officialSessionIdSha256)
    && readyBinding.tgzSha256 === expected.candidateSha256
    && readyBinding.permission === "danger-full-access"
    && readyBinding.authorizationInput === "DSH_GUI_ALLOW_GIT_FULL_ACCESS=1"
    && readyBinding.authorizationScope === "owned-gui-session",
  "postempty READY binding is missing the full official session/candidate/permission identity");
  requireCondition(Array.isArray(readyBinding.toolCalls)
    && readyBinding.toolCalls.length === 2
    && readyBinding.toolCalls.every((call, index) => {
      const expectedCall = raw.nativeModes[0].calls[index];
      return isRecord(call)
        && call.sequence === expectedCall.sequence
        && call.callIdSha256 === expectedCall.callIdSha256
        && call.resultCallIdSha256 === expectedCall.resultCallIdSha256
        && call.outputMarker === expectedCall.outputMarker
        && call.exitCode === expectedCall.parsedExitCode;
    }),
  "postempty READY binding call IDs/order do not match raw");
  const cim = post.independentCimPostempty;
  requireCondition(isRecord(cim)
    && cim.source.includes("Get-CimInstance Win32_Process")
    && cim.querySucceeded === true
    && cim.queryFailureNotCountedAsEmpty === true
    && cim.ownedIdentityMatches === 0
    && cim.fixtureMarkerQueryAvailable === true
    && cim.fixtureMarkerProcessCount === 0,
  "postempty CIM query is unavailable, residual, or ambiguously empty");
  const queriedAt = isoTimestamp(cim.queriedAt, "CIM postempty queriedAt");
  const identityMap = new Map(preEvidence.lineage.map((entry) => [entry.pid, entry]));
  requireCondition(Array.isArray(cim.identities)
    && cim.identities.length === identityMap.size,
  "postempty CIM identity set does not cover the exact prepositive set");
  const seen = new Set();
  for (const identity of cim.identities) {
    positivePid(identity?.pid, "postempty identity");
    requireCondition(!seen.has(identity.pid) && identityMap.has(identity.pid),
      "postempty identity set has a missing, duplicate, or foreign PID");
    seen.add(identity.pid);
    const pre = identityMap.get(identity.pid);
    requireCondition(identity.expectedCreation === pre.creation
      && identity.creationMatches === false
      && strictCreation(identity.expectedCreation,
        `postempty PID ${identity.pid} expected`),
    "postempty identity does not compare the exact prepositive Creation");
    if (identity.present === true) {
      requireCondition(typeof identity.observedCreation === "string"
        && identity.observedCreation.length > 0
        && identity.observedCreation !== identity.expectedCreation,
      "PID reuse was not explicitly distinguished by a different Creation");
      const observedAt = isoTimestamp(identity.observedCreation,
        `postempty PID ${identity.pid} observed`);
      const expectedAt = isoTimestamp(identity.expectedCreation,
        `postempty PID ${identity.pid} expected`);
      requireCondition(observedAt > expectedAt && observedAt <= queriedAt,
        "PID reuse Creation is not later than the old identity and no later than query");
    } else {
      requireCondition(identity.present === false,
        "postempty identity is neither absent nor an explicitly different-Creation PID reuse");
    }
  }
  requireCondition(seen.size === identityMap.size, "postempty identity set is incomplete");
  return { queriedAt, identities: cim.identities };
}

export function buildGitNormalCloseGapEvidence(bindings, options = {}) {
  requireCondition(options.modeId === undefined || options.modeId === KNOWN_GIT_MODE_ID,
    "known-gap supplement accepts only the reviewed Git mode");
  strictGapBindings(bindings);
  const expected = {
    modeId: KNOWN_GIT_MODE_ID,
    fixture: options.fixture ?? "gui-human-canonical-20261010-2340",
    runtime: options.runtime ?? "DeepSeek Harness Desktop 0.2.1-rc.3",
    provider: options.provider ?? "deepseek-account",
    model: options.model ?? "deepseek-flash",
    observationWindowMs: options.observationWindowMs ?? 600_000,
    candidateSha256: options.candidateSha256,
    appAsarSha256: options.appAsarSha256,
    sourceHashes: options.sourceHashes,
  };
  requireCondition(isSha256(expected.candidateSha256), "expected candidate SHA is missing");
  requireCondition(isSha256(expected.appAsarSha256), "expected Desktop app.asar SHA is missing");
  strictSourceHashes(expected.sourceHashes, expected.sourceHashes);
  const root = resolve(options.root ?? ".");
  const runOutputRoot = resolve(options.runOutputRoot ?? root);
  const rawArtifact = readBoundJson(root, runOutputRoot, bindings?.rawDriver, "raw driver");
  const readyArtifact = readBoundJson(root, runOutputRoot, bindings?.observationReady, "official READY");
  const preArtifact = readBoundJson(root, runOutputRoot, bindings?.cimPrepositive, "CIM prepositive");
  const postArtifact = readBoundJson(root, runOutputRoot, bindings?.cimPostempty, "CIM postempty");
  const launchArtifact = readBoundJson(root, runOutputRoot, bindings?.driverLaunch, "owned GUI driver launch");
  const raw = rawArtifact.value;
  requireCondition(Array.isArray(raw.nativeModes)
    && raw.nativeModes.length === 1
    && raw.nativeModes[0]?.modeId === expected.modeId,
  "raw driver Git native mode envelope is missing or non-exclusive");
  const mode = raw.nativeModes[0];
  strictKnownRawFailure(raw, mode, expected);
  strictReady(raw, mode, readyArtifact.value, expected, rawArtifact);
  const preEvidence = strictPrepositive(preArtifact.value, raw, expected);
  strictDriverLaunch(launchArtifact.value, raw, rawArtifact, readyArtifact, preEvidence);
  const postEvidence = strictPostempty(postArtifact.value, raw, preEvidence, expected);
  const readyTime = isoTimestamp(raw.observationReadyAt, "raw observationReadyAt");
  const normalCloseTime = readyTime + raw.observationElapsedMs;
  requireCondition(readyTime < preEvidence.capturedAt
    && preEvidence.capturedAt < normalCloseTime
    && postEvidence.queriedAt >= normalCloseTime,
  "CIM prepositive/postempty timing does not straddle the normal close boundary");
  const artifacts = Object.fromEntries([
    ["rawDriver", rawArtifact],
    ["observationReady", readyArtifact],
    ["cimPrepositive", preArtifact],
    ["cimPostempty", postArtifact],
    ["driverLaunch", launchArtifact],
  ].map(([name, artifact]) => [name, {
    path: artifact.relativePath,
    realpath: artifact.realpath,
    sha256: artifact.sha256,
  }]));
  const backendCleanup = {
    kind: "native-process-tree",
    source: "independent Windows CIM Win32_Process CreationDate lineage",
    observed: true,
    prepositive: {
      available: true,
      verified: true,
      rootPresent: true,
      rootCreation: preEvidence.guiRoot.creation,
      rootIdentity: {
        pid: preEvidence.guiRoot.pid,
        creation: preEvidence.guiRoot.creation,
      },
      identities: preEvidence.lineage.map((entry) => ({
        pid: entry.pid,
        creation: entry.creation,
      })),
      markerProcessCount: preArtifact.value.fixtureMarkerProcessCount,
    },
    postempty: {
      available: true,
      verified: true,
      rootPresent: false,
      rootCreation: null,
      rootIdentity: null,
      identities: [],
      remainingIdentityCount: 0,
      markerProcessCount: 0,
    },
    creationIdentities: preEvidence.lineage.map((entry) => ({
      pid: entry.pid,
      creation: entry.creation,
    })),
    observationErrors: [],
  };
  const derivedNativeMode = {
    ...mode,
    rawDriverStatus: raw.status,
    qualificationStatus: "QUALIFIED_KNOWN_GAP",
    gapId: KNOWN_GIT_NORMAL_CLOSE_GAP_ID,
    backendCleanup,
  };
  return {
    schemaVersion: 1,
    status: "QUALIFIED_KNOWN_GAP",
    kind: "git-normal-close-gap-derived-summary",
    gapId: KNOWN_GIT_NORMAL_CLOSE_GAP_ID,
    mode: "real-turn",
    modeId: expected.modeId,
    attemptId: raw.attemptId,
    fixture: expected.fixture,
    runtime: expected.runtime,
    rawDriverStatus: raw.status,
    rawFailure: KNOWN_GIT_NORMAL_CLOSE_ERROR,
    qualification: {
      status: "QUALIFIED_KNOWN_GAP",
      gapId: KNOWN_GIT_NORMAL_CLOSE_GAP_ID,
      rawDriverStatus: "FAIL",
      rawDriverFailurePreserved: true,
      reason: "driver queried lineageBeforeTerminate only after normal close",
      normalCloseOrderingGapOnly: true,
      noTimeout: true,
      noAbort: true,
      noForcedKill: true,
      prepositiveCapturedAfterReady: true,
      prepositiveCapturedBeforeNormalClose: true,
      postemptyCapturedAfterNormalClose: true,
      normalCloseAt: new Date(normalCloseTime).toISOString(),
      prepositiveMarkerProcessCount: preArtifact.value.fixtureMarkerProcessCount,
      postemptyMarkerProcessCount: 0,
      inputArtifacts: artifacts,
    },
    candidateSha256: expected.candidateSha256,
    appAsarSha256: expected.appAsarSha256,
    sessionIdSha256: raw.sessionIdSha256,
    sourceHashes: { ...raw.sourceHashes },
    provider: raw.provider,
    model: raw.model,
    derivedNativeMode,
    backendCleanup,
    normalExit: {
      closeObserved: true,
      reaped: true,
      aliveAfter: false,
    },
    cleanup: {
      childClosed: true,
      socketClosed: true,
      queueEnded: true,
      reaped: true,
      terminationAttempted: false,
      killAuthorizedByLineage: false,
      lineageAfter: backendCleanup.postempty,
    },
    toolFacts: {
      toolCalls: 2,
      toolResults: 2,
      toolErrors: 0,
      outputMarkers: [
        "DSH_GUI_TURN1:DSH_GUI_TURN1",
        "DSH_GUI_TURN2:DSH_GUI_TURN1",
      ],
    },
  };
}

export function extractGitNormalCloseGapBridge(value) {
  const direct = value?.gitNormalCloseGap
    ?? value?.gitNormalCloseGapEvidence
    ?? value?.nativeModeQualification?.gitNormalCloseGap
    ?? value?.adapter?.gitNormalCloseGap
    ?? value?.adapter?.nativeModeQualification?.gitNormalCloseGap;
  if (isRecord(direct)) return direct;
  const modeBinding = Array.isArray(value?.modeDriverArtifacts)
    ? value.modeDriverArtifacts.find((entry) => entry?.modeId === KNOWN_GIT_MODE_ID)
    : undefined;
  return isRecord(modeBinding?.knownGapBridge) ? modeBinding.knownGapBridge : undefined;
}

export function buildGitNormalCloseGapFromBridge(bridge, options = {}) {
  requireCondition(isRecord(bridge), "known-gap supplement bridge is missing");
  const bindings = bridge.bindings ?? {
    rawDriver: bridge.rawDriver,
    observationReady: bridge.observationReady,
    cimPrepositive: bridge.cimPrepositive,
    cimPostempty: bridge.cimPostempty,
    driverLaunch: bridge.driverLaunch,
  };
  return buildGitNormalCloseGapEvidence(bindings, options);
}

