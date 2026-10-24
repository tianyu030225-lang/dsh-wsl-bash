/**
 * Release-gate validators for the native WSL/Git Bash mode artifacts.
 *
 * This module is deliberately test-only.  It validates evidence produced by
 * the real Desktop backend probe and by an independent GUI roster observer;
 * it never starts Desktop, a model turn, or a process of its own.
 */

import {
  lstatSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import {
  isAbsolute,
  relative,
  resolve,
} from "node:path";
import {
  buildGitNormalCloseGapFromBridge,
  extractGitNormalCloseGapBridge,
  KNOWN_GIT_NORMAL_CLOSE_GAP_ID,
  KNOWN_SESSION_DRIVER_SHA256,
} from "./git-normal-close-gap-evidence.mjs";

export const NATIVE_MODE_IDS = ["bash-wsl", "bash-git-bash"];
export const NATIVE_MODE_PHASES = ["disabled-before", "enabled-retained", "disabled-after"];
const GUI_ROSTER_SOURCES = new Set(["@oai/sky", "mcp__windows_mcp"]);
export const CANONICAL_TGZ_SHA256 =
  "9cb01907dd7a9558255b6b8d5fe5ef03349927711fef0aadf9456656fe2b6f63";
const CONTROLLED_PROMPT_CONTRACT_WSL =
  "OSC133D-BEL+__DSH_PERSISTENT_BASH_PROMPT__ ";
const CONTROLLED_PROMPT_CONTRACT_GIT =
  "OSC133D-BEL+canonical-status;__DSH_PERSISTENT_BASH_PROMPT__+visible-__DSH_PERSISTENT_BASH_PROMPT__";

function promptContractForBackend(backendType) {
  return backendType === "git-bash"
    ? CONTROLLED_PROMPT_CONTRACT_GIT
    : CONTROLLED_PROMPT_CONTRACT_WSL;
}

const TOP_REQUIRED_CHECKS = [
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

const DISABLED_REQUIRED_CHECKS = [
  "disabled-roster",
  "disabled-tools-and-backends",
  "disabled-standard-agent-capability",
  "disabled-standard-preserved",
];

const ENABLED_REQUIRED_CHECKS = [
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

const ADVANCED_COMMON_REQUIRED_CHECKS = [
  "background-process-cleanup",
  "natural-exit-reset",
  "timeout-reset",
  "cancel-reset",
  "cross-agent-isolation",
];

const ADVANCED_GIT_REQUIRED_CHECKS = [
  "standing-full-access",
  "native-pid-pty",
  "helper-job-quiescence",
  "natural-exit-delayed-background",
  "natural-exit-noisy-background",
];

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSha256(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/i.test(value);
}

function stableJson(value) {
  if (Array.isArray(value)) return value.map(stableJson);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, stableJson(value[key])]),
  );
}

function sameStableJson(left, right) {
  return JSON.stringify(stableJson(left)) === JSON.stringify(stableJson(right));
}

function permissionTransitionIsStrict(value, preset) {
  return isRecord(value)
    && isRecord(value.ack)
    && isSha256(value.ack.commandIdSha256)
    && value.ack.kind === "success"
    && value.ack.text === `preset ${preset}`
    && (value.ack.sourceEventSeq === null
      || (Number.isSafeInteger(value.ack.sourceEventSeq)
        && value.ack.sourceEventSeq >= 0))
    && isRecord(value.projection)
    && Number.isSafeInteger(value.projection.asOfSeq)
    && value.projection.asOfSeq >= 0
    && value.projection.currentValue === preset;
}

export function nativeModePermissionIsStrict(permission, modeId) {
  const preset = modeId === "bash-wsl"
    ? "workspace-write"
    : modeId === "bash-git-bash"
      ? "danger-full-access"
      : undefined;
  if (preset === undefined || !isRecord(permission)
    || permission.mode !== preset
    || !isRecord(permission.command)
    || permission.command.name !== "permission"
    || permission.command.definitionId !== "@deepseek-ai/dsh-permission-presets"
    || permission.command.inputHint !== "<preset>"
    || !permissionTransitionIsStrict(permission.workspaceWrite, "workspace-write")
    || !isRecord(permission.prePromptProjection)
    || !Number.isSafeInteger(permission.prePromptProjection.asOfSeq)
    || permission.prePromptProjection.asOfSeq < 0
    || permission.prePromptProjection.currentValue !== preset) {
    return false;
  }
  if (modeId === "bash-wsl") {
    return permission.authorizationGranted === null
      && permission.authorizationInput === null
      && permission.authorizationSource === null
      && permission.authorizationScope === null
      && permission.fullAccess === null;
  }
  return permission.authorizationGranted === true
    && permission.authorizationInput === "DSH_GUI_ALLOW_GIT_FULL_ACCESS=1"
    && permission.authorizationSource === "explicit-user-test-authorization"
    && permission.authorizationScope === "owned-gui-session"
    && permissionTransitionIsStrict(permission.fullAccess, "danger-full-access");
}

export function reusedProtectedFixtureCleanupIsStrict(cleanup) {
  const entries = cleanup?.profileContainment?.entries;
  return isRecord(cleanup)
    && cleanup.strategy === "reused-protected-owned-fixture"
    && cleanup.temporaryRootCreated === false
    && cleanup.temporaryRootRemoved === false
    && cleanup.temporaryRootNotApplicable === true
    && cleanup.profileContained === true
    && cleanup.profileContainment?.available === true
    && cleanup.profileContainment?.allInside === true
    && Array.isArray(entries)
    && entries.length === 3
    && entries.every((entry) => isRecord(entry)
      && entry.exists === true && entry.contained === true)
    && cleanup.protectedFixtureReused === true
    && cleanup.protectedFixturePreserved === true
    && cleanup.canonicalTgzPreserved === true
    && cleanup.canonicalTgzSha256 === CANONICAL_TGZ_SHA256
    && cleanup.canonicalTgzBeforeSha256 === CANONICAL_TGZ_SHA256
    && cleanup.canonicalTgzAfterSha256 === CANONICAL_TGZ_SHA256;
}

function lineageBeforeIsStrict(lineage) {
  const rootIdentity = lineage?.rootIdentity;
  const identities = lineage?.identities;
  const identityIsStrict = (value) => isRecord(value)
    && Number.isSafeInteger(value.pid)
    && value.pid > 0
    && typeof value.creation === "string"
    && value.creation.length > 0;
  return isRecord(lineage)
    && lineage.available === true
    && lineage.verified === true
    && lineage.rootPresent === true
    && typeof lineage.rootCreation === "string"
    && lineage.rootCreation.length > 0
    && identityIsStrict(rootIdentity)
    && rootIdentity.creation === lineage.rootCreation
    && Array.isArray(identities)
    && identities.length > 0
    && identities.every(identityIsStrict)
    && identities.some((identity) => identity.pid === rootIdentity.pid
      && identity.creation === rootIdentity.creation)
    && Number.isInteger(lineage.markerProcessCount)
    && lineage.markerProcessCount > 0
    && (!Object.hasOwn(lineage, "errors")
      || (Array.isArray(lineage.errors) && lineage.errors.length === 0))
    && (!Object.hasOwn(lineage, "observationErrors")
      || (Array.isArray(lineage.observationErrors)
        && lineage.observationErrors.length === 0))
    && (!Object.hasOwn(lineage, "error")
      || lineage.error === null || lineage.error === "")
    && (!Object.hasOwn(lineage, "observationError")
      || lineage.observationError === null || lineage.observationError === "")
    && (!Object.hasOwn(lineage, "queryError")
      || lineage.queryError === null || lineage.queryError === "");
}

function lineageAfterIsStrict(lineage) {
  return isRecord(lineage)
    && lineage.available === true
    && lineage.rootPresent === false
    && Array.isArray(lineage.identities)
    && lineage.identities.length === 0
    && lineage.remainingIdentityCount === 0
    && lineage.markerProcessCount === 0
    && (!Object.hasOwn(lineage, "observationErrors")
      || (Array.isArray(lineage.observationErrors)
        && lineage.observationErrors.length === 0))
    && (!Object.hasOwn(lineage, "errors")
      || (Array.isArray(lineage.errors) && lineage.errors.length === 0))
    && (!Object.hasOwn(lineage, "error")
      || lineage.error === null || lineage.error === "")
    && (!Object.hasOwn(lineage, "observationError")
      || lineage.observationError === null || lineage.observationError === "")
    && (!Object.hasOwn(lineage, "queryError")
      || lineage.queryError === null || lineage.queryError === "")
    && (!Object.hasOwn(lineage, "rootIdentity") || lineage.rootIdentity === null)
    && (!Object.hasOwn(lineage, "rootCreation") || lineage.rootCreation === null);
}

function driverCleanupIsStrict(summary, modeId) {
  const cleanup = summary?.cleanup;
  if (!reusedProtectedFixtureCleanupIsStrict(cleanup)
    || summary?.observationChildClosed !== true
    || cleanup.childClosed !== true
    || cleanup.reaped !== true
    || cleanup.terminationAttempted !== false
    || cleanup.killAuthorizedByLineage !== false
    || !lineageBeforeIsStrict(cleanup.lineageInitial)
    || !lineageAfterIsStrict(cleanup.lineageAfter)) {
    return false;
  }
  if (modeId === "bash-wsl") {
    return cleanup.wslLedgerBefore?.available === true
      && cleanup.wslLedgerBefore.markerCount > 0
      && cleanup.wslLedgerAfter?.available === true
      && cleanup.wslLedgerAfter.markerCount === 0
      && Array.isArray(cleanup.wslLedgerAfter.identities)
      && cleanup.wslLedgerAfter.identities.length === 0;
  }
  const backend = cleanup.backendCleanup;
  return backend?.kind === "native-process-tree"
    && backend.observed === true
    && lineageBeforeIsStrict(backend.prepositive)
    && lineageAfterIsStrict(backend.postempty)
    && Array.isArray(backend.observationErrors)
    && backend.observationErrors.length === 0;
}

function driverSourceHashesMatch(actual, expected) {
  if (!isRecord(actual) || !isRecord(expected)) return false;
  const names = ["probe", "sessionDriver", "launcher", "wrapper", "candidateBinding"];
  return Object.keys(actual).length === names.length
    && Object.keys(expected).length === names.length
    && names.every((name) => isSha256(expected[name])
    && actual[name] === expected[name]);
}

function readBoundDriverArtifact(binding, options) {
  if (!isRecord(binding) || typeof binding.path !== "string"
    || !isSha256(binding.sha256) || typeof options?.root !== "string"
    || typeof options?.runOutputRoot !== "string") return undefined;
  try {
    const path = realpathSync(resolve(options.root, binding.path));
    const outputRoot = realpathSync(options.runOutputRoot);
    const relativePath = relative(outputRoot, path);
    if (relativePath.length === 0 || relativePath === ".."
      || relativePath.startsWith(`..${path.includes("\\") ? "\\" : "/"}`)
      || isAbsolute(relativePath) || !lstatSync(path).isFile()) return undefined;
    const bytes = readFileSync(path);
    const actualSha = options.fileSha256 === undefined
      ? undefined
      : options.fileSha256(path);
    if (actualSha !== binding.sha256) return undefined;
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    return undefined;
  }
}

export function qualifyGitNormalCloseGapForRoster(evidence, gitBinding, options) {
  const bridge = extractGitNormalCloseGapBridge(evidence);
  if (!isRecord(bridge) || !isRecord(options)) return undefined;
  try {
    const derived = buildGitNormalCloseGapFromBridge(bridge, {
      root: options.root,
      runOutputRoot: options.runOutputRoot,
      modeId: "bash-git-bash",
      fixture: "gui-human-canonical-20261010-2340",
      runtime: "DeepSeek Harness Desktop 0.2.1-rc.3",
      provider: "deepseek-account",
      model: "deepseek-flash",
      candidateSha256: options.candidateSha256,
      appAsarSha256: options.expectedAsarSha256,
      sourceHashes: options.driverSourceHashes,
    });
    const rawProof = derived.qualification.inputArtifacts.rawDriver;
    const normalize = (value) => String(value).replaceAll("\\", "/");
    if (derived.rawDriverStatus !== "FAIL"
      || derived.gapId !== KNOWN_GIT_NORMAL_CLOSE_GAP_ID
      || derived.sourceHashes.sessionDriver !== KNOWN_SESSION_DRIVER_SHA256
      || normalize(rawProof.path) !== normalize(gitBinding.path)
      || rawProof.sha256 !== gitBinding.sha256) return undefined;
    if (bridge.status !== undefined && bridge.status !== "QUALIFIED_KNOWN_GAP") return undefined;
    if (bridge.rawDriverStatus !== undefined && bridge.rawDriverStatus !== "FAIL") return undefined;
    if (bridge.gapId !== undefined && bridge.gapId !== derived.gapId) return undefined;
    if (bridge.driverSha256 !== undefined
      && bridge.driverSha256 !== derived.sourceHashes.sessionDriver) return undefined;
    if (bridge.derivedNativeMode !== undefined
      && !sameStableJson(bridge.derivedNativeMode, derived.derivedNativeMode)) {
      return undefined;
    }
    return derived;
  } catch {
    return undefined;
  }
}

function reuseDriverArtifactsAreStrict(evidence, options) {
  const bindings = evidence?.modeDriverArtifacts;
  const expectedSourceHashes = options?.driverSourceHashes;
  if (!Array.isArray(bindings) || bindings.length !== NATIVE_MODE_IDS.length
    || !isRecord(expectedSourceHashes)) return false;
  const seen = new Set();
  for (const binding of bindings) {
    const modeId = binding?.modeId;
    if (!NATIVE_MODE_IDS.includes(modeId) || seen.has(modeId)) return false;
    seen.add(modeId);
    const summary = readBoundDriverArtifact(binding, options);
    if (!isRecord(summary)
      || summary.schemaVersion !== 2
      || summary.mode !== "real-turn"
      || summary.modeId !== modeId
      || summary.tgzSha256 !== options.candidateSha256
      || summary.appAsarSha256 !== options.expectedAsarSha256
      || !driverSourceHashesMatch(summary.sourceHashes, expectedSourceHashes)
      || !isSha256(summary.sessionIdSha256)
      || summary.candidateBinding?.candidateIndependent !== true
      || summary.candidateBinding?.freshRequired !== true
      || summary.candidateBinding?.isCanonical !== false
      || summary.candidateBinding?.expectedSha256 !== options.candidateSha256
      || summary.agentPresetRequested !== modeId
      || summary.agentPreset !== modeId
      || summary.agentPresetBinding?.exact !== true
      || summary.agentPresetBinding?.requested !== modeId
      || summary.agentPresetBinding?.sessionCreate !== modeId
      || summary.agentPresetBinding?.sessionHeader !== modeId
      || !isSha256(summary.agentPresetBinding?.sessionHeaderIdSha256)
      || summary.agentPresetBinding.sessionHeaderIdSha256
        !== summary.sessionIdSha256) return false;
    if (!nativeModePermissionIsStrict(summary.permission, modeId)) return false;
    if (modeId === "bash-git-bash" && summary.status === "FAIL") {
      const derived = qualifyGitNormalCloseGapForRoster(evidence, binding, options);
      if (derived === undefined) {
        return false;
      }
      const qualifiedSummary = {
        ...summary,
        cleanup: {
          ...summary.cleanup,
          backendCleanup: derived.backendCleanup,
        },
      };
      if (!driverCleanupIsStrict(qualifiedSummary, modeId)) return false;
      continue;
    }
    if (summary.status !== "PASS"
      || !driverCleanupIsStrict(summary, modeId)) return false;
  }
  return seen.size === NATIVE_MODE_IDS.length;
}

function actualDesktopPwshPreservationIsStrict(evidence, options) {
  const preservation = evidence?.pwshPreservation;
  const artifactBinding = preservation?.artifact;
  if (!isRecord(preservation)
    || preservation.source !== "actual-desktop-runtime"
    || preservation.candidateTgzSha256 !== options?.candidateSha256
    || preservation.appAsarSha256 !== options?.expectedAsarSha256
    || preservation.executableSha256 !== options?.expectedExecutableSha256
    || preservation.probeSourceSha256 !== options?.nativeProbeSourceSha256
    || !isRecord(artifactBinding)
    || typeof artifactBinding.path !== "string"
    || !artifactBinding.path.toLowerCase().endsWith(".json")) {
    return false;
  }
  const artifact = readBoundDriverArtifact(artifactBinding, options);
  if (!isRecord(artifact)) return false;
  const audit = validateNativeModesDesktopEvidence(artifact, {
    candidateSha256: options.candidateSha256,
    expectedAsarSha256: options.expectedAsarSha256,
    expectedExecutableSha256: options.expectedExecutableSha256,
    probeSourceSha256: options.nativeProbeSourceSha256,
  });
  if (!audit.ok) return false;
  const enabled = Array.isArray(artifact.phases)
    ? artifact.phases.find((phase) => phase?.label === "enabled-retained")
    : undefined;
  const checks = checkIndex(enabled?.evidence?.checks);
  const pwshRoot = checks.get("pwsh-preserved-root")?.[0];
  if (pwshRoot?.status !== "PASS"
    || pwshRoot.evidence?.standardHasPwsh !== true) return false;
  for (const modeId of NATIVE_MODE_IDS) {
    const composition = checks.get(`${modeId}:standard-composition`)?.[0];
    const mount = checks.get(`${modeId}:agent-mount-and-schemas`)?.[0];
    const flatNames = composition?.evidence?.flatNames;
    const schemaNames = mount?.evidence?.schemaNames;
    const prompt = mount?.evidence?.prompt;
    if (composition?.status !== "PASS"
      || !Array.isArray(flatNames)
      || !flatNames.includes("@deepseek-ai/dsh-tool-pwsh")
      || mount?.status !== "PASS"
      || !Array.isArray(schemaNames)
      || !schemaNames.includes("pwsh")
      || !isRecord(prompt)
      || !Array.isArray(prompt.schemaNames)
      || !prompt.schemaNames.includes("pwsh")
      || prompt.promptSchemaHasPwsh !== true) {
      return false;
    }
  }
  return true;
}

function checkIndex(checks) {
  const index = new Map();
  for (const check of Array.isArray(checks) ? checks : []) {
    const id = typeof check?.id === "string" ? check.id : "";
    if (!id) continue;
    const matches = index.get(id) ?? [];
    matches.push(check);
    index.set(id, matches);
  }
  return index;
}

function requirePass(index, id, failures) {
  const matches = index.get(id) ?? [];
  if (matches.length !== 1 || matches[0]?.status !== "PASS") {
    failures.push(`${id} is missing, duplicated, or not PASS`);
    return undefined;
  }
  return matches[0];
}

function childLifecycleIsClean(phase) {
  const child = phase?.child ?? phase;
  return child?.exitCode === 0
    && child?.signal === null
    && child?.timedOut === false
    && child?.error == null
    && child?.closeObserved === true
    && child?.reaped === true;
}

function topChildCheckLifecycleIsClean(check) {
  const evidence = check?.evidence;
  return evidence?.childExitCode === 0
    && evidence?.signal === null
    && evidence?.timedOut === false
    && evidence?.error == null
    && evidence?.closeObserved === true
    && evidence?.reaped === true;
}

function lifecycleCheck(check, modeId, failures) {
  const evidence = check?.evidence;
  const first = evidence?.firstResult;
  const second = evidence?.secondResult;
  if (evidence?.observerInstalled !== true || !(Number(evidence?.positiveSpawnDelta) > 0)) {
    failures.push(`${modeId}:native-lifecycle lacks a positive native spawn observer`);
  }
  for (const [label, result] of [["first", first], ["second", second]]) {
    if (result?.parsedExitCode !== 0 || result?.isError !== false || result?.error !== null
      || result?.timedOut === true || result?.aborted === true) {
      failures.push(`${modeId}:native-lifecycle ${label} result is not an exitCode 0 success`);
    }
  }
  if (typeof evidence?.output !== "string"
    || !evidence.output.includes("new-mode-owner-a")
    || !evidence.output.includes("new-mode-owner-a-persisted")) {
    failures.push(`${modeId}:native-lifecycle did not prove persistent owner state`);
  }
  return evidence;
}

function managedCapabilitiesAreClean(capabilities) {
  return Array.isArray(capabilities)
    && capabilities.length > 0
    && capabilities.every((capability) =>
      capability?.hasDone === true
      && capability?.hasWaitForExit === true
      && capability?.hasTerminate === true
      && capability?.resolveError == null);
}

function isSubprocessOutcome(value) {
  return isRecord(value)
    && Object.prototype.hasOwnProperty.call(value, "exitCode")
    && (typeof value.exitCode === "number" || value.exitCode === null)
    && Object.prototype.hasOwnProperty.call(value, "signal")
    && (typeof value.signal === "string" || value.signal === null);
}

function managedSettlementsAreClean(settlements, expectedCount = undefined) {
  return Array.isArray(settlements)
    && settlements.length > 0
    && (expectedCount === undefined
      || (Number.isSafeInteger(Number(expectedCount))
        && Number(expectedCount) === settlements.length))
    && settlements.every((settlement) =>
      settlement?.status === "fulfilled"
      && isSubprocessOutcome(settlement?.value?.done)
      && settlement?.value?.waitForExit === true);
}

function ownerDisposeCheck(check, modeId, failures) {
  const evidence = check?.evidence;
  const nativeHandleCount = Number(evidence?.nativeHandleCount);
  const capabilities = evidence?.nativeHandleCapabilities;
  const settlements = evidence?.nativeHandleSettlements;
  if (evidence?.nativeHandlesSettled !== true
    || !Number.isSafeInteger(nativeHandleCount)
    || nativeHandleCount <= 0
    || evidence?.nativeHandleApiOk !== true
    || evidence?.processCleanupOk !== true
    || !Array.isArray(evidence?.processAfterOwnerDisposeRows)
    || evidence.processAfterOwnerDisposeRows.length !== 0
    || !Array.isArray(capabilities)
    || capabilities.length !== nativeHandleCount
    || !Array.isArray(settlements)
    || settlements.length !== nativeHandleCount
    || !managedCapabilitiesAreClean(capabilities)
    || !managedSettlementsAreClean(settlements, nativeHandleCount)
    || evidence?.afterActivity !== false
    || !Array.isArray(evidence?.snapshotsAfterDispose)
    || evidence.snapshotsAfterDispose.length !== 0
    || !Array.isArray(evidence?.processObservationErrors)
    || evidence.processObservationErrors.length !== 0
    || evidence?.cleanupObservationError != null) {
    failures.push(`${modeId}:owner-dispose did not prove settled native handles and zero owned terminals`);
  }
  return evidence;
}

const ABORT_CODE = /^(?:ABORT(?:ED|_ERR)|ERR_ABORTED|CANCELLED)$/i;

function hasTypedAbortDetail(cancel) {
  const error = cancel?.cancelError;
  const result = cancel?.cancelResult;
  const names = [
    error?.name,
    result?.errorName,
  ];
  const codes = [
    error?.code,
    result?.errorCode,
    result?.failureKind,
    result?.failureCode,
  ];
  return names.some((name) => name === "AbortError")
    || codes.some((code) => ABORT_CODE.test(String(code ?? "")));
}

function cancelSettlementsAreClean(cancel) {
  const settlements = cancel?.cancelHandleSettlements;
  return cancel?.cancelHandleQuiesced === true
    && Number(cancel?.cancelHandlesToSettleCount) > 0
    && Number(cancel.cancelHandlesToSettleCount) === settlements?.length
    && managedSettlementsAreClean(settlements, cancel.cancelHandlesToSettleCount);
}

function existingManagedHandlesAreObserved(cancel) {
  const capabilities = cancel?.cancelExistingManagedHandles;
  return Array.isArray(capabilities)
    && capabilities.length > 0
    && capabilities.every((capability) =>
      capability?.hasDone === true
      && capability?.hasWaitForExit === true
      && capability?.hasTerminate === true
      && capability?.resolveError == null);
}

function terminalSnapshotsAreObserved(snapshots) {
  return Array.isArray(snapshots)
    && snapshots.length > 0
    && snapshots.every((snapshot) => isRecord(snapshot)
      && snapshot.sessionId !== null
      && snapshot.sessionId !== undefined);
}

function existingTerminalSnapshotsAreObserved(cancel) {
  return terminalSnapshotsAreObserved(cancel?.cancelExistingTerminalSnapshots);
}

function cancelProcessIsClean(cancel, modeId) {
  if (modeId === "bash-git-bash") {
    const process = cancel?.cancelProcess;
    const nativeWindowsPids = cancel?.nativeWindowsPids;
    return process?.required === true
      && process?.availableBefore === true
      && process?.availableAfterDelay === true
      && process?.hostAliveBefore === true
      && process?.hostAliveAfterDelay === true
      && Number(process?.ownedIdentityCount) > 0
      && Array.isArray(nativeWindowsPids)
      && nativeWindowsPids.length > 0
      && nativeWindowsPids.every((pid) => Number.isSafeInteger(Number(pid)) && Number(pid) > 0)
      && Array.isArray(process?.remaining)
      && process.remaining.length === 0
      && Array.isArray(process?.observationErrors)
      && process.observationErrors.length === 0;
  }
  const publicSession = cancel?.publicSessionAtBarrier;
  return publicSession?.listAvailable === true
    && publicSession?.readAvailable === true
    && Array.isArray(publicSession?.snapshots)
    && publicSession.snapshots.length > 0
    && Array.isArray(publicSession?.observationErrors)
    && publicSession.observationErrors.length === 0;
}

function strictCancellationEvidence(cancel, modeId) {
  return cancel?.cancelOk === true
    && cancel?.cancelTimedOut === false
    && cancel?.cancelStarted === true
    && cancel?.abortSignalAborted === true
    && cancel?.abortSignalReasonName === "AbortError"
    && cancel?.abortContract === true
    && cancel?.typedAbort === true
    && cancel?.emptyOutputAbortContract === false
    && hasTypedAbortDetail(cancel)
    && cancel?.cancelLeakCreated === false
    && cancel?.staleEnvironmentClean === true
    && cancel?.cancelExistingHandleObserved === true
    && cancel?.cancelExistingIdentityObserved === true
    && existingManagedHandlesAreObserved(cancel)
    && existingTerminalSnapshotsAreObserved(cancel)
    && boundedResetToolIsClean(cancel?.resetTool)
    && cancelSettlementsAreClean(cancel)
    && cancelProcessIsClean(cancel, modeId);
}

function officialTimeoutTextIsPresent(timeout) {
  const summary = timeout?.timeout;
  const output = String(summary?.output ?? "");
  return timeout?.timeoutContract?.officialTimeoutText === true
    && timeout?.timeoutContract?.timeoutMs === 10_000
    && output.startsWith("Your command timed out after 10 seconds or experienced an OOM error. Below is partial output:")
    && output.includes("[Command timed out or OOM]")
    && output.includes("The persistent bash shell was reset; the next bash call starts from the workspace with a fresh current directory and environment.");
}

function timeoutProcessIsClean(timeout, modeId) {
  const process = timeout?.timeoutProcess;
  if (modeId !== "bash-git-bash") {
    return process?.required === false
      && Array.isArray(process?.observationErrors)
      && process.observationErrors.length === 0;
  }
  const nativeWindowsPids = timeout?.nativeWindowsPids;
  return process?.required === true
    && process?.availableBefore === true
    && process?.availableAfterDelay === true
    && process?.hostAliveBefore === true
    && process?.hostAliveAfterDelay === true
    && Number(process?.ownedIdentityCount) > 0
    && Array.isArray(nativeWindowsPids)
    && nativeWindowsPids.length > 0
    && nativeWindowsPids.every((pid) => Number.isSafeInteger(Number(pid)) && Number(pid) > 0)
    && Array.isArray(process?.remaining)
    && process.remaining.length === 0
    && Array.isArray(process?.observationErrors)
    && process.observationErrors.length === 0;
}

function timeoutWslSessionEvidenceIsClean(timeout) {
  const publicSession = timeout?.timeoutPublicSessionAtBarrier
    ?? timeout?.publicSessionAtBarrier;
  return publicSession?.listAvailable === true
    && publicSession?.readAvailable === true
    && Array.isArray(publicSession?.snapshots)
    && publicSession.snapshots.length > 0
    && Array.isArray(publicSession?.observationErrors)
    && publicSession.observationErrors.length === 0
    && terminalSnapshotsAreObserved(timeout?.timeoutExistingTerminalSnapshots);
}

function boundedResetToolIsClean(tool) {
  return isRecord(tool)
    && tool.timedOut === false
    && tool.initial?.status === "fulfilled"
    && tool.signalAborted === false;
}

function displayCsiContractIsStrict(frame, expectedBackendType) {
  const entries = frame?.promptDisplayCsi;
  if (!Array.isArray(entries)) return false;
  const gapStart = frame?.promptControlEndAt ?? frame?.promptOscEndAt;
  const gapEnd = frame?.promptAt;
  if (!Number.isSafeInteger(gapStart) || !Number.isSafeInteger(gapEnd) || gapEnd < gapStart) return false;
  if (expectedBackendType === "wsl") {
    return entries.length === 0
      && frame?.promptVisibleGap === ""
      && frame?.promptDisplayCsiWellFormed === true;
  }
  if (expectedBackendType !== "git-bash"
    || frame?.promptDisplayCsiWellFormed !== true
    || frame?.readinessPair?.displayCsiWellFormed !== true) return false;
  const legal = /^\u001b\[[0-9;?]*(?:A|B|C|D|E|F|G|H|J|K|X|f|h|l|m|s|u)$/;
  return entries.every((entry, index) => {
    const previous = entries[index - 1];
    return typeof entry?.token === "string"
      && legal.test(entry.token)
      && Number.isSafeInteger(entry.at)
      && Number.isSafeInteger(entry.endAt)
      && entry.endAt > entry.at
      && entry.at >= gapStart
      && entry.endAt <= gapEnd
      && (index === 0 || entry.at >= previous.endAt);
  });
}

function canonicalPromptStatus(value) {
  const text = String(value ?? "");
  if (!/^(?:0|[1-9][0-9]*)$/.test(text)) return null;
  const number = Number(text);
  return Number.isSafeInteger(number)
    && number >= 0
    && number <= 255
    && String(number) === text
    ? number
    : null;
}

function promptReadinessIsStrict(frame, expectedBackendType) {
  const readiness = frame?.readinessPair;
  const status = canonicalPromptStatus(frame?.promptControlStatusText);
  const controlAt = frame?.promptControlAt;
  const controlEndAt = frame?.promptControlEndAt;
  const promptAt = frame?.promptAt;
  const stem = "__DSH_PERSISTENT_BASH_PROMPT__";
  const visibleToken = expectedBackendType === "git-bash" ? stem : `${stem} `;
  if (!isRecord(readiness)
    || readiness.complete !== true
    || readiness.visibleAt !== promptAt
    || readiness.visibleToken !== visibleToken
    || readiness.controlAt !== controlAt
    || readiness.controlEndAt !== controlEndAt
    || readiness.completeValidControl !== (expectedBackendType === "git-bash")
    || readiness.legacyControlValid !== (expectedBackendType === "wsl")
    || frame.promptControlCompleteValid !== (expectedBackendType === "git-bash")
    || frame.promptControlLegacyValid !== (expectedBackendType === "wsl")
    || !Number.isSafeInteger(controlAt)
    || !Number.isSafeInteger(controlEndAt)
    || controlEndAt <= controlAt
    || !Number.isSafeInteger(promptAt)
    || (expectedBackendType === "git-bash"
      ? promptAt < controlEndAt
      : promptAt !== controlEndAt)
    || readiness.byteAdjacent !== (controlEndAt === promptAt)
    || frame.promptControlByteAdjacent !== (controlEndAt === promptAt)
    || status === null
    || frame.promptControlStatus !== status
    || frame.promptControlStatusText !== String(status)) return false;
  const expectedPayload = expectedBackendType === "git-bash"
    ? `133;D;${status};${stem}`
    : `133;D;${status}`;
  const expectedToken = `\u001b]${expectedPayload}\u0007`;
  return frame.promptControlPayload === expectedPayload
    && frame.promptControlToken === expectedToken
    && (expectedBackendType === "git-bash"
      ? controlAt > frame.startIndex
      : controlAt > frame.endIndex);
}

function frameContractIsStrict(frame, expectedSource, expectedBackendType, requireNoisy) {
  const nextStartIndex = frame?.nextStartIndex;
  const promptAt = frame?.promptAt;
  const promptOscAt = frame?.promptOscAt;
  const promptOscEndAt = frame?.promptOscEndAt;
  const expectedPromptContract = promptContractForBackend(expectedBackendType);
  const common = isRecord(frame)
    && frame.isNew === true
    && typeof frame.nonce === "string"
    && frame.nonce.length > 0
    && frame.startObserved === true
    && frame.endObserved === true
    && Number.isSafeInteger(frame.startIndex)
    && Number.isSafeInteger(frame.endIndex)
    && frame.endIndex > frame.startIndex
    && (nextStartIndex === null
      || (Number.isSafeInteger(nextStartIndex) && nextStartIndex > frame.endIndex))
    && frame.exitCode === 0
    && frame.promptAfterEnd === true
    && Number.isSafeInteger(promptAt)
    && Number.isSafeInteger(frame.promptEndAt)
    && frame.promptEndAt > promptAt
    && promptAt > frame.endIndex
    && (nextStartIndex === null || promptAt < nextStartIndex)
    && (!requireNoisy || frame.noisyAfterStart === true)
    && Number.isSafeInteger(frame.rollingWindowBytes)
    && frame.rollingWindowBytes > 0
    && frame.rollingWindowBytes <= 65_536
    && isSha256(frame.rollingWindowSha256)
    && frame.source === expectedSource
    && frame.backendType === expectedBackendType;
  if (!common) return false;
  if (expectedSource === "official-terminals.read") {
    return frame.publicVisiblePrompt === true
      && frame.readinessPair === null
      && frame.promptOscAt === null
      && frame.promptOscEndAt === null
      && frame.promptControlAt === null
      && frame.promptControlEndAt === null
      && frame.promptControlToken === null
      && frame.promptControlPayload === null
      && frame.promptControlStatusText === null
      && frame.promptControlStatus === null
      && frame.promptControlCompleteValid === false
      && frame.promptControlLegacyValid === false
      && frame.promptControlByteAdjacent === false
      && frame.oscInFrame === false
      && Array.isArray(frame.promptDisplayCsi)
      && frame.promptDisplayCsi.length === 0
      && frame.promptVisibleGap === "";
  }
  const readinessStrict = promptReadinessIsStrict(frame, expectedBackendType);
  return frame.promptContract === expectedPromptContract
    && frame.publicVisiblePrompt === false
    && displayCsiContractIsStrict(frame, expectedBackendType)
    && Number.isSafeInteger(promptOscAt)
    && Number.isSafeInteger(promptOscEndAt)
    && promptOscAt === frame.promptControlAt
    && promptOscEndAt === frame.promptControlEndAt
    && (expectedBackendType === "git-bash"
      ? promptOscAt > frame.startIndex
      : promptOscAt > frame.endIndex)
    && promptOscAt < promptAt
    && (expectedBackendType === "git-bash"
      ? promptOscEndAt <= promptAt
      : promptOscEndAt === promptAt)
    && readinessStrict;
}

function publicBackgroundQueriesAreStrict(background) {
  const observations = background?.publicTerminalObservations;
  return Array.isArray(observations)
    && observations.length > 0
    && observations.every((entry) => entry?.source === "official-terminals.read rolling64KiB snapshots"
      && Array.isArray(entry.snapshots)
      && entry.snapshots.length > 0
      && entry.snapshots.every((snapshot) => {
        const observation = snapshot?.observation;
        return observation?.listAvailable === true
          && observation?.readAvailable === true
          && Array.isArray(observation.observationErrors)
          && observation.observationErrors.length === 0
          && Array.isArray(observation.reads)
          && observation.reads.length > 0
          && observation.reads.every((read) => {
            const trace = read?.streamTrace ?? read;
            return typeof read?.sessionId === "string"
              && isRecord(trace)
              && trace.observationMode === "public-visible"
              && Array.isArray(trace.frameStarts)
              && trace.frameStarts.length > 0
              && Array.isArray(trace.frameEnds);
          });
      }));
}

function rawBackgroundQueriesAreStrict(background) {
  const raw = background?.rawStdoutTrace;
  return isRecord(raw)
    && raw.source === "public-subprocess.stdout data"
    && raw.observed === true
    && Number.isSafeInteger(raw.observerCount)
    && raw.observerCount > 0
    && Array.isArray(raw.snapshots)
    && raw.snapshots.length > 0
    && raw.snapshots.every((snapshot) => {
      const trace = snapshot?.streamTrace ?? snapshot;
      return snapshot?.source === "public-subprocess.stdout data"
        && snapshot.available === true
        && snapshot.installed === true
        && snapshot.error === null
        && isRecord(trace)
        && trace.observationMode !== "public-visible"
        && Array.isArray(trace.frameStarts)
        && trace.frameStarts.length > 0
        && Array.isArray(trace.frameEnds);
    });
}

function rollingSnapshotPromptIsStrict(snapshot, expectedBackendType) {
  const trace = snapshot?.streamTrace;
  const pairs = Array.isArray(trace?.promptPairs) ? trace.promptPairs : [];
  if (trace?.observationMode === "public-visible") {
    return trace.hasVisiblePrompt === true
      && trace.hasControlledPrompt === false
      && pairs.some((pair) =>
        pair?.publicVisible === true
        && pair.readinessPair === null
        && pair.completeValidControl === false
        && pair.legacyControlValid === false
        && pair.byteAdjacent === false);
  }
  return pairs.some((pair) => {
    const readiness = pair?.readinessPair;
    return isRecord(readiness)
      && readiness.complete === true
      && readiness.completeValidControl === (expectedBackendType === "git-bash")
      && readiness.legacyControlValid === (expectedBackendType === "wsl")
      && readiness.byteAdjacent === (readiness.controlEndAt === readiness.visibleAt)
      && pair.completeValidControl === (expectedBackendType === "git-bash")
      && pair.legacyControlValid === (expectedBackendType === "wsl")
      && pair.byteAdjacent === (readiness.controlEndAt === readiness.visibleAt);
  });
}

function backgroundFrameEvidenceIsStrict(background, modeId) {
  const expectedBackendType = modeId === "bash-git-bash" ? "git-bash" : "wsl";
  const expectedPromptContract = promptContractForBackend(expectedBackendType);
  const frameContracts = background?.frameContracts;
  const publicFrame = frameContracts?.publicFreshFrame;
  const rawFrame = frameContracts?.rawFreshFrame;
  const rolling = background?.rollingTrace;
  const rollingPromptSnapshots = rolling?.tokenSnapshots;
  const publicFrameStrict = frameContractIsStrict(publicFrame, "official-terminals.read", expectedBackendType, true);
  const rawFrameStrict = frameContractIsStrict(rawFrame, "public-subprocess.stdout data", expectedBackendType, false);
  const rollingStrict = Array.isArray(rollingPromptSnapshots)
    && rollingPromptSnapshots.length > 0
    && rollingPromptSnapshots.every((snapshot) =>
      snapshot?.backendType === expectedBackendType
      && rollingSnapshotPromptIsStrict(snapshot, expectedBackendType));
  const publicQueryStrict = publicBackgroundQueriesAreStrict(background);
  const rawQueryStrict = rawBackgroundQueriesAreStrict(background);
  return isRecord(frameContracts)
    && frameContracts.sameFreshFrameNonce === true
    && publicFrameStrict
    && rawFrameStrict
    && publicFrame.nonce === rawFrame.nonce
    && Array.isArray(frameContracts.publicCandidates)
    && frameContracts.publicCandidates.some((frame) => frame?.nonce === publicFrame.nonce)
    && Array.isArray(frameContracts.rawCandidates)
    && frameContracts.rawCandidates.some((frame) => frame?.nonce === rawFrame.nonce)
    && isRecord(rolling)
    && rolling.observed === true
    && Number.isSafeInteger(rolling.snapshotCount)
    && rolling.snapshotCount > 0
    && Array.isArray(rolling.observationErrors)
    && rolling.observationErrors.length === 0
    && Array.isArray(rolling.requiredTokens)
    && rolling.requiredTokens.includes("current START nonce")
    && rolling.requiredTokens.includes("current END:0")
    && rollingStrict
    && publicQueryStrict
    && rawQueryStrict;
}

function backgroundReapEvidenceIsStrict(background) {
  const reap = background?.backgroundReap;
  const stopOutput = String(background?.stop?.output ?? "");
  return background?.backgroundReapOk === true
    && isRecord(reap)
    && Number.isSafeInteger(reap.backgroundLinuxPid)
    && reap.backgroundLinuxPid > 0
    && reap.pidMatchesStart === true
    && reap.jobPresentBefore === 1
    && reap.aliveBefore === 1
    && reap.killAttempted === 1
    && reap.killStatus === 0
    && reap.waitAttempted === 1
    && reap.waitStatus === 143
    && reap.aliveAfter === 0
    && typeof reap.jobsAfter === "string"
    && !reap.jobsAfter.split(/\s+/).filter(Boolean).includes(String(reap.backgroundLinuxPid))
    && /bg-reaped pid=\d+ jobPresentBefore=1 aliveBefore=1 killAttempted=1 killStatus=0 waitAttempted=1 waitStatus=143 aliveAfter=0\b/.test(stopOutput);
}

function strictTimeoutEvidence(timeout, modeId) {
  const settlements = timeout?.timeoutHandleSettlements;
  const count = Number(timeout?.timeoutHandlesToSettleCount);
  const result = timeout?.timeoutOk === true
    && timeout?.readyObserved === true
    && timeout?.timeoutGuarded === false
    && timeout?.timeoutCallError === null
    && isRecord(timeout?.timeout)
    && officialTimeoutTextIsPresent(timeout)
    && timeout.timeout.timedOut !== false
    && timeout.timeout.aborted !== true
    && timeout?.timeoutLeakCreated === false
    && timeout?.timeoutExistingHandleObserved === true
    && (modeId === "bash-git-bash"
      ? timeout?.timeoutExistingIdentityObserved === true
      : timeoutWslSessionEvidenceIsClean(timeout))
    && managedCapabilitiesAreClean(timeout?.timeoutExistingManagedHandles)
    && terminalSnapshotsAreObserved(timeout?.timeoutExistingTerminalSnapshots)
    && timeout?.timeoutHandleQuiesced === true
    && boundedResetToolIsClean(timeout?.resetTool)
    && Number.isSafeInteger(count)
    && count > 0
    && managedSettlementsAreClean(settlements, count)
    && timeoutProcessIsClean(timeout, modeId);
  return result;
}

function advancedLifecycleCheck(index, modeId, failures) {
  const required = [...ADVANCED_COMMON_REQUIRED_CHECKS,
    ...(modeId === "bash-git-bash" ? ADVANCED_GIT_REQUIRED_CHECKS : [])];
  for (const suffix of required) requirePass(index, `${modeId}:${suffix}`, failures);

  const background = index.get(`${modeId}:background-process-cleanup`)?.[0]?.evidence;
  const backgroundStart = background?.start;
  const backgroundStop = background?.stop;
  const strictBackground = backgroundFrameEvidenceIsStrict(background, modeId);
  const cleanResult = (result) => result?.parsedExitCode === 0
    && result?.isError !== true
    && result?.error === null
    && result?.timedOut !== true
    && result?.aborted !== true;
  if (background?.backgroundOk !== true
    || background?.noisyOutputObserved !== true
    || !cleanResult(backgroundStart)
    || !cleanResult(backgroundStop)
    || !strictBackground
    || !backgroundReapEvidenceIsStrict(background)) {
    failures.push(`${modeId}:background-process-cleanup did not prove noisy background activity, current frame nonce, public/raw observations, and PID reaping were cleanly verified`);
  }

  const natural = index.get(`${modeId}:natural-exit-reset`)?.[0]?.evidence;
  if (natural?.naturalOk !== true
    || natural?.naturalExit?.shellExited !== true
    || natural?.naturalExit?.parsedExitCode !== 0
    || !cleanResult(natural?.naturalExit)
    || !cleanResult(natural?.reset)
    || !String(natural?.reset?.output ?? "").includes("natural-exit-reset")) {
    failures.push(`${modeId}:natural-exit-reset did not prove exitCode 0 and clean shell reset`);
  }
  if (modeId === "bash-git-bash") {
    const naturalLedger = natural?.processLedger;
    if (naturalLedger?.available !== true
      || !(Number(naturalLedger?.ownedIdentityCount) > 0)
      || naturalLedger?.delayedMarkerCreated !== false
      || !Array.isArray(naturalLedger?.afterDelayRows)
      || naturalLedger.afterDelayRows.length !== 0
      || !Array.isArray(naturalLedger?.remainingBeforeOwnerDispose)
      || naturalLedger.remainingBeforeOwnerDispose.length !== 0
      || !(Number(naturalLedger?.frame?.shellWinPid) > 0)
      || !(Number(naturalLedger?.frame?.backgroundWinPid) > 0)) {
      failures.push(`${modeId}:natural-exit-reset lacks delayed BG/helper/ConHost identity zero evidence`);
    }
  }

  const timeout = index.get(`${modeId}:timeout-reset`)?.[0]?.evidence;
  if (!strictTimeoutEvidence(timeout, modeId)
    || !cleanResult(timeout?.reset)
    || !String(timeout?.reset?.output ?? "").includes("timeout-state-reset")
    || String(timeout?.reset?.output ?? "").includes("timeout-state-stale")
    || !String(timeout?.reset?.output ?? "").includes("timeout-reset")) {
    failures.push(`${modeId}:timeout-reset did not prove the official 10-second timeout text, settled old handles, zero identities, and clean shell reset`);
  }

  const cancel = index.get(`${modeId}:cancel-reset`)?.[0]?.evidence;
  if (!strictCancellationEvidence(cancel, modeId)
    || !cleanResult(cancel?.reset)
    || !String(cancel?.reset?.output ?? "").includes("cancel-reset")) {
    failures.push(`${modeId}:cancel-reset did not prove typed AbortError/ABORTED, real signal start, settled old handles, zero identities, and clean reset`);
  }

  const cross = index.get(`${modeId}:cross-agent-isolation`)?.[0]?.evidence;
  if (cross?.crossOk !== true) failures.push(`${modeId}:cross-agent-isolation did not prove owner separation`);

  if (modeId === "bash-git-bash") {
    const standing = index.get(`${modeId}:standing-full-access`)?.[0]?.evidence;
    if (standing?.permissionAfter !== "danger-full-access") {
      failures.push("bash-git-bash:standing-full-access did not prove explicit danger-full-access");
    }
    const pty = index.get(`${modeId}:native-pid-pty`)?.[0]?.evidence;
    if (!(Number(pty?.nativePid) > 0)
      || pty?.truePty !== true
      || pty?.helperSpawnObserved !== true) {
      failures.push("bash-git-bash:native-pid-pty did not prove a positive true PTY pid and broker helper spawn");
    }
    const helper = index.get(`${modeId}:helper-job-quiescence`)?.[0]?.evidence;
    const helperCapabilities = helper?.nativeHandleCapabilities;
    const helperSettlements = helper?.nativeHandleSettlements;
    if (helper?.nativeHandlesSettled !== true
      || helper?.nativeHandleApiOk !== true
      || helper?.processCleanupOk !== true
      || !Array.isArray(helper?.processAfterOwnerDisposeRows)
      || helper.processAfterOwnerDisposeRows.length !== 0
      || helper?.afterActivity !== false
      || !Array.isArray(helper?.snapshotsAfterDispose)
      || helper.snapshotsAfterDispose.length !== 0
      || !managedCapabilitiesAreClean(helperCapabilities)
      || !managedSettlementsAreClean(helperSettlements)
      || helperCapabilities.length !== helperSettlements.length
      || !Array.isArray(helper?.processObservationErrors)
      || helper.processObservationErrors.length !== 0) {
      failures.push("bash-git-bash:helper-job-quiescence did not prove non-empty matched helper/ConPTY handle settlement and zero owned activity");
    }
    for (const suffix of ["natural-exit-delayed-background", "natural-exit-noisy-background"]) {
      const scenario = index.get(`${modeId}:${suffix}`)?.[0]?.evidence;
      const scenarioLedger = scenario?.processLedger;
      const scenarioMarkerCreated = scenarioLedger?.markerCreated
        ?? scenarioLedger?.delayedMarkerCreated;
      const scenarioRemaining = scenarioLedger?.remaining
        ?? scenarioLedger?.remainingBeforeOwnerDispose;
      if (scenario?.noisyOk === false
        || (suffix.endsWith("noisy-background") && scenario?.noisyOutputObserved !== true)
        || scenarioLedger?.available !== true
        || !(Number(scenarioLedger?.ownedIdentityCount) > 0)
        || scenarioMarkerCreated !== false
        || !Array.isArray(scenarioLedger?.afterDelayRows)
        || scenarioLedger.afterDelayRows.length !== 0
        || !Array.isArray(scenarioRemaining)
        || scenarioRemaining.length !== 0
        || !(Number(scenarioLedger?.frame?.shellWinPid) > 0)
        || !(Number(scenarioLedger?.frame?.backgroundWinPid) > 0)) {
        failures.push(`bash-git-bash:${suffix} did not prove delayed/noisy BG and helper/ConHost identity zero`);
      }
    }
  }
}

function modeCompositionCheck(check, modeId, failures) {
  const evidence = check?.evidence;
  if (evidence?.mode?.id !== modeId
    || evidence?.rowPreservesStandard !== true
    || evidence?.deepConfigMatch !== true
    || evidence?.jsNodeCountMatch !== true
    || evidence?.stockBashRemoved !== true
    || evidence?.pluginRows !== 1
    || evidence?.persistentRows !== 1
    || evidence?.isolatedTerminalGroups !== 1
    || evidence?.nativeModeGroups !== 1
    || evidence?.configOk !== true) {
    failures.push(`${modeId}:standard-composition does not preserve the host Standard tree or isolate the mode group`);
  }
  return evidence;
}

function modePromptCheck(check, modeId, failures) {
  const evidence = check?.evidence;
  if (evidence?.sectionCount !== 1
    || evidence?.sectionPresent !== true
    || evidence?.interpolate !== false
    || evidence?.exactInstalledText !== true
    || evidence?.oppositeHeaderAbsent !== true
    || evidence?.hasModeHeader !== true
    || evidence?.renderedPluginMarker !== true
    || evidence?.promptSchemaHasPwsh !== true) {
    failures.push(`${modeId}:system-prompt is not the exact single literal installed mode section with pwsh`);
  }
  return evidence;
}

export function validateNativeModesDesktopEvidence(report, options = {}) {
  const failures = [];
  const candidateSha256 = options.candidateSha256;
  const expectedAsarSha256 = options.expectedAsarSha256;
  const expectedExecutableSha256 = options.expectedExecutableSha256;
  const probeSourceSha256 = options.probeSourceSha256;
  const requirePassReport = (condition, detail) => {
    if (!condition) failures.push(detail);
  };

  requirePassReport(isRecord(report) && report.schemaVersion === 1, "Desktop native mode evidence schemaVersion is not 1");
  requirePassReport(report?.status === "PASS", "Desktop native mode evidence status is not PASS");
  requirePassReport(report?.cleanup?.temporaryRootRemoved === true, "Desktop native mode temporary root cleanup is not proven");
  requirePassReport(isSha256(candidateSha256), "candidate TGZ SHA is missing from the gate");
  requirePassReport(report?.probeIdentity?.sourcePath === "dev/测试/桌面/new-modes-desktop-artifact.mjs"
    && report?.probeIdentity?.sourceSha256 === probeSourceSha256
    && isSha256(report?.probeIdentity?.sourceSha256),
  "Desktop native mode evidence is not bound to the current probe source SHA");

  const top = checkIndex(report?.checks);
  for (const id of TOP_REQUIRED_CHECKS) requirePass(top, id, failures);
  const tgzCheck = top.get("tgz-content-dependency-path-audit")?.[0];
  requirePassReport(tgzCheck?.evidence?.sha256 === candidateSha256,
    "Desktop native mode evidence is not bound to the explicit candidate TGZ SHA");
  const sourceDistHashes = tgzCheck?.evidence?.sourceDistHashes;
  const tarDistHashes = tgzCheck?.evidence?.tarDistHashes;
  requirePassReport(isRecord(sourceDistHashes) && isRecord(tarDistHashes)
    && Object.keys(sourceDistHashes).length > 0
    && Object.keys(sourceDistHashes).length === Object.keys(tarDistHashes).length
    && Object.entries(sourceDistHashes).every(([path, hash]) => isSha256(hash) && tarDistHashes[path] === hash),
  "candidate TGZ dist hashes are not equal to the current source dist hashes");
  const runtimeHashCheck = top.get("desktop-runtime-hashes")?.[0];
  requirePassReport(runtimeHashCheck?.evidence?.appAsarSha256 === expectedAsarSha256,
    "Desktop native mode evidence is not bound to the expected rc.3 app.asar SHA");
  requirePassReport(runtimeHashCheck?.evidence?.executableSha256 === expectedExecutableSha256,
    "Desktop native mode evidence is not bound to the expected rc.3 executable SHA");
  for (const id of ["disabled-before:desktop-child", "enabled-retained:desktop-child", "disabled-after:desktop-child"]) {
    requirePassReport(topChildCheckLifecycleIsClean(top.get(id)?.[0]), `${id} child lifecycle is not clean`);
  }

  const phases = Array.isArray(report?.phases) ? report.phases : [];
  const phaseByLabel = new Map(phases.map((phase) => [phase?.label, phase]));
  requirePassReport(phases.length === NATIVE_MODE_PHASES.length
    && NATIVE_MODE_PHASES.every((label) => phaseByLabel.has(label)),
  "Desktop native mode phase roster is incomplete");
  for (const label of NATIVE_MODE_PHASES) {
    const phase = phaseByLabel.get(label);
    requirePassReport(phase?.status === "PASS", `${label} phase did not report PASS`);
    requirePassReport(childLifecycleIsClean(phase), `${label} phase child lifecycle is not clean`);
    const phaseIndex = checkIndex(phase?.evidence?.checks);
    if (label === "enabled-retained") {
      for (const id of ENABLED_REQUIRED_CHECKS) requirePass(phaseIndex, id, failures);
      for (const modeId of NATIVE_MODE_IDS) {
        modeCompositionCheck(requirePass(phaseIndex, `${modeId}:standard-composition`, failures), modeId, failures);
        modePromptCheck(requirePass(phaseIndex, `${modeId}:system-prompt`, failures), modeId, failures);
        lifecycleCheck(requirePass(phaseIndex, `${modeId}:native-lifecycle`, failures), modeId, failures);
        ownerDisposeCheck(requirePass(phaseIndex, `${modeId}:owner-dispose`, failures), modeId, failures);
        advancedLifecycleCheck(phaseIndex, modeId, failures);
      }
      const roster = phaseIndex.get("mode-roster")?.[0]?.evidence;
      requirePassReport(Array.isArray(roster?.ids)
        && NATIVE_MODE_IDS.every((id) => roster.ids.includes(id))
        && new Set(roster.ids).size === roster.ids.length,
      "actual Desktop mode roster does not contain exactly unique native mode IDs");
      const defaultCheck = phaseIndex.get("default-unchanged")?.[0]?.evidence;
      requirePassReport(defaultCheck?.defaultBefore === "standard"
        && Array.isArray(defaultCheck?.defaultAfter)
        && defaultCheck.defaultAfter.length === 1
        && defaultCheck.defaultAfter[0] === "standard",
      "native mode registration changed the selected Standard default");
      const rootCleanup = phaseIndex.get("plugin-unload-root-cleanup")?.[0]?.evidence;
      requirePassReport(rootCleanup?.bundleReloadAttempted === true
        && rootCleanup?.pluginBashRemovedOrStockRestored === true
        && rootCleanup?.standardScopePreserved === true
        && Array.isArray(rootCleanup?.globalPromptModeSections)
        && rootCleanup.globalPromptModeSections.length === 0,
      "complete native bundle unload did not remove root plugin scope while preserving Standard");
      const retained = phaseIndex.get("plugin-unload-retained-revision")?.[0]?.evidence;
      requirePassReport(retained?.unloadError === null
        && retained?.bundleReloadAttempted === true
        && typeof retained?.retainedOutput === "string"
        && retained.retainedOutput.includes("retained-after-unload"),
      "retained Agent revision was not exercised after complete bundle retirement");
      const released = phaseIndex.get("retained-revision-release")?.[0]?.evidence;
      requirePassReport(released?.retainedActivityAfterDispose === false
        && Array.isArray(released?.retainedSnapshotsAfterDispose)
        && released.retainedSnapshotsAfterDispose.length === 0,
      "retained native mode scope was not quiescent after Agent release");
      const gitGuard = phaseIndex.get("bash-git-bash:no-implicit-escalation")?.[0]?.evidence;
      requirePassReport(gitGuard?.directDenied === true
        && gitGuard?.directSpawnedSession === null
        && gitGuard?.spawnDelta === 0
        && Array.isArray(gitGuard?.nativeSpawns)
        && gitGuard.nativeSpawns.length === 0,
      "restricted Git Bash did not prove explicit denial before native spawn");
    } else {
      for (const id of DISABLED_REQUIRED_CHECKS) requirePass(phaseIndex, id, failures);
      const disabledRoster = phaseIndex.get("disabled-roster")?.[0]?.evidence;
      const disabledTools = phaseIndex.get("disabled-tools-and-backends")?.[0]?.evidence;
      requirePassReport(Array.isArray(disabledRoster?.roster)
        && disabledRoster.roster.every((row) => !NATIVE_MODE_IDS.includes(row?.id)),
        `${label} retained a native mode definition after disable`);
      requirePassReport(!disabledTools?.toolNames?.includes?.("wsl_bash")
        && !disabledTools?.toolNames?.includes?.("git_bash")
        && !disabledTools?.terminalBackends?.includes?.("wsl")
        && !disabledTools?.terminalBackends?.includes?.("git-bash"),
      `${label} retained native mode tools or terminal backends after disable`);
    }
  }
  return {
    ok: failures.length === 0,
    failures,
    detail: failures.length === 0
      ? "strict actual-Desktop native WSL/Git mode backend evidence matched"
      : failures.slice(0, 12).join("; "),
  };
}

export function validateNativeModesGuiRosterEvidence(evidence, options = {}) {
  const failures = [];
  const require = (condition, detail) => {
    if (!condition) failures.push(detail);
  };
  const candidateSha256 = options.candidateSha256;
  const expectedAsarSha256 = options.expectedAsarSha256;
  const expectedExecutableSha256 = options.expectedExecutableSha256;
  const legacyRoster = candidateSha256 === CANONICAL_TGZ_SHA256;
  require(isRecord(evidence) && evidence.schemaVersion === 1, "GUI native mode roster schemaVersion is not 1");
  require(evidence?.status === "PASS", "GUI native mode roster status is not PASS");
  require(GUI_ROSTER_SOURCES.has(evidence?.source)
    && evidence?.independent === true,
  "GUI native mode roster is not an independent allowlisted GUI observation");
  const identity = evidence?.desktopIdentity;
  require(identity?.tgzSha256 === candidateSha256, "GUI native mode roster TGZ SHA is not the candidate SHA");
  require(identity?.appAsarSha256 === expectedAsarSha256, "GUI native mode roster app.asar SHA is mismatched");
  require(identity?.executableSha256 === expectedExecutableSha256, "GUI native mode roster executable SHA is mismatched");
  const roster = evidence?.roster;
  const modeIds = Array.isArray(roster?.modeIds)
    ? roster.modeIds
    : Array.isArray(roster?.modes) ? roster.modes.map((mode) => mode?.id) : [];
  require(Array.isArray(modeIds)
    && modeIds.length === NATIVE_MODE_IDS.length
    && new Set(modeIds).size === NATIVE_MODE_IDS.length
    && NATIVE_MODE_IDS.every((id) => modeIds.includes(id)),
  "GUI roster does not show both unique native mode IDs");
  const legacyCleanup = evidence?.cleanup?.strategy !== "reused-protected-owned-fixture"
    && evidence?.cleanup?.temporaryRootRemoved === true
    && evidence?.cleanup?.profileContained === true;
  const reuseCleanup = reusedProtectedFixtureCleanupIsStrict(evidence?.cleanup);
  require(roster?.uniqueOwnedWindow === true
    && roster?.pluginEnabled === true
    && roster?.modeMenuVisible === true
    && roster?.bashWslVisible === true
    && roster?.gitBashVisible === true
    && (legacyRoster ? roster?.pwshVisible === true : true)
    && roster?.selectedDefault === "standard",
  "GUI roster did not prove one owned window, both modes, and unchanged Standard default");
  require(legacyCleanup || reuseCleanup,
    "GUI roster temporary profile cleanup/containment is not proven");
  if (!legacyRoster || reuseCleanup) {
    require(actualDesktopPwshPreservationIsStrict(evidence, options),
      "GUI roster pwsh preservation is not bound to strict actual Desktop native evidence");
  }
  if (reuseCleanup) {
    require(reuseDriverArtifactsAreStrict(evidence, options),
      "GUI roster protected-fixture reuse driver artifacts are not bound or clean");
  }
  return {
    ok: failures.length === 0,
    failures,
    detail: failures.length === 0
      ? "independent GUI roster showed both native modes with Standard/pwsh preserved"
      : failures.slice(0, 12).join("; "),
  };
}

const CLI_NATIVE_CASE_PREFIXES = {
  "wsl": [
    "CLI-NATIVE-01",
    "CLI-NATIVE-03",
    "CLI-NATIVE-04",
    "CLI-NATIVE-05",
    "CLI-NATIVE-06",
    "CLI-NATIVE-07",
    "CLI-NATIVE-08",
    "CLI-NATIVE-09",
  ],
  "git-bash": [
    "CLI-NATIVE-01",
    "CLI-NATIVE-02",
    "CLI-NATIVE-03",
    "CLI-NATIVE-04",
    "CLI-NATIVE-05",
    "CLI-NATIVE-06",
    "CLI-NATIVE-07",
    "CLI-NATIVE-08",
    "CLI-NATIVE-09",
    "CLI-NATIVE-10",
    "CLI-NATIVE-11",
  ],
};

function hasTypedAbortEvidence(evidence) {
  return evidence?.controllerSignalAborted === true
    && (evidence?.typedEnvelopeAbort === true
      || evidence?.emptyOutputAbort === true
      || (evidence?.abortErrorInfo?.name === "AbortError"
        && evidence?.abortErrorInfo?.code === "ABORTED"));
}

function afterDisposeTreeRowsAreClean(afterDispose, expectedCount = undefined) {
  const trees = afterDispose?.trees;
  if (trees === undefined) return expectedCount === undefined;
  return Array.isArray(trees)
    && (expectedCount === undefined || trees.length === expectedCount)
    && trees.every((tree) => isRecord(tree)
      && Array.isArray(tree.remaining)
      && tree.remaining.length === 0
      && Array.isArray(tree.helperDescendants)
      && tree.helperDescendants.length === 0
      && tree.observationError == null
      && tree.error == null
      && tree.queryError == null
      && (!Array.isArray(tree.observationErrors) || tree.observationErrors.length === 0)
      && (!Array.isArray(tree.errors) || tree.errors.length === 0));
}

function hasZeroObservedIdentities(native, expectedTreeCount = undefined) {
  const afterDispose = native?.afterDispose;
  return isRecord(afterDispose)
    && afterDispose.helper === null
    && afterDispose.top === null
    && afterDispose.shell === null
    && Array.isArray(afterDispose.remaining)
    && afterDispose.remaining.length === 0
    && Array.isArray(afterDispose.helperChildren)
    && afterDispose.helperChildren.length === 0
    && afterDisposeTreeRowsAreClean(afterDispose, expectedTreeCount);
}

function processIdentityMatches(identity, pid) {
  return isRecord(identity)
    && Number.isSafeInteger(pid)
    && pid > 0
    && Number.isSafeInteger(identity.ProcessId)
    && identity.ProcessId > 0
    && identity.ProcessId === pid
    && typeof identity.CreationDate === "string"
    && identity.CreationDate.length > 0;
}

function aggregateNativeTreesAreClean(native) {
  const trees = native?.trees;
  if (!Array.isArray(trees) || trees.length === 0
    || !hasZeroObservedIdentities(native, trees.length)) return false;
  const identitiesByRole = new Map([
    ["helper", new Set()],
    ["top", new Set()],
    ["shell", new Set()],
    ["conhost", new Set()],
  ]);
  for (const tree of trees) {
    if (!isRecord(tree)
      || !processIdentityMatches(tree.helper, tree.helperPid)
      || !processIdentityMatches(tree.top, tree.topPid)
      || !processIdentityMatches(tree.shell, tree.shellPid)
      || !processIdentityMatches(tree.conhost, tree.conhost?.ProcessId)) {
      return false;
    }
    for (const [role, identity] of [
      ["helper", tree.helper],
      ["top", tree.top],
      ["shell", tree.shell],
      ["conhost", tree.conhost],
    ]) {
      const key = `${identity.ProcessId}:${identity.CreationDate}`;
      const seen = identitiesByRole.get(role);
      if (seen.has(key)) return false;
      seen.add(key);
    }
  }
  return true;
}

function cliSettlementsHaveUniqueIndexes(settlements) {
  return Array.isArray(settlements)
    && settlements.length > 0
    && settlements.every((entry) => Number.isSafeInteger(entry?.index))
    && new Set(settlements.map((entry) => entry.index)).size === settlements.length;
}

function aggregateManagedSettlementsAreClean(evidence, native) {
  const trees = native?.trees;
  const settlements = evidence?.nativeManagedSettlements
    ?? native?.nativeManagedSettlements
    ?? native?.managedSettlements;
  return Array.isArray(trees)
    && trees.length > 0
    && Array.isArray(settlements)
    && settlements.length === trees.length
    && settlements.every((entry) => Number.isSafeInteger(entry?.index)
      && entry.index >= 0
      && entry.index < trees.length)
    && new Set(settlements.map((entry) => entry.index)).size === trees.length
    && settlements.every((entry) => isRecord(entry)
      && entry.waitForExit === true
      && entry.waitError === null
      && entry.doneError === null
      && isSubprocessOutcome(entry.done));
}

function hasNativeObservationClean(evidence) {
  const native = evidence?.nativeProcess ?? evidence?.observedHandle;
  return isRecord(native)
    && (Array.isArray(native.trees)
      ? aggregateNativeTreesAreClean(native)
      : hasZeroObservedIdentities(native))
    && native.observationError === null
    && (native.observerHostAliveAfterExit === true
      || evidence?.observerHostAliveAfterExit === true);
}

function hasManagedCompletionEvidence(evidence) {
  const native = evidence?.nativeProcess ?? evidence?.observedHandle;
  if (Array.isArray(native?.trees)) {
    return native.managedDone === true
      && native.managedWaitForExit === true
      && aggregateManagedSettlementsAreClean(evidence, native);
  }
  const settlements = evidence?.nativeManagedSettlements
    ?? evidence?.managedSettlements
    ?? native?.managedSettlements;
  const managedDone = evidence?.managedDone === true
    || native?.managedDone === true;
  const managedWaitForExit = evidence?.managedWaitForExit === true
    || native?.managedWaitForExit === true;
  return managedDone
    && managedWaitForExit
      && cliSettlementsHaveUniqueIndexes(settlements)
    && settlements.every((entry) => isRecord(entry)
      && entry.doneError === null
      && isSubprocessOutcome(entry.done)
      && entry.waitError === null
      && entry.waitForExit === true);
}

function hasNativeQuiescenceEvidence(evidence) {
  return hasNativeObservationClean(evidence)
    && hasManagedCompletionEvidence(evidence)
}

function hasNativeTimeoutEvidence(evidence) {
  const native = evidence?.nativeProcess ?? evidence?.observedHandle;
  if (!isRecord(native) || !hasNativeQuiescenceEvidence(evidence)) return false;
  if (Array.isArray(native.trees)) return aggregateNativeTreesAreClean(native);
  const helperPid = Number(native.helperPid);
  const shellPid = Number(native.shellPid);
  return (helperPid > 0 && shellPid > 0)
    || native.observedHandle === true;
}

function hasWslPublicSessionEvidence(evidence) {
  const sessions = evidence?.publicSession;
  return Array.isArray(sessions)
    && sessions.length > 0
    && sessions.every((session) => isRecord(session)
      && session.type === "wsl"
      && typeof session.sessionId === "string"
      && session.sessionId.length > 0
      && session.helperPid === undefined
       && session.shellPid === undefined
       && (session.pid === undefined || session.pid === null)
       && session.error === undefined);
}

function hasWslManagedCleanupEvidence(evidence) {
  return hasManagedCompletionEvidence(evidence)
    && hasWslPublicSessionEvidence(evidence)
    && evidence?.nativeProcess === undefined
    && evidence?.observedHandle === undefined
    && evidence?.observationError === null;
}

function hasWslStateEvidence(evidence) {
  return hasWslManagedCleanupEvidence(evidence)
    && evidence?.ownerActivityCleared === true;
}

function hasWslOwnerEvidence(evidence) {
  return hasWslManagedCleanupEvidence(evidence)
    && evidence?.ownerADisposed === true
    && evidence?.ownerBStayedAlive === true
    && evidence?.naturalExit === true
    && evidence?.naturalOwnerActivityCleared === true;
}

function hasWslCancellationEvidence(evidence) {
  return hasWslManagedCleanupEvidence(evidence)
    && evidence?.cancellationActivityCleared === true
    && evidence?.resetVerified === true
    && evidence?.leakMarkerCreated === false;
}

function hasWslTimeoutEvidence(evidence) {
  return hasWslManagedCleanupEvidence(evidence)
    && evidence?.timeoutOwnerActivityCleared === true
    && evidence?.naturalOwnerActivityCleared === true
    && evidence?.leakMarkerCreated === false;
}

function matchesCasePrefix(id, prefix) {
  return id === prefix || id.startsWith(`${prefix} `);
}

export function validateNativeModesCliEvidence(report, options = {}) {
  const failures = [];
  const candidateSha256 = options.candidateSha256;
  const cliProbeSourceSha256 = options.cliProbeSourceSha256;
  const cliProbeObserverSha256 = options.cliProbeObserverSha256;
  const expectedCliVersion = options.expectedCliVersion;
  const expectedCliPackageSha256 = options.expectedCliPackageSha256;
  const require = (condition, detail) => {
    if (!condition) failures.push(detail);
  };
  require(isRecord(report) && report.schemaVersion === 1,
    "CLI native mode evidence schemaVersion is not 1");
  require(report?.suite === "native-modes" && report?.status === "PASS",
    "CLI native mode evidence is not a PASS native-modes report");
  require(isSha256(candidateSha256),
    "CLI native mode candidate TGZ SHA is missing or invalid");
  require(isSha256(cliProbeSourceSha256),
    "CLI native mode probe source SHA is missing or invalid");
  require(isSha256(cliProbeObserverSha256),
    "CLI native mode Windows observer source SHA is missing or invalid");
  require(typeof expectedCliVersion === "string" && expectedCliVersion.length > 0,
    "CLI native mode expected CLI version is missing");
  require(isSha256(expectedCliPackageSha256),
    "CLI native mode expected CLI manifest SHA is missing or invalid");
  const modes = Array.isArray(report?.modes) ? report.modes : [];
  require(modes.length === 2
    && modes.map((mode) => mode?.mode).sort().join(",") === "git-bash,wsl",
  "CLI native mode evidence does not contain exactly one WSL and one Git Bash run");
  const byMode = new Map(modes.map((mode) => [mode?.mode, mode]));
  for (const modeId of ["wsl", "git-bash"]) {
    const mode = byMode.get(modeId);
    const host = mode?.host;
    require(mode?.status === "PASS", `CLI native ${modeId} report is not PASS`);
    require(mode?.cleanup?.temporaryRootRemoved === true,
      `CLI native ${modeId} temporary profile cleanup is not proven`);
    require(host?.pluginTgzSha256 === candidateSha256,
      `CLI native ${modeId} did not install the explicit candidate TGZ SHA`);
      require(host?.cliVersion === expectedCliVersion
        && host?.hostPlatform === "win32"
        && host?.cliPackageSha256 === expectedCliPackageSha256,
      `CLI native ${modeId} host identity is not the expected Windows CLI manifest`);
    require(host?.distHashesMatch === true
      && isSha256(host?.sourceDistSha256)
      && isSha256(host?.installedDistSha256)
      && host.sourceDistSha256 === host.installedDistSha256,
    `CLI native ${modeId} source/installed dist identity is not proven`);
    require(host?.probeIndexHashesMatch === true
      && isSha256(host?.probeSourceIndexSha256)
      && isSha256(host?.probeInstalledIndexSha256)
      && host.probeSourceIndexSha256 === cliProbeSourceSha256
      && host.probeSourceIndexSha256 === host.probeInstalledIndexSha256,
    `CLI native ${modeId} source/installed probe identity is not proven`);
    require(host?.probeObserverRequired === true
      && host?.probeObserverHashesMatch === true
      && isSha256(host?.probeSourceObserverSha256)
      && isSha256(host?.probeInstalledObserverSha256)
      && host.probeSourceObserverSha256 === cliProbeObserverSha256
      && host.probeSourceObserverSha256 === host.probeInstalledObserverSha256,
    `CLI native ${modeId} source/installed Windows observer identity is not proven`);
      const backendIdentity = mode?.backendId
        ?? mode?.backendType
        ?? mode?.persistentShell
        ?? mode?.mode;
      require(backendIdentity === modeId,
        `CLI native ${modeId} backend identity is missing or mismatched`);
      const outerChecks = Array.isArray(mode?.checks) ? mode.checks : [];
      const outerIndex = checkIndex(outerChecks);
      const nativeOuter = requirePass(outerIndex, `CLI-NATIVE-${modeId}`, failures);
      require(nativeOuter?.evidence?.status === "PASS",
        `CLI native ${modeId} outer lifecycle evidence is not PASS`);
    const raw = nativeOuter?.evidence;
      require(raw?.mode === "workspace-write",
        `CLI native ${modeId} nested probe sandbox mode is not workspace-write`);
    const nestedChecks = Array.isArray(raw?.checks) ? raw.checks : [];
    const nestedByPrefix = new Map(CLI_NATIVE_CASE_PREFIXES[modeId].map((prefix) => [
      prefix,
        nestedChecks.filter((nested) => matchesCasePrefix(String(nested?.id ?? ""), prefix)),
    ]));
    for (const prefix of CLI_NATIVE_CASE_PREFIXES[modeId]) {
      const matches = nestedByPrefix.get(prefix) ?? [];
      require(matches.length === 1 && matches[0]?.status === "PASS",
        `CLI native ${modeId} required case ${prefix} is missing, duplicated, or not PASS`);
    }
    const child = mode?.raw?.process;
    require(child?.exitCode === 0
      && child?.signal === null
      && child?.timedOut === false
      && child?.error == null
      && child?.closeObserved === true
      && child?.reaped === true,
    `CLI native ${modeId} child lifecycle is not clean`);

    const cancel = nestedByPrefix.get("CLI-NATIVE-05")?.[0]?.evidence;
    const timeout = nestedByPrefix.get("CLI-NATIVE-06")?.[0]?.evidence;
    const cancellationCleanupOk = modeId === "wsl"
      ? hasWslCancellationEvidence(cancel)
      : hasNativeQuiescenceEvidence(cancel);
    const timeoutCleanupOk = modeId === "wsl"
      ? hasWslTimeoutEvidence(timeout)
      : hasNativeQuiescenceEvidence(timeout);
    require(cancel?.started === true
      && cancel?.aborted === true
      && hasTypedAbortEvidence(cancel)
      && cancellationCleanupOk,
    `CLI native ${modeId} cancellation lacks typed ABORTED, backend-specific managed cleanup, reset, or quiescence proof`);
    require(timeout?.ready === true
      && timeout?.timedOut === true
      && timeout?.cleanReset === true
      && timeout?.cwdReset === true
      && timeout?.timeoutOwnerActivityCleared === true
      && timeout?.naturalExit === true
      && timeout?.naturalOwnerActivityCleared === true
      && timeout?.naturalCleanReset === true
      && timeout?.leakMarkerCreated === false
      && timeoutCleanupOk,
    `CLI native ${modeId} timeout lacks bounded reset or backend-specific quiescence proof`);

    // The new Git broker must have real native helper/PTY and quiescence
    // evidence in the fresh CLI report; the older WSL/tool-only suite cannot
    // substitute for this proof.
    if (modeId === "wsl") {
      const state = nestedByPrefix.get("CLI-NATIVE-03")?.[0]?.evidence;
      const owner = nestedByPrefix.get("CLI-NATIVE-04")?.[0]?.evidence;
      require(hasWslStateEvidence(state),
        "CLI WSL state case lacks public WSL session, managed completion, owner cleanup, or observation proof");
      require(hasWslOwnerEvidence(owner),
        "CLI WSL owner isolation case lacks public WSL session, cross-owner disposal, natural-exit, or cleanup proof");
    }
    if (modeId === "git-bash") {
      const state = nestedByPrefix.get("CLI-NATIVE-03")?.[0]?.evidence;
      const owner = nestedByPrefix.get("CLI-NATIVE-04")?.[0]?.evidence;
      const nativeState = state?.nativeProcess;
      const nativeOwner = owner?.nativeProcess;
      require(isRecord(nativeState),
      "CLI Git Bash state case lacks native helper/PTY evidence");
      require(nativeState?.helperPid > 0
        && nativeState?.shellPid > 0,
      "CLI Git Bash state case lacks positive helper and shell PIDs");
      require(hasNativeObservationClean(state),
        "CLI Git Bash state case lacks zero observed identities, live host, or clean observation");
      require(owner?.ownerADisposed === true
        && owner?.ownerBStayedAlive === true
        && owner?.naturalExit === true,
      "CLI Git Bash owner isolation case lacks cross-owner/natural-exit proof");
      require(isRecord(nativeOwner)
        && Array.isArray(nativeOwner.afterDispose?.remaining)
        && nativeOwner.afterDispose.remaining.length === 0
        && Array.isArray(nativeOwner.afterDispose?.helperChildren)
        && nativeOwner.afterDispose.helperChildren.length === 0,
      "CLI Git Bash owner isolation case lacks zero helper/shell residual proof");
      require(hasNativeObservationClean(owner),
        "CLI Git Bash owner isolation case lacks zero observed identities, live host, or clean observation");
        require(cancel?.started === true
          && cancel?.aborted === true
          && hasTypedAbortEvidence(cancel)
          && hasNativeQuiescenceEvidence(cancel),
        "CLI Git Bash cancellation case lacks typed ABORTED, real signal, reset, or quiescence proof");
        require(timeout?.ready === true
          && timeout?.timedOut === true
          && timeout?.cleanReset === true
          && timeout?.cwdReset === true
          && timeout?.timeoutOwnerActivityCleared === true
          && timeout?.naturalExit === true
          && timeout?.naturalOwnerActivityCleared === true
          && timeout?.naturalCleanReset === true
          && timeout?.leakMarkerCreated === false
          && hasNativeTimeoutEvidence(timeout),
        "CLI Git Bash timeout case lacks bounded timeout, native handle, reset, or quiescence proof");
      for (const prefix of ["CLI-NATIVE-10", "CLI-NATIVE-11"]) {
        const scenario = nestedByPrefix.get(prefix)?.[0]?.evidence;
        const ledger = scenario?.processLedger;
        const native = scenario?.nativeProcess;
        require(scenario?.observerHostAliveAfterExit === true
          && scenario?.observationError === null
          && ledger?.available === true
          && Array.isArray(ledger?.afterDelayRows)
          && ledger.afterDelayRows.length === 0
          && Array.isArray(ledger?.remaining)
          && ledger.remaining.length === 0
          && isRecord(native?.afterDispose)
          && Array.isArray(native.afterDispose.remaining)
          && native.afterDispose.remaining.length === 0
          && Array.isArray(native.afterDispose.helperDescendants)
          && native.afterDispose.helperDescendants.length === 0,
        `CLI Git Bash ${prefix} lacks zero identity, live host, or clean observation proof`);
      }
    }
  }
  return {
    ok: failures.length === 0,
    failures,
    detail: failures.length === 0
      ? "fresh candidate CLI native WSL/Git mode report matched all required cases and lifecycle identities"
      : failures.slice(0, 12).join("; "),
  };
}
