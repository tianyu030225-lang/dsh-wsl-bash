#!/usr/bin/env node

/**
 * Test-only merge point for the two single-preset owned Desktop driver runs.
 *
 * The driver deliberately runs one allowlisted preset per process.  This
 * helper combines only bounded evidence fields and never reads or copies chat
 * content.  It writes an aggregate adapter/observation-ready pair only when
 * the caller explicitly supplies output paths under 测试/运行产物.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { combineNativeModeEnvelopes } from "./run-owned-gui-session.mjs";
import {
  buildGitNormalCloseGapFromBridge,
  extractGitNormalCloseGapBridge,
} from "./git-normal-close-gap-evidence.mjs";

const ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const OUTPUT_ROOT = resolve(join(ROOT, "测试", "运行产物"));

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function insideOutputRoot(path) {
  const candidate = resolve(path);
  const rel = relative(OUTPUT_ROOT, candidate);
  return rel.length > 0 && rel !== ".."
    && !rel.startsWith(`..${candidate.includes("\\") ? "\\" : "/"}`)
    && !isAbsolute(rel);
}

function readSummary(path) {
  if (!insideOutputRoot(path)) {
    throw new Error("native driver input must be contained in 测试/运行产物");
  }
  const value = JSON.parse(readFileSync(resolve(path), "utf8"));
  if (!isRecord(value)) throw new Error("native driver result must be a JSON object");
  return value;
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertCompatible(summaries, gitQualification = undefined) {
  const [first, second] = summaries;
  for (const [index, summary] of summaries.entries()) {
    const isQualifiedGitFail = index === 1
      && gitQualification?.rawDriverStatus === "FAIL"
      && gitQualification?.gapId === "GIT_NORMAL_CLOSE_BACKEND_PREPOSITIVE_AFTER_CLOSE";
    if (summary.schemaVersion !== 2 || summary.mode !== "real-turn"
      || (summary.status !== "PASS" && !isQualifiedGitFail)
      || summary.fixture !== "gui-human-canonical-20261010-2340"
      || summary.runtime !== "DeepSeek Harness Desktop 0.2.0-rc.2"
      || !Array.isArray(summary.nativeModes) || summary.nativeModes.length !== 1) {
      throw new Error("each input must be one PASS real-turn native driver result");
    }
  }
  const sharedKeys = [
    "tgzSha256",
    "appAsarSha256",
    "cwd",
    "provider",
    "model",
    "preflightProvider",
    "preflightModel",
    "sourceHashes",
    "candidateBinding",
  ];
  for (const key of sharedKeys) {
    if (!sameJson(first[key], second[key])) {
      throw new Error(`native driver ${key} binding differs between modes`);
    }
  }
  if (first.nativeModes[0]?.modeId === second.nativeModes[0]?.modeId) {
    throw new Error("native driver results contain a duplicate mode");
  }
  if (first.nativeModes[0]?.modeId !== "bash-wsl"
    && second.nativeModes[0]?.modeId !== "bash-wsl") {
    throw new Error("aggregate requires the bash-wsl result as the D16 session base");
  }
  if (first.nativeModes[0]?.modeId !== "bash-git-bash"
    && second.nativeModes[0]?.modeId !== "bash-git-bash") {
    throw new Error("aggregate requires the bash-git-bash result");
  }
}

function qualifyGitFailForAggregate(gitSummary, gapOptions) {
  if (gitSummary?.status !== "FAIL") return undefined;
  if (!isRecord(gapOptions)) {
    throw new Error("Git raw FAIL requires an explicit known-gap supplement bridge");
  }
  const bridge = gapOptions.bridge
    ?? (isRecord(gapOptions.bindings) ? gapOptions : extractGitNormalCloseGapBridge(gapOptions));
  const derived = buildGitNormalCloseGapFromBridge(bridge, {
    root: gapOptions.root ?? ROOT,
    runOutputRoot: gapOptions.runOutputRoot ?? OUTPUT_ROOT,
    modeId: "bash-git-bash",
    fixture: gapOptions.fixture ?? gitSummary.fixture,
    runtime: gapOptions.runtime ?? gitSummary.runtime,
    provider: gapOptions.provider ?? gitSummary.provider,
    model: gapOptions.model ?? gitSummary.model,
    candidateSha256: gapOptions.candidateSha256 ?? gitSummary.tgzSha256,
    appAsarSha256: gapOptions.appAsarSha256 ?? gitSummary.appAsarSha256,
    sourceHashes: gapOptions.sourceHashes ?? gitSummary.sourceHashes,
  });
  if (derived.rawDriverStatus !== "FAIL"
    || derived.gapId !== "GIT_NORMAL_CLOSE_BACKEND_PREPOSITIVE_AFTER_CLOSE"
    || derived.attemptId !== gitSummary.attemptId
    || derived.candidateSha256 !== gitSummary.tgzSha256
    || derived.appAsarSha256 !== gitSummary.appAsarSha256
    || !sameJson(derived.sourceHashes, gitSummary.sourceHashes)) {
    throw new Error("computed known-gap supplement does not match the immutable Git raw FAIL");
  }
  const rawProof = derived.qualification.inputArtifacts.rawDriver;
  if (gitSummary.resultArtifact !== undefined
    && rawProof.path.split(/[\\/]/).at(-1) !== gitSummary.resultArtifact) {
    throw new Error("computed known-gap raw proof does not name the Git result artifact");
  }
  const declared = isRecord(bridge) ? bridge : {};
  if (declared.status !== undefined && declared.status !== "QUALIFIED_KNOWN_GAP") {
    throw new Error("known-gap bridge status does not match its recomputed qualification");
  }
  if (declared.rawDriverStatus !== undefined && declared.rawDriverStatus !== "FAIL") {
    throw new Error("known-gap bridge raw status does not preserve FAIL");
  }
  return derived;
}

const ADAPTER_KEYS = [
  "schemaVersion",
  "attemptId",
  "mode",
  "status",
  "fixture",
  "runtime",
  "tgzSha256",
  "candidateBinding",
  "sourceHashes",
  "appAsarSha256",
  "sessionIdSha256",
  "cwd",
  "agentPreset",
  "agentPresetRequested",
  "agentPresetBinding",
  "provider",
  "model",
  "modelRouteObserved",
  "deepSeekModelObserved",
  "preflightModelRouteObserved",
  "preflightProvider",
  "preflightModel",
  "sessionTitle",
  "followReady",
  "followReadyAt",
  "followShapeDiagnostic",
  "toolCalls",
  "toolResults",
  "toolErrors",
  "toolNames",
  "toolCallIdsSha256",
  "toolResultCallIdsSha256",
  "markers",
  "turnStarts",
  "turnEnded",
  "turnEndKind",
  "promptAttempted",
  "promptAccepted",
  "protocolFailure",
  "failureReason",
  "accountCredentialsRead",
  "accountCredentialsPersisted",
  "ephemeralLocalTransportAuthHandled",
  "userConversationRead",
  "cancelAttempted",
  "observationReady",
  "observationChildClosed",
  "cleanup",
  "nativeCallLedger",
];

function boundedAdapter(base, modes, adapterName, readyName) {
  const adapter = Object.fromEntries(ADAPTER_KEYS
    .filter((key) => Object.hasOwn(base, key))
    .map((key) => [key, base[key]]));
  adapter.resultArtifact = adapterName;
  adapter.observationArtifact = readyName;
  adapter.nativeModes = modes;
  adapter.rawArtifacts = {
    adapter: { kind: "aggregate-session-summary", artifact: adapterName },
    observationReady: { kind: "aggregate-observation-ready", artifact: readyName },
  };
  return adapter;
}

function parseArgs(args) {
  const values = {};
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (!key.startsWith("--") || typeof args[index + 1] !== "string") {
      throw new Error("usage: --wsl PATH --git PATH --adapter-out PATH --ready-out PATH");
    }
    values[key.slice(2)] = args[index + 1];
    index += 1;
  }
  for (const key of ["wsl", "git", "adapter-out", "ready-out"]) {
    if (typeof values[key] !== "string" || values[key].length === 0) {
      throw new Error(`missing --${key}`);
    }
  }
  return values;
}

export function combineOwnedNativeDriverSummaries(
  wslSummary,
  gitSummary,
  names,
  options = {},
) {
  const summaries = [wslSummary, gitSummary];
  const gitQualification = qualifyGitFailForAggregate(
    gitSummary,
    options.gitNormalCloseGap,
  );
  assertCompatible(summaries, gitQualification);
  const gitForModes = gitQualification === undefined
    ? gitSummary
    : {
      ...gitSummary,
      nativeModes: [gitQualification.derivedNativeMode],
    };
  const modes = combineNativeModeEnvelopes([wslSummary, gitForModes]);
  const adapterName = names?.adapter ?? "gui-native-modes-aggregate.json";
  const readyName = names?.ready ?? "gui-native-modes-aggregate-observation-ready.json";
  if (adapterName.includes("/") || adapterName.includes("\\")
    || readyName.includes("/") || readyName.includes("\\")) {
    throw new Error("aggregate artifact names must be leaf names");
  }
  const base = wslSummary;
  const adapter = boundedAdapter(base, modes, adapterName, readyName);
  if (gitQualification !== undefined) {
    const bridge = options.gitNormalCloseGap.bridge
      ?? options.gitNormalCloseGap;
    adapter.nativeModeQualification = {
      status: "AGGREGATE_QUALIFIED",
      rawDriverStatus: gitQualification.rawDriverStatus,
      independentSupplementStatus: gitQualification.status,
      gapId: gitQualification.gapId,
      gitNormalCloseGap: {
        status: gitQualification.status,
        rawDriverStatus: gitQualification.rawDriverStatus,
        gapId: gitQualification.gapId,
        bindings: bridge?.bindings,
        inputArtifacts: gitQualification.qualification.inputArtifacts,
      },
    };
  }
  adapter.attemptId = base.attemptId;
  const ready = {
    schemaVersion: 2,
    status: "OBSERVATION_READY",
    mode: "real-turn",
    attemptId: adapter.attemptId,
    resultArtifact: adapterName,
    observationArtifact: readyName,
    nativeModes: modes,
    agentPresetRequested: base.agentPresetRequested,
    agentPresetBinding: base.agentPresetBinding,
    sessionIdSha256: base.sessionIdSha256,
    sessionTitle: base.sessionTitle,
    tgzSha256: base.tgzSha256,
    appAsarSha256: base.appAsarSha256,
    candidateBinding: base.candidateBinding,
    sourceHashes: base.sourceHashes,
    followReady: base.followReady,
    provider: base.provider,
    model: base.model,
    toolCalls: base.toolCalls,
    toolResults: base.toolResults,
    toolErrors: base.toolErrors,
    toolNames: base.toolNames,
    markers: base.markers,
    turnStarts: base.turnStarts,
    turnEnded: base.turnEnded,
    turnEndKind: base.turnEndKind,
  };
  if (gitQualification !== undefined) {
    ready.nativeModeQualification = adapter.nativeModeQualification;
  }
  return { adapter, ready, modes };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const values = parseArgs(process.argv.slice(2));
  const result = combineOwnedNativeDriverSummaries(
    readSummary(values.wsl),
    readSummary(values.git),
    {
      adapter: values["adapter-out"].split(/[\\/]/).at(-1),
      ready: values["ready-out"].split(/[\\/]/).at(-1),
    },
  );
  for (const path of [values["adapter-out"], values["ready-out"]]) {
    if (!insideOutputRoot(path)) {
      throw new Error("aggregate output must be contained in 测试/运行产物");
    }
  }
  writeFileSync(resolve(values["adapter-out"]), `${JSON.stringify(result.adapter, null, 2)}\n`);
  writeFileSync(resolve(values["ready-out"]), `${JSON.stringify(result.ready, null, 2)}\n`);
  console.log(JSON.stringify({
    status: "PASS",
    modes: result.modes.map((mode) => mode.modeId),
    adapter: values["adapter-out"],
    observationReady: values["ready-out"],
  }));
}
