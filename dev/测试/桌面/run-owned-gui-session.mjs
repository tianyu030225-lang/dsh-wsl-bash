#!/usr/bin/env node

/**
 * Run one bounded real Desktop session turn against the owned, already
 * authenticated fixture.
 *
 * This is deliberately a narrow Node adapter for the alpha.2 wire contract. The
 * shipped Client packages are browser bundles registered through
 * window.__ModuleLoader__, so they are not imported as a complete Client here.
 * The HTTP envelope, authenticated root exchange, Remote mux frames, and
 * session schemas below are copied from the installed alpha.2 sources:
 *   dsh-client-connection/lib/client.js
 *   dsh-client-connection/lib/index.js
 *   dsh-api-gateway/lib/client.js
 *   dsh-api-session-controller/lib/typert.remote-client.js
 *
 * The real Session/Agent/tool execution remains owned by the running Desktop
 * Host. This file never simulates events and never treats prompt text as tool
 * output evidence.
 */

import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import {
  closeSync,
  createReadStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  CANONICAL_TGZ_SHA256,
  DEFAULT_TGZ_NAME,
  FIXTURE_ID,
  collectGuiSourceHashes,
  readDesktopRuntimeIdentity,
  resolveGuiCandidateBinding,
} from "./gui-candidate-binding.mjs";

// The launcher owns the Desktop child stdout pipe. A detached wrapper may also
// close this driver's reporting pipe early; neither case may become an
// uncaught EPIPE after the owned child has already been cleaned up.
process.stdout.on("error", () => {});
process.stderr.on("error", () => {});

const REPO_ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const TEST_ROOT = join(REPO_ROOT, "测试");
const RUN_ROOT = join(TEST_ROOT, "运行产物");
const OWNED_ROOT = join(RUN_ROOT, "gui-human-canonical-20261010-2340");
function safeAttemptId(value) {
  const text = String(value ?? "").replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return text.length > 0 ? text.slice(0, 64) : `attempt-${Date.now()}-${randomUUID().slice(0, 8)}`;
}

const ATTEMPT_ID = safeAttemptId(process.env.DSH_GUI_ATTEMPT_ID);
const RESULT_ARTIFACT = `gui-deepseek-real-session-20261011-${ATTEMPT_ID}.json`;
const OBSERVATION_ARTIFACT = `gui-deepseek-real-session-observation-ready-20261011-${ATTEMPT_ID}.json`;
const RESULT_PATH = join(RUN_ROOT, RESULT_ARTIFACT);
const OBSERVATION_RESULT_PATH = join(RUN_ROOT, OBSERVATION_ARTIFACT);
const LEDGER_BASELINE_PATH = join(RUN_ROOT, "gui-owned-linux-ledger-baseline-20261011.json");
const { asarSha256: EXPECTED_ASAR_SHA256, executableSha256: EXPECTED_EXE_SHA256 } = readDesktopRuntimeIdentity();
const EXPECTED_TOOL_NAME = "bash";
const WSL_MARKER_STRATEGY = "read-only Linux ledger of owned bwrap plus bash/script/stty markers: bwrap commandline requires exact fixture workspace and DSH_SHELL/DSH_SESSION_ID/DSH_PTY_SESSION_ID; shell children require exact workspace cwd; no PID is killed, and empty post-ledger is required for PASS";
const MARKERS = ["DSH_GUI_TURN1", "DSH_GUI_TURN2"];
const EXPECTED_OUTPUT_LINES = ["DSH_GUI_TURN1:DSH_GUI_TURN1", "DSH_GUI_TURN2:DSH_GUI_TURN1"];
const EXPECTED_COMMANDS = [
  "export DSH_GUI_STATE=DSH_GUI_TURN1; printf 'DSH_GUI_TURN1:%s\\n' \"$DSH_GUI_STATE\"",
  "printf 'DSH_GUI_TURN2:%s\\n' \"$DSH_GUI_STATE\"",
];
const RPC_TIMEOUT_MS = 15_000;
const CANCEL_TIMEOUT_MS = 5_000;
const TURN_TIMEOUT_MS = 120_000;
const CHILD_START_TIMEOUT_MS = 20_000;
const CHILD_CLOSE_TIMEOUT_MS = 8_000;
const OBSERVATION_WINDOW_MS = 600_000;
const WSL_LEDGER_TIMEOUT_MS = 10_000;
const WSL_DISTRO = process.env.DSH_WSL_DISTRO ?? "Ubuntu";
export const GUI_PRESET_IDS = ["standard", "bash-wsl", "bash-git-bash"];
const PERMISSION_COMMAND_DEFINITION_ID = "@deepseek-ai/dsh-permission-presets";
const PERMISSION_COMMAND_NAME = "permission";
const WORKSPACE_WRITE_PRESET = "workspace-write";
const FULL_ACCESS_PRESET = "danger-full-access";

async function loadWebSocketConstructor() {
  const appData = process.env.APPDATA;
  if (typeof appData !== "string" || !isAbsolute(appData)) {
    throw new Error("APPDATA must be an absolute Windows path for the GUI transport client");
  }
  const cliAnchor = join(appData, "npm", "node_modules", "@deepseek-ai", "dsh", "package.json");
  if (!existsSync(cliAnchor)) throw new Error("matching Windows CLI DSH package is missing");
  const cliManifest = JSON.parse(readFileSync(cliAnchor, "utf8"));
  if (cliManifest.version !== "0.2.2-alpha.2") {
    throw new Error(`Windows CLI DSH ${String(cliManifest.version)} does not match Desktop 0.2.2-alpha.2`);
  }
  const hostRequire = createRequire(cliAnchor);
  const modulePath = hostRequire.resolve("ws");
  return (await import(pathToFileURL(modulePath).href)).default;
}

function selectSessionPreset(value = process.env.DSH_GUI_PRESET) {
  const requested = value === undefined || String(value).trim() === ""
    ? "standard"
    : String(value).trim();
  if (!GUI_PRESET_IDS.includes(requested)) {
    throw new Error(`DSH_GUI_PRESET must be one of: ${GUI_PRESET_IDS.join(", ")}`);
  }
  return requested;
}

function requireFreshNativePreset(candidate, preset = SESSION_PRESET) {
  if (candidate?.freshRequired === true && preset === "standard") {
    throw new Error("fresh GUI candidate requires an explicit bash-wsl or bash-git-bash preset");
  }
  return preset;
}

const SESSION_PRESET = selectSessionPreset();
const NATIVE_MODE_IDS = new Set(["bash-wsl", "bash-git-bash"]);

function gitFullAccessAuthorized(
  value = process.env.DSH_GUI_ALLOW_GIT_FULL_ACCESS,
) {
  return value === "1";
}

function requireGitFullAccessAuthorization(
  preset = SESSION_PRESET,
  value = process.env.DSH_GUI_ALLOW_GIT_FULL_ACCESS,
) {
  if (preset === "bash-git-bash" && !gitFullAccessAuthorized(value)) {
    throw new Error(
      "bash-git-bash requires explicit DSH_GUI_ALLOW_GIT_FULL_ACCESS=1; refusing Desktop launch",
    );
  }
  return preset;
}

function requiredPermissionPreset(preset) {
  if (preset === "bash-git-bash") return FULL_ACCESS_PRESET;
  if (preset === "standard" || preset === "bash-wsl") {
    return WORKSPACE_WRITE_PRESET;
  }
  throw new Error(`unsupported GUI preset for permission setup: ${String(preset)}`);
}

const HARMLESS_PROMPT = [
  "在当前工作区做一次最小的插件运行验证。只使用插件提供的持久 bash 工具，不要使用其他工具；不要读取文件、不要写文件、不要访问网络。",
  "严格只执行两个串行命令：第一条执行 `export DSH_GUI_STATE=DSH_GUI_TURN1; printf 'DSH_GUI_TURN1:%s\\n' \"$DSH_GUI_STATE\"`；第二条执行 `printf 'DSH_GUI_TURN2:%s\\n' \"$DSH_GUI_STATE\"`。",
  "命令完成后停止，并只简短说明实际工具结果。不要根据文字假设工具成功；以工具结果为准。",
].join("\n");

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function inside(parent, child) {
  const p = resolve(parent);
  const c = resolve(child);
  const separator = p.includes("\\") ? "\\" : "/";
  return c === p || c.startsWith(`${p}${separator}`);
}

async function sha256(path) {
  const hash = createHash("sha256");
  await new Promise((resolvePromise, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", resolvePromise);
  });
  return hash.digest("hex");
}

function pathContainmentEvidence(parent, children) {
  try {
    const parentReal = realpathSync(parent);
    const entries = children.map((child) => {
      try {
        const childReal = realpathSync(child);
        return { exists: true, contained: inside(parentReal, childReal) };
      } catch {
        return { exists: false, contained: false };
      }
    });
    return {
      available: true,
      allInside: entries.every((entry) => entry.exists && entry.contained),
      entries,
    };
  } catch {
    return { available: false, allInside: false, entries: [] };
  }
}

function protectedFixtureEvidence(root, expectedReal) {
  try {
    const actualReal = realpathSync(root);
    return {
      available: true,
      preserved: actualReal === expectedReal,
    };
  } catch {
    return { available: false, preserved: false };
  }
}

function stableHash(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function writeObservationReady(summary) {
  const stage = {
    schemaVersion: summary.schemaVersion,
    attemptId: summary.attemptId,
    resultArtifact: summary.resultArtifact,
    mode: summary.mode,
    status: "OBSERVATION_READY",
    fixture: summary.fixture,
    runtime: summary.runtime,
    modeId: summary.modeId,
    agentPresetRequested: summary.agentPresetRequested,
    agentPresetBinding: summary.agentPresetBinding,
    nativeModes: summary.nativeModes,
    tgzSha256: summary.tgzSha256,
    candidateBinding: summary.candidateBinding,
    sourceHashes: summary.sourceHashes,
    rawArtifacts: summary.rawArtifacts,
    nativeCallLedger: summary.nativeCallLedger,
    permission: permissionEnvelopeEvidence(summary.permission),
    appAsarSha256: summary.appAsarSha256,
    sessionIdSha256: summary.sessionIdSha256,
    cwd: summary.cwd,
    agentPreset: summary.agentPreset,
    provider: summary.provider,
    model: summary.model,
    modelRouteObserved: summary.modelRouteObserved,
    deepSeekModelObserved: summary.deepSeekModelObserved,
    preflightModelRouteObserved: summary.preflightModelRouteObserved,
    preflightProvider: summary.preflightProvider,
    preflightModel: summary.preflightModel,
    sessionTitle: summary.sessionTitle,
    followReady: summary.followReady,
    followReadyAt: summary.followReadyAt,
    followShapeDiagnostic: summary.followShapeDiagnostic,
    eventTypes: summary.eventTypes,
    toolCalls: summary.toolCalls,
    toolResults: summary.toolResults,
    toolErrors: summary.toolErrors,
    toolNames: summary.toolNames,
    markers: summary.markers,
    turnStarts: summary.turnStarts,
    turnEnded: summary.turnEnded,
    turnEndKind: summary.turnEndKind,
    accountCredentialsRead: false,
    accountCredentialsPersisted: false,
    ephemeralLocalTransportAuthHandled: summary.ephemeralLocalTransportAuthHandled,
    userConversationRead: false,
    wslMarkerStrategy: WSL_MARKER_STRATEGY,
    wslLedgerBefore: summary.cleanup.wslLedgerBefore,
  };
  writeFileSync(OBSERVATION_RESULT_PATH, `${JSON.stringify(stage, null, 2)}\n`, "utf8");
}

function scrubText(value) {
  return String(value ?? "")
    .replace(/([?&]token=)[^\s&#]+/gi, "$1<redacted>")
    .replace(/(authorization\s*:\s*bearer\s+)[^\s]+/gi, "$1<redacted>")
    .replace(/[\r\n]+/g, " ")
    .slice(-2_000);
}

function scrubValidationValue(value) {
  if (Array.isArray(value)) return value.map(scrubValidationValue).filter(Boolean).join(".");
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value !== "string") return "";
  const text = scrubText(value);
  return /(?:token|cookie|authorization|prompt|content|text|secret|credential)/i.test(text)
    ? "<redacted>"
    : text;
}

function validationDetails(value) {
  const parts = [];
  const allowed = new Set(["key", "path", "expected", "expectedType", "type"]);
  const visit = (node, scope = "") => {
    if (parts.length >= 8 || node === null || node === undefined) return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item, scope);
      return;
    }
    if (!isRecord(node)) return;
    for (const [key, item] of Object.entries(node)) {
      if (parts.length >= 8) break;
      if (allowed.has(key)) {
        const safe = scrubValidationValue(item);
        if (safe && safe !== "<redacted>") parts.push(`${key}=${safe}`);
      } else if (key === "issues" || key === "errors" || key === "validation" || key === "details") {
        visit(item, key);
      }
    }
  };
  visit(value);
  return [...new Set(parts)].join(", ");
}

function formatRpcError(endpoint, error) {
  const code = typeof error?.code === "string" ? error.code : "unknown";
  const details = validationDetails(error?.details);
  return `official RPC ${endpoint} rejected: ${code}${details.length > 0 ? ` (${details})` : " (validation details unavailable)"}`;
}

function formatRemoteError(error) {
  const code = typeof error?.code === "string" ? error.code : "unknown";
  const details = validationDetails(error?.details);
  return `official Remote session/follow rejected: ${code}${details.length > 0 ? ` (${details})` : " (validation details unavailable)"}`;
}

function exactKeys(value, keys) {
  return isRecord(value)
    && Reflect.ownKeys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function permissionCommandEvidence(value) {
  if (!Array.isArray(value)) {
    throw new Error("commands/list did not return an array");
  }
  const matches = value.filter((descriptor) => isRecord(descriptor)
    && descriptor.name === PERMISSION_COMMAND_NAME);
  if (matches.length !== 1) {
    throw new Error("commands/list must expose exactly one permission command");
  }
  const [descriptor] = matches;
  if (descriptor.definitionId !== PERMISSION_COMMAND_DEFINITION_ID) {
    throw new Error("permission command definitionId did not match the official preset");
  }
  if (!isRecord(descriptor.input) || descriptor.input.hint !== "<preset>") {
    throw new Error("permission command input hint did not match the official schema");
  }
  return {
    name: PERMISSION_COMMAND_NAME,
    definitionId: PERMISSION_COMMAND_DEFINITION_ID,
    inputHint: "<preset>",
  };
}

function permissionAckEvidence(value, preset) {
  if (!isRecord(value) || typeof value.commandId !== "string"
    || value.commandId.length === 0 || !isRecord(value.result)) {
    throw new Error("permission command returned an invalid acknowledgement");
  }
  const result = value.result;
  if (result.kind !== "success" || result.text !== `preset ${preset}`) {
    throw new Error("permission command acknowledgement did not confirm the requested preset");
  }
  if (Object.hasOwn(result, "sourceEventSeq")
    && (!Number.isSafeInteger(result.sourceEventSeq) || result.sourceEventSeq < 0)) {
    throw new Error("permission command acknowledgement carried an invalid sourceEventSeq");
  }
  return {
    commandIdSha256: stableHash(value.commandId),
    kind: result.kind,
    text: result.text,
    sourceEventSeq: result.sourceEventSeq ?? null,
  };
}

function permissionProjectionEvidence(value, preset) {
  if (!isRecord(value) || !Number.isSafeInteger(value.asOfSeq) || value.asOfSeq < 0
    || !isRecord(value.values) || !isRecord(value.values.permissions)
    || value.values.permissions.currentValue !== preset) {
    throw new Error("session/projections did not expose the requested permission preset");
  }
  return {
    asOfSeq: value.asOfSeq,
    currentValue: value.values.permissions.currentValue,
  };
}

function permissionTransitionEvidence(value) {
  if (!isRecord(value)) return null;
  const ack = isRecord(value.ack) ? {
    commandIdSha256: typeof value.ack.commandIdSha256 === "string"
      ? value.ack.commandIdSha256
      : null,
    kind: value.ack.kind === "success" ? "success" : null,
    text: typeof value.ack.text === "string" ? value.ack.text : null,
    sourceEventSeq: Number.isSafeInteger(value.ack.sourceEventSeq)
      ? value.ack.sourceEventSeq
      : null,
  } : null;
  const projection = isRecord(value.projection) ? {
    asOfSeq: Number.isSafeInteger(value.projection.asOfSeq)
      ? value.projection.asOfSeq
      : null,
    currentValue: typeof value.projection.currentValue === "string"
      ? value.projection.currentValue
      : null,
  } : null;
  return { ack, projection };
}

function permissionEnvelopeEvidence(value) {
  if (!isRecord(value)) return null;
  const command = isRecord(value.command) ? {
    name: value.command.name === "permission" ? "permission" : null,
    definitionId: value.command.definitionId
      === "@deepseek-ai/dsh-permission-presets"
      ? "@deepseek-ai/dsh-permission-presets"
      : null,
    inputHint: value.command.inputHint === "<preset>" ? "<preset>" : null,
  } : null;
  return {
    mode: typeof value.mode === "string" ? value.mode : null,
    authorizationGranted: typeof value.authorizationGranted === "boolean"
      ? value.authorizationGranted
      : null,
    authorizationInput: value.authorizationInput === "DSH_GUI_ALLOW_GIT_FULL_ACCESS=1"
      ? value.authorizationInput
      : null,
    authorizationSource: value.authorizationSource
      === "explicit-user-test-authorization"
      ? value.authorizationSource
      : null,
    authorizationScope: value.authorizationScope === "owned-gui-session"
      ? value.authorizationScope
      : null,
    command,
    workspaceWrite: permissionTransitionEvidence(value.workspaceWrite),
    fullAccess: permissionTransitionEvidence(value.fullAccess),
    prePromptProjection: isRecord(value.prePromptProjection) ? {
      asOfSeq: Number.isSafeInteger(value.prePromptProjection.asOfSeq)
        ? value.prePromptProjection.asOfSeq
        : null,
      currentValue: typeof value.prePromptProjection.currentValue === "string"
        ? value.prePromptProjection.currentValue
        : null,
    } : null,
  };
}

function cleanupScopePass(cleanup) {
  if (!isRecord(cleanup)) return false;
  const profileContainment = cleanup.profileContainment;
  const profileEntries = profileContainment?.entries;
  return cleanup.strategy === "reused-protected-owned-fixture"
    && cleanup.temporaryRootCreated === false
    && cleanup.temporaryRootRemoved === false
    && cleanup.temporaryRootNotApplicable === true
    && cleanup.profileContained === true
    && profileContainment?.available === true
    && profileContainment.allInside === true
    && Array.isArray(profileEntries)
    && profileEntries.length === 3
    && profileEntries.every((entry) => isRecord(entry)
      && entry.exists === true && entry.contained === true)
    && cleanup.protectedFixtureReused === true
    && cleanup.protectedFixturePreserved === true
    && cleanup.canonicalTgzPreserved === true
    && cleanup.canonicalTgzSha256 === CANONICAL_TGZ_SHA256
    && cleanup.canonicalTgzBeforeSha256 === CANONICAL_TGZ_SHA256
    && cleanup.canonicalTgzAfterSha256 === CANONICAL_TGZ_SHA256;
}

function sameJson(left, right) {
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

function textBlocks(value, output = []) {
  if (Array.isArray(value)) {
    for (const item of value) textBlocks(item, output);
  } else if (isRecord(value)) {
    if (value.type === "text" && typeof value.text === "string") output.push(value.text);
    else for (const item of Object.values(value)) textBlocks(item, output);
  }
  return output;
}

function markerLine(text, expectedLine) {
  if (typeof text !== "string" || typeof expectedLine !== "string") return false;
  const escaped = expectedLine.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|\\r?\\n)${escaped}(?:\\r?\\n|$)`).test(text);
}

/**
 * The alpha.2 tool/result event carries the rendered tool message only.  The
 * persistent Bash plugin publishes its exit status in that official rendered
 * text; alpha.2 does not add an exitCode/rawFrame field to tool/result data.
 */
function parseRenderedExitCode(text) {
  if (typeof text !== "string") return undefined;
  const matches = [...text.matchAll(
    /(?:^|\r?\n)\[Command finished with exit code (\d+)\](?=\r?\n|$)/g,
  )];
  if (matches.length !== 1) return undefined;
  const value = Number(matches[0][1]);
  return Number.isSafeInteger(value) && value >= 0 && value <= 255
    ? value
    : undefined;
}

function nativeModeEnvelope(summary) {
  const modeId = summary?.modeId;
  if (!NATIVE_MODE_IDS.has(modeId)) return [];
  const cleanup = summary.cleanup ?? {};
  const binding = summary.agentPresetBinding ?? {};
  const calls = Array.isArray(summary.nativeCallLedger)
    ? summary.nativeCallLedger
    : [];
  const envelope = {
    modeId,
    sessionIdSha256: summary.sessionIdSha256 ?? null,
    agentPresetBinding: {
      requested: binding.requested ?? null,
      sessionCreate: binding.sessionCreate ?? null,
      sessionHeader: binding.sessionHeader ?? null,
      sessionHeaderIdSha256: binding.sessionHeaderIdSha256 ?? null,
      exact: binding.exact === true,
    },
    calls,
    callOrder: calls.map((call) => ({
      sequence: call?.sequence ?? null,
      callIdSha256: call?.callIdSha256 ?? null,
      resultCallIdSha256: call?.resultCallIdSha256 ?? null,
    })),
    turnLedger: {
      turnStarts: summary.turnStarts,
      turnEnded: summary.turnEnded,
      turnEndKind: summary.turnEndKind,
      toolCalls: summary.toolCalls,
      toolResults: summary.toolResults,
      toolErrors: summary.toolErrors,
      markers: summary.markers,
    },
    rawArtifacts: summary.rawArtifacts ?? null,
    permission: permissionEnvelopeEvidence(summary.permission),
    backendCleanup: cleanup.backendCleanup ?? null,
    normalExit: {
      closeObserved: cleanup.childClosed === true,
      reaped: cleanup.reaped === true,
      aliveAfter: cleanup.lineageAfter?.available === true
        ? cleanup.lineageAfter.rootPresent === true
        : null,
    },
    cleanup: cleanup,
  };
  return [envelope];
}

/**
 * Combine the two independent real-turn driver outputs.  Each driver process
 * is intentionally single-preset; this pure helper is the only merge point
 * before a D16 aggregate is assembled.  It copies no chat content and refuses
 * duplicate, missing, or non-native modes.
 */
export function combineNativeModeEnvelopes(summaries) {
  const expected = ["bash-wsl", "bash-git-bash"];
  if (!Array.isArray(summaries) || summaries.length !== expected.length) {
    throw new Error("exactly one result from each native preset is required");
  }
  const entries = summaries.flatMap((summary) => {
    if (!isRecord(summary) || !Array.isArray(summary.nativeModes)
      || summary.nativeModes.length !== 1) {
      throw new Error("each native driver result must contain exactly one native mode");
    }
    return summary.nativeModes;
  });
  const byId = new Map(entries.map((entry) => [entry?.modeId, entry]));
  if (byId.size !== expected.length || expected.some((id) => !byId.has(id))) {
    throw new Error("native driver results must contain one bash-wsl and one bash-git-bash mode");
  }
  return expected.map((id) => byId.get(id));
}

function backendCleanupEvidence(summary) {
  const cleanup = summary.cleanup ?? {};
  if (summary.modeId === "bash-git-bash") {
    const before = cleanup.lineageBeforeTerminate;
    const after = cleanup.lineageAfter;
    const errors = [];
    if (before?.available !== true || before.verified !== true
      || !Array.isArray(before.identities) || before.identities.length === 0) {
      errors.push("owned Windows CIM prepositive lineage unavailable");
    }
    if (after?.available !== true || after.rootPresent !== false
      || !Array.isArray(after.identities) || after.identities.length !== 0
      || after.remainingIdentityCount !== 0) {
      errors.push("owned Windows CIM postempty lineage unavailable");
    }
    return {
      kind: "native-process-tree",
      source: "owned Windows CIM Win32_Process CreationDate lineage",
      observed: errors.length === 0,
      prepositive: before ?? null,
      postempty: after ?? null,
      // These are the exact CIM identities observed before termination.  They
      // are not a fabricated WSL ledger or a host-alive claim.
      creationIdentities: before?.identities ?? [],
      observationErrors: errors,
    };
  }
  const before = cleanup.wslLedgerBefore;
  const after = cleanup.wslLedgerAfter;
  const errors = [];
  if (before?.available !== true || before.markerCount <= 0) {
    errors.push("owned WSL prepositive ledger unavailable");
  }
  if (after?.available !== true || after.markerCount !== 0) {
    errors.push("owned WSL postempty ledger unavailable");
  }
  return {
    kind: "wsl-public-session",
    source: WSL_MARKER_STRATEGY,
    observed: errors.length === 0,
    prepositive: before ?? null,
    postempty: after ?? null,
    creationIdentities: [],
    observationErrors: errors,
  };
}

function rawArtifactManifest(summary) {
  return {
    adapter: { kind: "session-summary", artifact: summary.resultArtifact },
    observationReady: { kind: "observation-ready", artifact: summary.observationArtifact },
  };
}

function parseServerFrame(raw) {
  const text = typeof raw === "string"
    ? raw
    : Buffer.isBuffer(raw)
      ? raw.toString("utf8")
      : raw instanceof ArrayBuffer
        ? Buffer.from(raw).toString("utf8")
        : String(raw);
  let value;
  try {
    value = JSON.parse(text);
  } catch (cause) {
    throw new Error("official Remote stream frame is not JSON", { cause });
  }
  if (!isRecord(value) || typeof value.type !== "string" || typeof value.streamId !== "string" || value.streamId.length === 0) {
    throw new Error("official Remote stream frame has an invalid envelope");
  }
  if (value.type === "item" && exactKeys(value, ["type", "streamId", "value"])) return value;
  if (value.type === "end" && exactKeys(value, ["type", "streamId"])) return value;
  if (value.type === "error" && exactKeys(value, ["type", "streamId", "error"]) && isRecord(value.error)
    && exactKeys(value.error, ["code", "message", "details"])
    && typeof value.error.code === "string"
    && typeof value.error.message === "string"
    && isRecord(value.error.details)) return value;
  throw new Error("official Remote stream frame violates alpha.2 schema");
}

class AsyncQueue {
  values = [];
  waiters = [];
  ended = false;
  error;

  push(value) {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter !== undefined) {
      waiter.cleanup();
      waiter.resolve({ value, done: false });
      return;
    }
    this.values.push(value);
  }

  end(error = undefined) {
    if (this.ended) return;
    this.ended = true;
    this.error = error;
    for (const waiter of this.waiters.splice(0)) {
      waiter.cleanup();
      if (error !== undefined) waiter.reject(error);
      else waiter.resolve({ value: undefined, done: true });
    }
  }

  next(signal = undefined) {
    if (signal?.aborted) {
      return Promise.reject(signal.reason ?? new Error("Remote stream wait aborted"));
    }
    if (this.values.length > 0) return Promise.resolve({ value: this.values.shift(), done: false });
    if (this.ended) {
      if (this.error !== undefined) return Promise.reject(this.error);
      return Promise.resolve({ value: undefined, done: true });
    }
    return new Promise((resolvePromise, rejectPromise) => {
      const waiter = {
        resolve: resolvePromise,
        reject: rejectPromise,
        onAbort: undefined,
        cleanup: () => {
          if (waiter.onAbort !== undefined) signal?.removeEventListener("abort", waiter.onAbort);
        },
      };
      if (signal !== undefined) {
        waiter.onAbort = () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          waiter.cleanup();
          rejectPromise(signal.reason ?? new Error("Remote stream wait aborted"));
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
        if (signal.aborted) {
          waiter.onAbort();
          return;
        }
      }
      this.waiters.push(waiter);
    });
  }
}

function abortableSignal(parent, timeoutMs, timeoutMessage) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(timeoutMessage)), timeoutMs);
  const onParentAbort = () => controller.abort(parent.reason);
  if (parent?.aborted) controller.abort(parent.reason ?? new Error("Remote operation aborted"));
  else parent?.addEventListener("abort", onParentAbort, { once: true });
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      parent?.removeEventListener("abort", onParentAbort);
    },
  };
}

async function openWebSocket(WebSocketCtor, url, cookie, origin) {
  const socket = new WebSocketCtor(url, { headers: { Cookie: cookie, Origin: origin } });
  await new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      cleanup();
      try { socket.terminate?.(); } catch {}
      rejectPromise(new Error("official Remote WebSocket open timed out"));
    }, RPC_TIMEOUT_MS);
    const opened = () => {
      cleanup();
      resolvePromise();
    };
    const failed = (error) => {
      cleanup();
      rejectPromise(error instanceof Error ? error : new Error("Remote WebSocket failed to open"));
    };
    const closed = () => failed(new Error("official Remote WebSocket closed before open"));
    const cleanup = () => {
      clearTimeout(timer);
      socket.removeListener("open", opened);
      socket.removeListener("error", failed);
      socket.removeListener("close", closed);
    };
    socket.once("open", opened);
    socket.once("error", failed);
    socket.once("close", closed);
  });
  return socket;
}

function waitForChildClose(child, timeoutMs) {
  if (child === undefined || child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolvePromise) => {
    let settled = false;
    const onClose = () => finish(true);
    const onError = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    const finish = (closed) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener("close", onClose);
      child.removeListener("error", onError);
      resolvePromise(closed);
    };
    child.once("close", onClose);
    child.once("error", onError);
  });
}

function processIdentity(value) {
  if (!isRecord(value) || !Number.isInteger(value.pid) || typeof value.creation !== "string" || value.creation.length === 0) {
    return null;
  }
  return { pid: value.pid, creation: value.creation };
}

function linuxProcessIdentity(value) {
  if (!isRecord(value) || !Number.isSafeInteger(value.pid) || !Number.isSafeInteger(value.ppid)
    || !Number.isSafeInteger(value.starttime)) {
    return null;
  }
  return { pid: value.pid, ppid: value.ppid, starttime: value.starttime };
}

function sameProcessIdentity(left, right) {
  return left?.pid === right?.pid && left?.creation === right?.creation;
}

async function queryOwnedLineage(pid, markers, expectedIdentities = []) {
  const unavailable = {
    available: false,
    verified: false,
    rootPresent: false,
    rootCreation: null,
    rootIdentity: null,
    identities: [],
    remainingIdentityCount: null,
    markerProcessCount: null,
  };
  const safeMarkers = Array.isArray(markers)
    ? [...new Set(markers.filter((value) => typeof value === "string" && value.length > 0))]
    : [];
  const safeExpected = Array.isArray(expectedIdentities)
    ? expectedIdentities.map(processIdentity).filter((value) => value !== null)
    : [];
  if (process.platform !== "win32" || !Number.isInteger(pid) || safeMarkers.length === 0) {
    return unavailable;
  }
  const script = [
    "$ErrorActionPreference='Stop'",
    "$target=[int]$env:DSH_OWNED_PID",
    "$markerValue=ConvertFrom-Json -InputObject $env:DSH_OWNED_MARKERS",
    "$markers=@()",
    "foreach($markerItem in @($markerValue)){if($markerItem -is [System.Array]){foreach($nestedMarker in $markerItem){$markers+=[string]$nestedMarker}}else{$markers+=[string]$markerItem}}",
    "$expectedValue=$null",
    "if(-not [string]::IsNullOrWhiteSpace($env:DSH_EXPECTED_IDENTITIES)){$expectedValue=ConvertFrom-Json -InputObject $env:DSH_EXPECTED_IDENTITIES}",
    "$expected=@()",
    "foreach($expectedItem in @($expectedValue)){if($expectedItem -is [System.Array]){foreach($nestedExpected in $expectedItem){$expected+=$nestedExpected}}elseif($null -ne $expectedItem){$expected+=$expectedItem}}",
    "$rows=@(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CreationDate,CommandLine,ExecutablePath)",
    "$root=$rows | Where-Object { [int]$_.ProcessId -eq $target } | Select-Object -First 1",
    "$markerProcessCount=0",
    "foreach($row in $rows){$identityText=(([string]$row.CommandLine)+' '+([string]$row.ExecutablePath));$matches=$false;foreach($marker in $markers){if(([string]$marker).Length -gt 0 -and $identityText.IndexOf([string]$marker,[System.StringComparison]::OrdinalIgnoreCase) -ge 0){$matches=$true;break}};if($matches){$markerProcessCount++}}",
    "$ids=@()",
    "if($null -ne $root){$ids=@($target);$changed=$true;while($changed){$changed=$false;foreach($row in $rows){$id=[int]$row.ProcessId;$parent=[int]$row.ParentProcessId;if(($ids -contains $parent) -and -not ($ids -contains $id)){$ids+=$id;$changed=$true}}}}",
    "$identities=@($rows | Where-Object { $ids -contains [int]$_.ProcessId } | ForEach-Object {[pscustomobject]@{pid=[int]$_.ProcessId;creation=[string]$_.CreationDate}})",
    "$rootIdentity=$null",
    "if($null -ne $root){$rootIdentity=[pscustomobject]@{pid=[int]$root.ProcessId;creation=[string]$root.CreationDate}}",
    "$remainingIdentityCount=0",
    "foreach($identity in $expected){$expectedPid=[int]$identity.pid;$expectedCreation=[string]$identity.creation;$found=$rows | Where-Object { [int]$_.ProcessId -eq $expectedPid -and [string]$_.CreationDate -eq $expectedCreation } | Select-Object -First 1;if($null -ne $found){$remainingIdentityCount++}}",
    "$rootCommand=if($null -eq $root){''}else{[string]$root.CommandLine}",
    "$rootCreation=if($null -eq $root){$null}else{[string]$root.CreationDate}",
    "$rootMarker=[string]$markers[0]",
    "$verified=$null -ne $root -and -not [string]::IsNullOrWhiteSpace([string]$root.CreationDate) -and $rootCommand.IndexOf($rootMarker,[System.StringComparison]::OrdinalIgnoreCase) -ge 0",
    "[pscustomobject]@{available=$true;verified=$verified;rootPresent=($null -ne $root);rootCreation=$rootCreation;rootIdentity=$rootIdentity;identities=$identities;remainingIdentityCount=$remainingIdentityCount;markerProcessCount=$markerProcessCount}|ConvertTo-Json -Compress -Depth 6",
  ].join(";");
  return await new Promise((resolvePromise) => {
    let output = "";
    let settled = false;
    const processHandle = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      env: {
        ...process.env,
        DSH_OWNED_PID: String(pid),
        DSH_OWNED_MARKERS: JSON.stringify(safeMarkers),
        DSH_EXPECTED_IDENTITIES: JSON.stringify(safeExpected),
      },
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
      shell: false,
    });
    const timer = setTimeout(() => finish(unavailable), RPC_TIMEOUT_MS);
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { processHandle.kill(); } catch {}
      resolvePromise(value);
    };
    processHandle.stdout?.setEncoding("utf8");
    processHandle.stdout?.on("data", (chunk) => {
      output = `${output}${chunk}`.slice(-16 * 1024);
    });
    processHandle.once("error", () => finish(unavailable));
    processHandle.once("close", (code) => {
      if (code !== 0) {
        finish(unavailable);
        return;
      }
      const line = output.trim().split(/\r?\n/).filter(Boolean).at(-1);
      if (line === undefined) {
        finish(unavailable);
        return;
      }
      try {
        const value = JSON.parse(line);
        if (!isRecord(value) || value.available !== true || typeof value.verified !== "boolean"
          || typeof value.rootPresent !== "boolean" || !Number.isInteger(value.markerProcessCount)
          || !Number.isInteger(value.remainingIdentityCount)) {
          finish(unavailable);
          return;
        }
        const identitiesRaw = Array.isArray(value.identities)
          ? value.identities
          : value.identities === null || value.identities === undefined ? [] : [value.identities];
        const identities = identitiesRaw.map(processIdentity).filter((identity) => identity !== null);
        if (identities.length !== identitiesRaw.length) {
          finish(unavailable);
          return;
        }
        finish({
          available: true,
          verified: value.verified,
          rootPresent: value.rootPresent,
          rootCreation: typeof value.rootCreation === "string" ? value.rootCreation : null,
          rootIdentity: processIdentity(value.rootIdentity),
          identities,
          remainingIdentityCount: value.remainingIdentityCount,
          markerProcessCount: value.markerProcessCount,
        });
      } catch {
        finish(unavailable);
      }
    });
  });
}

async function captureInitialLineage(pid, markers) {
  let lineage = await queryOwnedLineage(pid, markers);
  for (let attempt = 0; attempt < 20 && (!lineage.available || !lineage.rootPresent
    || !lineage.verified || lineage.identities.length === 0); attempt += 1) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    lineage = await queryOwnedLineage(pid, markers);
  }
  return lineage;
}

async function terminateOwnedChild(child, markers, evidence) {
  if (child === undefined) {
    evidence.reaped = false;
    return false;
  }
  const live = child.exitCode === null && child.signalCode === null && Number.isInteger(child.pid);
  evidence.terminationAttempted = live;
  const processMarkers = Array.isArray(markers) ? markers : [markers];
  const retainedPreclose = evidence.lineageBeforeTerminate;
  const retainedPrecloseValid = !live
    && retainedPreclose?.available === true
    && retainedPreclose.verified === true
    && Array.isArray(retainedPreclose.identities)
    && retainedPreclose.identities.length > 0;
  if (!retainedPrecloseValid) {
    evidence.lineageBeforeTerminate = await queryOwnedLineage(child.pid, processMarkers);
  }
  const expectedAfterIdentities = [
    ...(evidence.lineageInitial?.identities ?? []),
    ...(evidence.lineageBeforeTerminate?.identities ?? []),
  ];
  let killAuthorizedByLineage = false;
  if (live && process.platform === "win32" && evidence.lineageBeforeTerminate.available
    && evidence.lineageBeforeTerminate.verified) {
    evidence.lineageBeforeConfirm = await queryOwnedLineage(
      child.pid,
      processMarkers,
      evidence.lineageBeforeTerminate.identities,
    );
    for (const identity of evidence.lineageBeforeConfirm.identities) {
      if (!expectedAfterIdentities.some((existing) => sameProcessIdentity(existing, identity))) {
        expectedAfterIdentities.push(identity);
      }
    }
    killAuthorizedByLineage = sameProcessIdentity(
      evidence.lineageBeforeTerminate.rootIdentity,
      evidence.lineageBeforeConfirm.rootIdentity,
    ) && evidence.lineageBeforeTerminate.rootCreation === evidence.lineageBeforeConfirm.rootCreation;
  }
  evidence.killAuthorizedByLineage = killAuthorizedByLineage;
  if (live) {
    if (process.platform === "win32" && killAuthorizedByLineage) {
      const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
        shell: false,
      });
      await Promise.race([
        new Promise((resolvePromise) => {
          killer.once("close", resolvePromise);
          killer.once("error", resolvePromise);
        }),
        new Promise((resolvePromise) => setTimeout(resolvePromise, 3_000)),
      ]);
    } else {
      // The spawned root is ours, but an unverified tree must not receive a broad taskkill.
      try { child.kill(); } catch {}
    }
  }
  const closed = await waitForChildClose(child, CHILD_CLOSE_TIMEOUT_MS);
  if (!closed) {
    try { child.kill(); } catch {}
    await waitForChildClose(child, 2_000);
  }
  evidence.lineageAfter = await queryOwnedLineage(child.pid, processMarkers, expectedAfterIdentities);
  for (let attempt = 0; attempt < 10 && (!evidence.lineageAfter.available
    || evidence.lineageAfter.rootPresent
    || evidence.lineageAfter.remainingIdentityCount !== 0
    || evidence.lineageAfter.markerProcessCount !== 0); attempt += 1) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 300));
    evidence.lineageAfter = await queryOwnedLineage(child.pid, processMarkers, expectedAfterIdentities);
  }
  evidence.reaped = evidence.lineageAfter.available
    && !evidence.lineageAfter.rootPresent
    && evidence.lineageAfter.remainingIdentityCount === 0
    && evidence.lineageAfter.markerProcessCount === 0;
  return child.exitCode !== null || child.signalCode !== null ? evidence.reaped : false;
}

async function observeOwnedChild(child, timeoutMs) {
  const startedAt = Date.now();
  const closed = await waitForChildClose(child, timeoutMs);
  return { closed, elapsedMs: Date.now() - startedAt };
}

function windowsPathToWslPath(value) {
  if (typeof value !== "string") return undefined;
  const normalized = value.replaceAll("\\", "/");
  const match = /^([A-Za-z]):\/(.*)$/.exec(normalized);
  if (match === null) return undefined;
  return `/mnt/${match[1].toLowerCase()}/${match[2]}`;
}

async function queryOwnedWslLedger(workspace) {
  const unavailable = { available: false, markerCount: null, identities: [] };
  const workspaceWsl = windowsPathToWslPath(workspace);
  if (process.platform !== "win32" || workspaceWsl === undefined) return unavailable;
  const wslExecutable = typeof process.env.SystemRoot === "string"
    ? join(process.env.SystemRoot, "System32", "wsl.exe")
    : "wsl.exe";
  const script = [
    "workspace=$1",
    "records=",
    "count=0",
    "for proc in /proc/[0-9]*; do",
    "  [ -r \"$proc/cmdline\" ] || continue",
    "  comm=$(cat \"$proc/comm\" 2>/dev/null) || continue",
    "  if [ \"$comm\" = bwrap ]; then",
    "    cmdline=$(tr '\\0' ' ' < \"$proc/cmdline\" 2>/dev/null) || continue",
    "    case \"$cmdline\" in *\"$workspace\"*) ;; *) continue ;; esac",
    "    case \"$cmdline\" in *DSH_SHELL*) ;; *) continue ;; esac",
    "    case \"$cmdline\" in *DSH_SESSION_ID*) ;; *) continue ;; esac",
    "    case \"$cmdline\" in *DSH_PTY_SESSION_ID*) ;; *) continue ;; esac",
    "  else",
    "    case \"$comm\" in bash|script|stty) ;; *) continue ;; esac",
    "    cwd=$(readlink \"$proc/cwd\" 2>/dev/null) || continue",
    "    case \"$cwd\" in \"$workspace\"|\"$workspace\"/*) ;; *) continue ;; esac",
    "  fi",
    "  identity=$(awk '{print $1\"|\"$4\"|\"$22}' \"$proc/stat\" 2>/dev/null) || continue",
    "  IFS='|' read -r pid ppid starttime <<EOF",
    "$identity",
    "EOF",
    "  case \"$pid:$ppid:$starttime\" in *[!0-9:]*) continue ;; esac",
    "  [ -n \"$pid\" ] && [ -n \"$starttime\" ] || continue",
    "  entry=\"{\\\"pid\\\":$pid,\\\"ppid\\\":$ppid,\\\"starttime\\\":$starttime}\"",
    "  if [ $count -gt 0 ]; then records=\"$records,$entry\"; else records=\"$entry\"; fi",
    "  count=$((count+1))",
    "done",
    "printf '{\\\"available\\\":true,\\\"markerCount\\\":%s,\\\"identities\\\":[%s]}\\n' \"$count\" \"$records\"",
  ].join("\n");
  return await new Promise((resolvePromise) => {
    let output = "";
    let settled = false;
    const processHandle = spawn(wslExecutable, [
      "-d", WSL_DISTRO, "--exec", "/bin/bash", "-lc", script,
      "owned-linux-ledger", workspaceWsl,
    ], {
      env: { ...process.env },
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const timer = setTimeout(() => finish(unavailable), WSL_LEDGER_TIMEOUT_MS);
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { processHandle.kill(); } catch {}
      resolvePromise(value);
    };
    processHandle.stdout?.setEncoding("utf8");
    processHandle.stdout?.on("data", (chunk) => {
      output = `${output}${chunk}`.slice(-16 * 1024);
    });
    processHandle.once("error", () => finish(unavailable));
    processHandle.once("close", (code) => {
      if (code !== 0) {
        finish(unavailable);
        return;
      }
      const line = output.trim().split(/\r?\n/).filter(Boolean).at(-1);
      if (line === undefined) {
        finish(unavailable);
        return;
      }
      try {
        const value = JSON.parse(line);
        const identitiesRaw = Array.isArray(value.identities) ? value.identities : [];
        const identities = identitiesRaw.map(linuxProcessIdentity).filter((identity) => identity !== null);
        if (!isRecord(value) || value.available !== true || !Number.isInteger(value.markerCount)
          || identities.length !== identitiesRaw.length) {
          finish(unavailable);
          return;
        }
        finish({ available: true, markerCount: value.markerCount, identities });
      } catch {
        finish(unavailable);
      }
    });
  });
}

function toolCommand(data) {
  if (typeof data?.arguments !== "string") return undefined;
  try {
    const args = JSON.parse(data.arguments);
    return isRecord(args) && typeof args.command === "string" ? args.command : undefined;
  } catch {
    return undefined;
  }
}

function validCommand(command, index) {
  if (typeof command !== "string" || !Number.isInteger(index) || index < 0 || index >= EXPECTED_COMMANDS.length) {
    return false;
  }
  const normalize = (value) => value
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .trim();
  return normalize(command) === normalize(EXPECTED_COMMANDS[index]);
}

function failState(state, message) {
  if (state.failure === undefined) state.failure = new Error(message);
  state.summary.protocolFailure = true;
  state.summary.failureReason = scrubText(state.failure.message);
  state.rejectFollowReady?.(state.failure);
  state.abort?.(state.failure);
}

function summarizeEvent(event, state) {
  const { summary } = state;
  if (!isRecord(event) || typeof event.type !== "string" || !Number.isSafeInteger(event.seq)
    || typeof event.time !== "number" || !Object.hasOwn(event, "data")) {
    failState(state, "session/follow returned an invalid SessionWireEvent");
    return;
  }
  if (state.lastSeq !== undefined && event.seq <= state.lastSeq) {
    failState(state, `session/follow event sequence is repeated or out of order: ${event.seq}`);
    return;
  }
  state.lastSeq = event.seq;
  summary.eventTypes[event.type] = (summary.eventTypes[event.type] ?? 0) + 1;
  if (event.type === "system/message") {
    if (textBlocks(event.data).some((text) => text.includes("dsh-plugin-bash-wsl:usage"))) {
      summary.systemPromptUsageObserved = true;
    }
  }
  if (event.type === "request/header") {
    const config = event.data?.header?.config;
    const provider = config?.provider;
    const model = config?.model;
    if (typeof provider !== "string" || typeof model !== "string" || provider.length === 0 || model.length === 0) {
      failState(state, "request/header omitted the authoritative provider/model route");
      return;
    }
    if (!summary.preflightModelRouteObserved
      || provider !== summary.preflightProvider
      || model !== summary.preflightModel) {
      failState(state, "request/header route does not match the preflight-selected provider/model");
      return;
    }
    summary.provider = provider;
    summary.model = model;
    summary.modelRouteObserved = true;
    summary.deepSeekModelObserved = true;
  }
  if (event.type === "turn/start") {
    if (state.turnId !== undefined && !state.turnEnded) {
      failState(state, "a second turn/start arrived before the owned turn ended");
      return;
    }
    if (!isRecord(event.data) || event.data.turn === undefined) {
      failState(state, "turn/start has no turn identity");
      return;
    }
    state.turnId = event.data.turn;
    summary.turnStarts += 1;
    return;
  }
  if (event.type === "tool/call") {
    const data = event.data;
    const name = data?.name;
    const callId = data?.callId;
    const index = summary.toolCalls;
    if (state.turnId === undefined) {
      failState(state, "tool/call arrived before turn/start");
      return;
    }
    if (!isRecord(data)
      || typeof data.turn !== "number"
      || !Number.isFinite(data.turn)
      || !sameJson(data.turn, state.turnId)
      || typeof data.step !== "number"
      || !Number.isFinite(data.step)
      || typeof name !== "string"
      || typeof callId !== "string"
      || callId.length === 0
      || typeof data.arguments !== "string") {
      failState(state, "tool/call lacks the alpha.2 turn/step/callId/name/arguments identity");
      return;
    }
    if (name !== EXPECTED_TOOL_NAME) {
      failState(state, `unexpected tool identity: ${name}`);
      return;
    }
    const seenCallIds = state.seenCallIds ??= new Set();
    if (seenCallIds.has(callId)) {
      failState(state, "tool/call reuses a previous callId");
      return;
    }
    if (summary.toolCalls >= MARKERS.length) {
      failState(state, "tool budget exceeded: more than two tool/call events");
      return;
    }
    if (state.pending.size !== 0) {
      failState(state, "a second tool/call arrived before the previous tool/result");
      return;
    }
    if (!validCommand(toolCommand(data), index)) {
      failState(state, `tool/call ${index + 1} command does not match the owned two-command fixture`);
      return;
    }
    seenCallIds.add(callId);
    const ledgerEntry = {
      sequence: index + 1,
      toolName: name,
      callIdSha256: stableHash(callId),
      resultCallIdSha256: null,
      accepted: true,
      completed: false,
      parsedExitCode: null,
      isError: false,
      timedOut: false,
      aborted: false,
      outputMarker: EXPECTED_OUTPUT_LINES[index],
    };
    summary.nativeCallLedger ??= [];
    summary.nativeCallLedger.push(ledgerEntry);
    state.pending.set(callId, {
      index,
      turn: data.turn,
      step: data.step,
      outputLine: EXPECTED_OUTPUT_LINES[index],
      ledgerEntry,
    });
    summary.toolCalls += 1;
    summary.toolNames.push(name);
    summary.toolCallIdsSha256.push(stableHash(callId));
    return;
  }
  if (event.type === "tool/result") {
    const data = event.data;
    const message = data?.message;
    const source = message?.source;
    const callId = source?.callId;
    const expected = typeof callId === "string" ? state.pending.get(callId) : undefined;
    if (!isRecord(data) || !isRecord(message) || message.role !== "tool" || !isRecord(source)
      || source.kind !== "tool" || typeof callId !== "string" || expected === undefined) {
      failState(state, "tool/result is not correlated to a preceding tool/call");
      return;
    }
    if (message.toolCallId !== undefined && message.toolCallId !== callId) {
      failState(state, "tool/result message.toolCallId disagrees with source.callId");
      return;
    }
    if (!sameJson(data.turn, expected.turn) || !sameJson(data.step, expected.step)) {
      failState(state, "tool/result turn/step does not match its tool/call");
      return;
    }
    const output = textBlocks(message.content).join("\n");
    if (message.isError === true || data.error !== undefined) {
      summary.toolErrors += 1;
      expected.ledgerEntry.isError = true;
      failState(state, `tool/result ${expected.index + 1} reported an error`);
      return;
    }
    if (!markerLine(output, expected.outputLine)) {
      failState(state, `tool/result ${expected.index + 1} has no exact stdout marker`);
      return;
    }
    const otherOutputLine = EXPECTED_OUTPUT_LINES.find((line) => line !== expected.outputLine && markerLine(output, line));
    if (otherOutputLine !== undefined) {
      failState(state, `tool/result ${expected.index + 1} contains another command marker`);
      return;
    }
    const parsedExitCode = parseRenderedExitCode(output);
    if (parsedExitCode === undefined) {
      failState(state, `tool/result ${expected.index + 1} has no official rendered exit code`);
      return;
    }
    state.pending.delete(callId);
    expected.ledgerEntry.completed = true;
    expected.ledgerEntry.parsedExitCode = parsedExitCode;
    expected.ledgerEntry.resultCallIdSha256 = stableHash(callId);
    summary.toolResults += 1;
    summary.markers[MARKERS[expected.index]] = true;
    summary.toolResultCallIdsSha256.push(stableHash(callId));
    return;
  }
  if (event.type === "turn/end") {
    if (state.turnId === undefined || !isRecord(event.data) || !sameJson(event.data.turn, state.turnId)) {
      failState(state, "turn/end does not identify the observed turn/start");
      return;
    }
    const reason = event.data.reason;
    if (!isRecord(reason) || reason.kind !== "completed") {
      failState(state, `owned turn ended with non-completed reason: ${scrubText(reason?.kind)}`);
      return;
    }
    if (state.pending.size !== 0 || summary.toolResults !== MARKERS.length) {
      failState(state, "turn/end arrived before both correlated tool results");
      return;
    }
    state.turnEnded = true;
    summary.turnEnded = true;
    summary.turnEndKind = reason.kind;
  }
}

function parseRpcResponse(value, rpcId, endpoint) {
  if (!isRecord(value) || value.type !== "server-response" || value.rpcId !== rpcId || !isRecord(value.result)) {
    throw new Error(`official RPC ${endpoint} returned an invalid server-response envelope`);
  }
  if (value.result.ok === true) return value.result.value;
  if (value.result.ok === false && isRecord(value.result.error)
    && typeof value.result.error.code === "string"
    && typeof value.result.error.message === "string"
    && isRecord(value.result.error.details)) {
    throw new Error(formatRpcError(endpoint, value.result.error));
  }
  throw new Error(`official RPC ${endpoint} returned an invalid result branch`);
}

function isDeepSeekFlashV41(value) {
  if (!isRecord(value)) return false;
  const text = `${value.id ?? ""} ${value.name ?? ""}`;
  return /deepseek/i.test(text) && /(?:v4\.?1|v41)/i.test(text) && /flash/i.test(text);
}

function selectDeepSeekCatalogModel(catalog) {
  if (!isRecord(catalog) || !Array.isArray(catalog.routableProviders) || !Array.isArray(catalog.groups)) {
    return undefined;
  }
  const provider = catalog.routableProviders.find((value) => value === "deepseek-account");
  if (provider === undefined) return undefined;
  const groups = catalog.groups.filter((group) => isRecord(group) && Array.isArray(group.models));
  const group = groups.find((candidate) => candidate.id === provider);
  if (group === undefined) return undefined;
  const isFlashModel = (candidate) => isDeepSeekFlashV41({
    ...candidate,
    id: `${group.id ?? ""} ${candidate?.id ?? ""}`,
    name: `${group.name ?? ""} ${candidate?.name ?? ""}`,
  });
  const defaultRoute = isRecord(catalog.default) && catalog.default.provider === provider
    ? catalog.default
    : undefined;
  const model = group.models.find((candidate) => defaultRoute?.model === candidate?.id && isFlashModel(candidate))
    ?? group.models.find((candidate) => isFlashModel(candidate));
  if (!isRecord(model) || typeof model.id !== "string" || model.id.length === 0) return undefined;
  const target = { provider, model: model.id };
  const reasoningEffort = isRecord(model.reasoning) && typeof model.reasoning.defaultEffort === "string"
    ? model.reasoning.defaultEffort
    : undefined;
  return reasoningEffort === undefined ? target : { ...target, reasoningEffort };
}

function routeMatches(value, target) {
  if (!isRecord(value) || value.provider !== target.provider || value.model !== target.model) return false;
  if (target.reasoningEffort === undefined) return value.reasoningEffort === undefined;
  return value.reasoningEffort === target.reasoningEffort;
}

function projectionMatchesTarget(modelSelection, target) {
  if (!isRecord(modelSelection)) return false;
  const effective = modelSelection.next !== null && modelSelection.next !== undefined
    ? modelSelection.next
    : modelSelection.lastUsed;
  return routeMatches(effective, target);
}

function buildFollowRequest(sessionId, assistantStream = undefined) {
  if (assistantStream === false) {
    throw new Error("alpha.2 session/follow assistantStream only accepts literal true or omission");
  }
  return {
    address: { kind: "session", sessionId },
    ...(assistantStream === true ? { assistantStream: true } : {}),
    maxMessages: 50,
  };
}

const SNAPSHOT_HEADER_KEYS = [
  "version",
  "id",
  "createdAt",
  "cwd",
  "parentSession",
  "isSeeded",
  "origin",
  "delegationDepth",
  "agentPreset",
];

const SNAPSHOT_EVENT_KEYS = [
  "type",
  "seq",
  "time",
  "data",
  "ignorable",
  "sourceEventSeqs",
  "surfaceOp",
];

function isJsonValue(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return true;
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (!isRecord(value)) return false;
  return Object.values(value).every(isJsonValue);
}

function validSnapshotEvent(value) {
  if (!isRecord(value)
    || Object.keys(value).some((key) => !SNAPSHOT_EVENT_KEYS.includes(key))
    || typeof value.type !== "string"
    || !Number.isSafeInteger(value.seq)
    || value.seq < 0
    || Object.is(value.seq, -0)
    || !Number.isSafeInteger(value.time)
    || !Object.hasOwn(value, "data")
    || value.data === undefined
    || !isJsonValue(value.data)) {
    return false;
  }
  if (Object.hasOwn(value, "ignorable") && value.ignorable !== true) return false;
  if (Object.hasOwn(value, "sourceEventSeqs") && !isJsonValue(value.sourceEventSeqs)) {
    return false;
  }
  if (Object.hasOwn(value, "surfaceOp") && !isJsonValue(value.surfaceOp)) return false;
  return true;
}

function snapshotShapeDiagnostic(value, expectedSessionId) {
  const item = isRecord(value) ? value : undefined;
  const header = isRecord(item?.header) ? item.header : undefined;
  const records = Array.isArray(item?.records) ? item.records : undefined;
  const headerKeys = header === undefined ? [] : Object.keys(header);
  const headerFieldTypes = Object.fromEntries(SNAPSHOT_HEADER_KEYS
    .filter((key) => header !== undefined && Object.hasOwn(header, key))
    .map((key) => [key, typeof header[key]]));
  const recordShapes = records === undefined ? [] : records.slice(0, 4).map((record) => ({
    isRecord: isRecord(record),
    typePresent: isRecord(record) && Object.hasOwn(record, "type"),
    typeKind: isRecord(record) && record.type === "event" ? "event" : typeof record?.type,
    eventPresent: isRecord(record) && Object.hasOwn(record, "event"),
    eventIsRecord: isRecord(record?.event),
  }));
  const headerIdMatchesExpected = typeof expectedSessionId === "string"
    && expectedSessionId.length > 0
    && header?.id === expectedSessionId;
  const validHeader = header !== undefined
    && typeof header.version === "number"
    && Number.isFinite(header.version)
    && typeof header.id === "string"
    && typeof header.createdAt === "number"
    && Number.isFinite(header.createdAt)
    && typeof header.isSeeded === "boolean"
    && (!Object.hasOwn(header, "cwd") || typeof header.cwd === "string")
    && (!Object.hasOwn(header, "parentSession") || typeof header.parentSession === "string")
    && (!Object.hasOwn(header, "origin") || header.origin === "subagent")
    && (!Object.hasOwn(header, "delegationDepth")
      || (typeof header.delegationDepth === "number" && Number.isFinite(header.delegationDepth)))
    && (!Object.hasOwn(header, "agentPreset") || typeof header.agentPreset === "string");
  const validRecords = records !== undefined && records.every((record) => {
    const event = record?.event;
    return isRecord(record)
      && Object.keys(record).every((key) => key === "type" || key === "event")
      && record.type === "event"
      && validSnapshotEvent(event);
  });
  const projections = isRecord(item?.projections) ? item.projections : undefined;
  const validProjections = projections !== undefined
    && typeof projections.asOfSeq === "number"
    && Number.isFinite(projections.asOfSeq)
    && isRecord(projections.values);
  return {
    valid: item?.type === "snapshot"
      && validHeader
      && headerIdMatchesExpected
      && typeof item.cursor === "number"
      && Number.isFinite(item.cursor)
      && validRecords
      && typeof item.hasMore === "boolean"
      && validProjections,
    itemType: typeof item?.type,
    itemTypeKind: item?.type === "snapshot" ? "snapshot" : typeof item?.type,
    headerIsRecord: header !== undefined,
    headerKeys: headerKeys.filter((key) => SNAPSHOT_HEADER_KEYS.includes(key)).sort(),
    headerUnknownKeyCount: headerKeys.filter((key) => !SNAPSHOT_HEADER_KEYS.includes(key)).length,
    headerFieldTypes,
    headerIdMatchesExpected,
    cursorType: typeof item?.cursor,
    recordsIsArray: records !== undefined,
    recordsLength: records?.length ?? null,
    hasMoreType: typeof item?.hasMore,
    projectionsIsRecord: projections !== undefined,
    recordShapes,
  };
}

function shouldIgnoreFollowCleanupError(state, preflightOnly, error) {
  return preflightOnly
    && state?.cleaningUp === true
    && state.followReady === true
    && state.failure === undefined
    && error === state.cleanupReason;
}

function buildSessionTitle(attemptId, sessionIdSha256, preset = "standard") {
  const attempt = safeAttemptId(attemptId).slice(0, 16);
  const sessionHash = String(sessionIdSha256 ?? "").replace(/[^A-Fa-f0-9]/g, "").slice(0, 8);
  const modeLabel = preset === "bash-git-bash" ? "Git Bash" : "WSL";
  return `GUI Bash ${modeLabel} smoke 20261011-${attempt}-${sessionHash || "unknown"}`;
}

function exitCodeForStatus(status) {
  return status === "PASS" || status === "PREFLIGHT_PASS" ? 0 : 1;
}

function selectDriverMode(args = []) {
  if (!Array.isArray(args)) throw new Error("driver arguments must be an array");
  if (args.length === 0) return "real-turn";
  if (args.length !== 1) {
    throw new Error("driver arguments must contain at most one mode flag");
  }
  switch (args[0]) {
    case "--preflight-only":
      return "preflight-only";
    case "--owned-linux-ledger-baseline":
      return "owned-linux-ledger-baseline";
    case "--owned-lineage-self-check":
      return "owned-lineage-self-check";
    default:
      throw new Error(`unknown driver mode flag: ${String(args[0])}`);
  }
}

async function main() {
  const preflightOnly = process.argv.includes("--preflight-only");
  if (process.platform !== "win32") throw new Error("real Desktop session driver requires Windows Node");
  if (!existsSync(OWNED_ROOT)) throw new Error("owned GUI fixture root is missing");
  const runReal = realpathSync(RUN_ROOT);
  const rootReal = realpathSync(OWNED_ROOT);
  if (!inside(runReal, rootReal)) throw new Error("owned GUI root escaped 测试/运行产物");
  const dshHome = join(OWNED_ROOT, "dsh-home");
  const userData = join(OWNED_ROOT, "electron-user-data");
  const workspace = join(OWNED_ROOT, "workspace 中文 space");
  const canonicalTgzPath = join(OWNED_ROOT, DEFAULT_TGZ_NAME);
  for (const path of [dshHome, userData, workspace]) if (!inside(rootReal, path)) throw new Error("owned path escaped fixture root");
  const localAppData = process.env.LOCALAPPDATA;
  if (typeof localAppData !== "string" || !isAbsolute(localAppData)) throw new Error("LOCALAPPDATA must be an absolute Windows path");
  const appExe = join(localAppData, "Programs", "DeepSeek Harness", "DeepSeek Harness.exe");
  const appAsar = join(dirname(appExe), "resources", "app.asar");
  const candidate = await resolveGuiCandidateBinding();
  requireFreshNativePreset(candidate, SESSION_PRESET);
  const tgzSha256 = candidate.tgzSha256;
  const sourceHashes = await collectGuiSourceHashes();
  const previousNoAsar = process.noAsar;
  process.noAsar = true;
  let appAsarSha256;
  try {
    appAsarSha256 = await sha256(appAsar);
  } finally {
    process.noAsar = previousNoAsar;
  }
  readDesktopRuntimeIdentity(process.env, { required: true });
  if (appAsarSha256 !== EXPECTED_ASAR_SHA256) throw new Error("installed Desktop app.asar identity changed");
  if ((await sha256(appExe)) !== EXPECTED_EXE_SHA256) throw new Error("installed Desktop executable identity changed");

  const summary = {
    schemaVersion: 2,
    attemptId: ATTEMPT_ID,
    resultArtifact: RESULT_ARTIFACT,
    observationArtifact: OBSERVATION_ARTIFACT,
    mode: preflightOnly ? "preflight-only" : "real-turn",
    modeId: SESSION_PRESET,
    agentPresetRequested: SESSION_PRESET,
    agentPresetBinding: {
      requested: SESSION_PRESET,
      sessionCreate: null,
      sessionHeader: null,
      sessionHeaderIdSha256: null,
      exact: false,
    },
    status: "RUNNING",
    fixture: FIXTURE_ID,
    runtime: "DeepSeek Harness Desktop 0.2.2-alpha.2",
    tgzSha256,
    candidateBinding: {
      tgzRelativePath: candidate.tgzRelativePath,
      expectedSha256: candidate.expectedSha256,
      supplied: candidate.supplied,
      freshRequired: candidate.freshRequired,
      isCanonical: candidate.isCanonical,
      candidateIndependent: candidate.candidateIndependent,
    },
    sourceHashes,
    appAsarSha256,
    sessionIdSha256: null,
    cwd: "owned fixture workspace 中文 space",
    agentPreset: null,
    provider: null,
    model: null,
    modelRouteObserved: false,
    deepSeekModelObserved: false,
    preflightModelRouteObserved: false,
    preflightProvider: null,
    preflightModel: null,
    sessionTitle: null,
    followReady: false,
    followReadyAt: null,
    followShapeDiagnostic: null,
    eventTypes: {},
    toolCalls: 0,
    toolResults: 0,
    toolErrors: 0,
    toolNames: [],
    toolCallIdsSha256: [],
    toolResultCallIdsSha256: [],
    markers: Object.fromEntries(MARKERS.map((marker) => [marker, false])),
    nativeCallLedger: [],
    rawArtifacts: null,
    nativeModes: [],
    publicSessionObserved: false,
    permission: {
      mode: requiredPermissionPreset(SESSION_PRESET),
      authorizationGranted: SESSION_PRESET === "bash-git-bash"
        ? gitFullAccessAuthorized()
        : null,
      authorizationInput: SESSION_PRESET === "bash-git-bash"
        ? "DSH_GUI_ALLOW_GIT_FULL_ACCESS=1"
        : null,
      authorizationSource: SESSION_PRESET === "bash-git-bash"
        ? "explicit-user-test-authorization"
        : null,
      authorizationScope: SESSION_PRESET === "bash-git-bash"
        ? "owned-gui-session"
        : null,
      command: null,
      workspaceWrite: null,
      fullAccess: null,
      prePromptProjection: null,
    },
    systemPromptUsageObserved: false,
    turnStarts: 0,
    turnEnded: false,
    turnEndKind: null,
    promptAttempted: false,
    promptAccepted: false,
    preflightOnlyPromptSkipped: false,
    observationReady: false,
    observationReadyAt: null,
    observationWindowMs: OBSERVATION_WINDOW_MS,
    observationElapsedMs: 0,
    observationChildClosed: false,
    protocolFailure: false,
    failureReason: null,
    cancelAttempted: false,
    cancelSucceeded: false,
    cleanup: {
      strategy: "reused-protected-owned-fixture",
      temporaryRootCreated: false,
      temporaryRootRemoved: false,
      temporaryRootNotApplicable: true,
      profileContained: false,
      profileContainment: null,
      protectedFixtureReused: true,
      protectedFixturePreserved: false,
      canonicalTgzPreserved: false,
      canonicalTgzSha256: CANONICAL_TGZ_SHA256,
      canonicalTgzBeforeSha256: null,
      canonicalTgzAfterSha256: null,
      childClosed: false,
      socketClosed: false,
      queueEnded: false,
      terminationAttempted: false,
      officialSessionCancelAttempted: false,
      officialSessionCancelSucceeded: false,
      lineageInitial: null,
      lineageBeforeTerminate: null,
      lineageBeforeConfirm: null,
      lineageAfter: null,
      killAuthorizedByLineage: false,
      reaped: false,
      wslLedgerBefore: null,
      wslLedgerAfter: null,
      backendCleanup: null,
    },
    accountCredentialsRead: false,
    accountCredentialsPersisted: false,
    ephemeralLocalTransportAuthHandled: false,
    userConversationRead: false,
    wslMarkerStrategy: WSL_MARKER_STRATEGY,
  };
  let child;
  let socket;
  let queue;
  let sessionId;
  let followAbort;
  let followTask;
  let promptAbort;
  let promptTask;
  let state;
  let cookie;
  let WebSocketCtor;
  let initialLineageTask;
  let ownedProcessMarkers;
  let transportBase;
  let transportHost;
  try {
    const protectedBefore = protectedFixtureEvidence(OWNED_ROOT, rootReal);
    summary.cleanup.protectedFixturePreserved = protectedBefore.preserved;
    if (!protectedBefore.preserved) {
      throw new Error("protected GUI fixture realpath changed before launch");
    }
    summary.cleanup.profileContainment = pathContainmentEvidence(
      rootReal,
      [dshHome, userData, workspace],
    );
    if (existsSync(canonicalTgzPath)) {
      summary.cleanup.canonicalTgzBeforeSha256 = await sha256(canonicalTgzPath);
    }
    if (summary.cleanup.canonicalTgzBeforeSha256 !== CANONICAL_TGZ_SHA256) {
      throw new Error("protected canonical GUI TGZ identity is missing or changed");
    }
    requireGitFullAccessAuthorization(SESSION_PRESET);
    const logDir = join(OWNED_ROOT, "logs");
    mkdirSync(logDir, { recursive: true });
    const stderrFd = openSync(join(logDir, "owned-gui-session.stderr.log"), "a");
    const guiEnvironment = { ...process.env, DSH_HOME: dshHome, DSH_TELEMETRY_DISABLED: "1" };
    delete guiEnvironment.ELECTRON_RUN_AS_NODE;
    delete guiEnvironment.ELECTRON_NO_ATTACH_CONSOLE;
    delete guiEnvironment.DSH_GUI_ALLOW_GIT_FULL_ACCESS;
    child = spawn(appExe, ["--user-data-dir", userData], {
      cwd: workspace,
      env: guiEnvironment,
      detached: false,
      windowsHide: false,
      shell: false,
      stdio: ["ignore", "pipe", stderrFd],
    });
    closeSync(stderrFd);
      ownedProcessMarkers = [userData, OWNED_ROOT, workspace];
    initialLineageTask = captureInitialLineage(child.pid, ownedProcessMarkers);
    child.stdout?.setEncoding("utf8");
    let stdoutBuffer = "";
    let captureLaunchToken = true;
    let launchToken;
    let launchBase;
    const tokenWait = new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => rejectPromise(new Error("owned Desktop launch token was not observed within 20s")), CHILD_START_TIMEOUT_MS);
      const onError = (error) => {
        clearTimeout(timer);
        rejectPromise(error);
      };
      child.once("error", onError);
      child.stdout?.on("error", onError);
      child.stdout?.on("data", (chunk) => {
        if (!captureLaunchToken) return;
        stdoutBuffer = `${stdoutBuffer}${chunk}`.slice(-64 * 1024);
        const urlMatch = stdoutBuffer.match(/https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+\/[^\s"'<>]*[?&]token=[^\s&#"'<>]+/i);
        const match = stdoutBuffer.match(/[?&]token=([^\s&#"'<>]+)/i);
        if (match === null || launchToken !== undefined) return;
        try {
          if (urlMatch !== null) launchBase = new URL(urlMatch[0]).origin;
          launchToken = decodeURIComponent(match[1]);
        } catch (error) {
          onError(new Error("owned Desktop launch token was malformed", { cause: error }));
          return;
        }
        captureLaunchToken = false;
        stdoutBuffer = "";
        clearTimeout(timer);
        resolvePromise();
      });
      child.stdout?.resume();
    });
    await tokenWait;
    summary.cleanup.lineageInitial = await initialLineageTask;
    if (typeof launchToken !== "string" || launchToken.length === 0) throw new Error("owned Desktop launch token was empty");

    const base = launchBase ?? "http://127.0.0.1:19387";
    const baseHost = new URL(base).host;
    transportBase = base;
    transportHost = baseHost;
    const authBounded = abortableSignal(undefined, RPC_TIMEOUT_MS, "owned Desktop auth exchange timed out");
    let rootResponse;
    try {
      rootResponse = await fetch(`${base}/?token=${encodeURIComponent(launchToken)}`, {
        redirect: "manual",
        headers: { Host: baseHost },
        signal: authBounded.signal,
      });
    } finally {
      authBounded.dispose();
    }
    const setCookies = typeof rootResponse.headers.getSetCookie === "function"
      ? rootResponse.headers.getSetCookie()
      : (rootResponse.headers.get("set-cookie") ? [rootResponse.headers.get("set-cookie")] : []);
    if (rootResponse.status < 300 || rootResponse.status >= 400 || setCookies.length === 0) {
      throw new Error(`owned Desktop auth exchange failed HTTP ${rootResponse.status}`);
    }
    cookie = setCookies.map((value) => value.split(";", 1)[0]).join("; ");
    launchToken = undefined;
    summary.ephemeralLocalTransportAuthHandled = true;
    const origin = base;
    const headers = { "content-type": "application/json", Cookie: cookie, Host: baseHost, Origin: origin };
    async function rpc(endpoint, args, parentSignal = undefined, timeoutMs = RPC_TIMEOUT_MS) {
      const rpcId = randomUUID();
      const bounded = abortableSignal(parentSignal, timeoutMs, `official RPC ${endpoint} timed out`);
      try {
        const response = await fetch(`${base}/api/${endpoint}`, {
          method: "POST",
          headers,
          body: JSON.stringify({ type: "client-request", rpcId, method: endpoint, payload: { args } }),
          signal: bounded.signal,
        });
        if (!response.ok) throw new Error(`official RPC ${endpoint} transport failure HTTP ${response.status}`);
        return parseRpcResponse(await response.json(), rpcId, endpoint);
      } finally {
        bounded.dispose();
      }
    }

    const createValue = await rpc("session/create", {
      request: { cwd: workspace, agentPreset: SESSION_PRESET },
    });
    if (!isRecord(createValue)) throw new Error("session/create returned a non-record value");
    sessionId = createValue?.sessionId;
    if (typeof sessionId !== "string" || sessionId.length === 0) throw new Error("session/create returned no sessionId");
    summary.sessionIdSha256 = stableHash(sessionId);
    summary.agentPreset = createValue.agentPreset ?? null;
    summary.agentPresetBinding.sessionCreate = summary.agentPreset;
    const sessionCreatePresetMatches = summary.agentPreset === SESSION_PRESET;
    if (Object.hasOwn(createValue, "agentPreset") && !sessionCreatePresetMatches) {
      throw new Error("session/create returned a different agentPreset than requested");
    }
    if (SESSION_PRESET !== "standard" && !sessionCreatePresetMatches) {
      throw new Error("explicit native mode session/create did not echo its agentPreset");
    }
    const permissionCommands = await rpc("commands/list", { agentId: sessionId });
    summary.permission.command = permissionCommandEvidence(permissionCommands);
    const applyPermission = async (preset) => {
      const acknowledged = await rpc("commands/execute", {
        agentId: sessionId,
        line: `/permission ${preset}`,
        submittedAttachments: [],
      });
      const ack = permissionAckEvidence(acknowledged, preset);
      const projected = await rpc("session/projections", {
        request: { sessionId },
      });
      const projection = permissionProjectionEvidence(projected, preset);
      return { ack, projection };
    };
    summary.permission.workspaceWrite = await applyPermission(WORKSPACE_WRITE_PRESET);
    if (SESSION_PRESET === "bash-git-bash") {
      // The environment gate is the test's explicit human authorization. It is
      // checked again after workspace-write and immediately before escalation.
      requireGitFullAccessAuthorization(SESSION_PRESET);
      summary.permission.authorizationGranted = true;
      summary.permission.fullAccess = await applyPermission(FULL_ACCESS_PRESET);
    }
    const modelCatalog = await rpc("session/modelCatalog", {});
    const targetRoute = selectDeepSeekCatalogModel(modelCatalog);
    if (targetRoute === undefined) {
      throw new Error("session/modelCatalog has no routable deepseek-account V4.1 Flash model");
    }
    summary.preflightProvider = targetRoute.provider;
    summary.preflightModel = targetRoute.model;
    const selectRequest = {
      sessionId,
      provider: targetRoute.provider,
      model: targetRoute.model,
      ...(targetRoute.reasoningEffort === undefined ? {} : { reasoningEffort: targetRoute.reasoningEffort }),
    };
    const selectedValue = await rpc("session/selectModel", { request: selectRequest });
    if (!isRecord(selectedValue) || !routeMatches(selectedValue.selected, targetRoute)) {
      throw new Error("session/selectModel did not acknowledge the catalog-selected DeepSeek route");
    }
    const projections = await rpc("session/projections", { request: { sessionId } });
    const modelSelection = projections?.values?.modelSelection;
    if (!projectionMatchesTarget(modelSelection, targetRoute)) {
      throw new Error("session/projections did not expose the selected DeepSeek route before prompt");
    }
    summary.preflightModelRouteObserved = true;
    const renamed = await rpc("session/rename", {
      request: { sessionId, title: buildSessionTitle(ATTEMPT_ID, summary.sessionIdSha256, SESSION_PRESET) },
    });
    if (!isRecord(renamed) || typeof renamed.title !== "string" || !Number.isSafeInteger(renamed.seq)) throw new Error("session/rename returned an invalid result");
    summary.sessionTitle = renamed.title;

    WebSocketCtor = await loadWebSocketConstructor();
    socket = await openWebSocket(WebSocketCtor, `${base.replace("http:", "ws:")}/api/remote.mux`, cookie, origin);
    queue = new AsyncQueue();
    const streamId = randomUUID();
    followAbort = new AbortController();
    let resolveFollowReady;
    let rejectFollowReady;
    const followReadyPromise = new Promise((resolvePromise, rejectPromise) => {
      resolveFollowReady = resolvePromise;
      rejectFollowReady = rejectPromise;
    });
    state = {
      summary,
      pending: new Map(),
      seenCallIds: new Set(),
      deferredEvents: [],
      flushDeferred: () => {
        const events = state.deferredEvents.splice(0);
        for (const event of events) {
          summarizeEvent(event, state);
          if (state.failure !== undefined) break;
        }
      },
      turnId: undefined,
      turnEnded: false,
      followReady: false,
      followReadyPromise,
      resolveFollowReady,
      rejectFollowReady,
      cleaningUp: false,
      cleanupReason: undefined,
      lastSeq: undefined,
      failure: undefined,
      abort: (reason) => {
        if (!followAbort.signal.aborted) followAbort.abort(reason);
        queue.end(reason);
      },
    };
    followAbort.signal.addEventListener("abort", () => queue.end(followAbort.signal.reason), { once: true });
    const onMessage = (data) => {
      try {
        const frame = parseServerFrame(data);
        if (frame.streamId !== streamId) throw new Error("official Remote frame streamId did not match the owned follow stream");
        queue.push(frame);
      } catch (error) {
        failState(state, error instanceof Error ? error.message : String(error));
      }
    };
    const onSocketError = (error) => failState(state, `official Remote WebSocket error: ${scrubText(error?.message ?? error)}`);
    const onSocketClose = () => {
      if (!followAbort.signal.aborted && !state.turnEnded) failState(state, "official Remote WebSocket closed before turn/end");
      queue.end(state.turnEnded ? undefined : new Error("official Remote stream closed"));
    };
    socket.on("message", onMessage);
    socket.on("error", onSocketError);
    socket.once("close", onSocketClose);
    socket.send(JSON.stringify({
      type: "open",
      streamId,
      endpoint: "session/follow",
      // alpha.2 accepts assistantStream only when it is the literal true. Omit it
      // to request the journal event/snapshot union used by this adapter.
      payload: { args: { request: buildFollowRequest(sessionId) } },
    }));
    followTask = (async () => {
      while (true) {
        const next = await queue.next(followAbort.signal);
        if (next.done) {
          if (!state.turnEnded) throw new Error("session/follow ended before the required turn/end");
          return;
        }
        const frame = next.value;
        if (frame.type === "error") throw new Error(formatRemoteError(frame.error));
        if (frame.type === "end") {
          if (!state.followReady || !state.turnEnded) throw new Error("session/follow ended before the required snapshot and turn/end");
          return;
        }
        if (!Object.hasOwn(frame, "value")) throw new Error("session/follow item omitted its value");
        const item = frame.value;
        if (isRecord(item) && item.type === "snapshot") {
          const shape = snapshotShapeDiagnostic(item, sessionId);
          if (!shape.valid) {
            summary.followShapeDiagnostic = shape;
            throw new Error(`session/follow snapshot shape invalid: ${JSON.stringify(shape)}`);
          }
          const headerPreset = item.header?.agentPreset;
          summary.agentPresetBinding.sessionHeaderIdSha256 = stableHash(item.header.id);
          summary.agentPresetBinding.sessionHeader = typeof headerPreset === "string"
            ? headerPreset
            : null;
          const createPresetMatches = summary.agentPresetBinding.sessionCreate === SESSION_PRESET;
          const headerPresetMatches = headerPreset === SESSION_PRESET;
          summary.agentPresetBinding.exact = createPresetMatches
            && (headerPreset === undefined && SESSION_PRESET === "standard"
              ? true
              : headerPresetMatches);
          if (headerPreset !== undefined && !headerPresetMatches) {
            failState(state, "session/follow snapshot header agentPreset did not match the requested preset");
            throw state.failure;
          }
          if (SESSION_PRESET !== "standard" && !headerPresetMatches) {
            failState(state, "explicit native mode snapshot omitted its agentPreset header");
            throw state.failure;
          }
          for (const record of item.records) {
            if (!isRecord(record) || record.type !== "event" || !isRecord(record.event)) {
              throw new Error("session/follow snapshot contains an invalid event record");
            }
            if (summary.promptAccepted) summarizeEvent(record.event, state);
            else state.deferredEvents.push(record.event);
          }
          if (summary.promptAccepted) state.flushDeferred();
          if (state.failure !== undefined) throw state.failure;
          if (!state.followReady) {
            state.followReady = true;
            summary.followReady = true;
            summary.followReadyAt = new Date().toISOString();
            resolveFollowReady();
          }
          continue;
        }
        if (!isRecord(item) || item.type !== "event" || !isRecord(item.event)) {
          throw new Error("session/follow returned an unknown or malformed frame value");
        }
        if (!state.followReady) throw new Error("session/follow returned an event before the required snapshot");
        if (summary.promptAccepted) summarizeEvent(item.event, state);
        else state.deferredEvents.push(item.event);
        if (state.failure !== undefined) throw state.failure;
        if (state.turnEnded) return;
      }
    })().catch((error) => {
      if (shouldIgnoreFollowCleanupError(state, preflightOnly, error)) return;
      if (state.failure === undefined) {
        failState(state, error instanceof Error ? error.message : String(error));
      }
      throw error;
    });
    const timer = setTimeout(() => failState(state, "real session follow timed out"), TURN_TIMEOUT_MS);
    promptAbort = new AbortController();
    try {
      await followReadyPromise;
      if (!summary.agentPresetBinding.exact
        || summary.agentPresetBinding.sessionCreate !== SESSION_PRESET
        || (SESSION_PRESET !== "standard"
          && summary.agentPresetBinding.sessionHeader !== SESSION_PRESET)) {
        throw new Error("session/follow preset identity was not exact before prompt");
      }
      const prePromptProjectionValue = await rpc("session/projections", {
        request: { sessionId },
      });
      summary.permission.prePromptProjection = permissionProjectionEvidence(
        prePromptProjectionValue,
        requiredPermissionPreset(SESSION_PRESET),
      );
      if (SESSION_PRESET === "bash-git-bash") {
        requireGitFullAccessAuthorization(SESSION_PRESET);
        summary.permission.authorizationGranted = true;
      }
      if (preflightOnly) {
        // This mode proves create/select/projections/follow readiness only. It
        // must never construct or send a session/prompt request.
        summary.preflightOnlyPromptSkipped = true;
      } else {
        summary.promptAttempted = true;
        promptTask = (async () => {
          const accepted = await rpc("session/prompt", {
            request: {
              requestId: randomUUID(),
              sessionId,
              mode: "queue",
              content: [{ type: "text", text: HARMLESS_PROMPT }],
            },
          }, promptAbort.signal);
          if (!isRecord(accepted) || accepted.accepted !== true) throw new Error("session/prompt was not accepted by the official Host");
          summary.promptAccepted = true;
          state.flushDeferred();
          if (state.failure !== undefined) throw state.failure;
        })();
      }
      try {
        if (!preflightOnly) {
          await Promise.race([promptTask, followTask]);
          await promptTask;
          await followTask;
        }
        if (!preflightOnly && summary.turnEnded && state.failure === undefined) {
          clearTimeout(timer);
          if (SESSION_PRESET !== "bash-git-bash") {
            summary.cleanup.wslLedgerBefore = await queryOwnedWslLedger(workspace);
            } else {
              if (summary.cleanup.lineageInitial === null && initialLineageTask !== undefined) {
                summary.cleanup.lineageInitial = await initialLineageTask;
              }
              summary.cleanup.lineageBeforeTerminate = await queryOwnedLineage(
                child.pid,
                ownedProcessMarkers,
                summary.cleanup.lineageInitial?.identities ?? [],
              );
          }
          summary.observationReady = true;
          summary.observationReadyAt = new Date().toISOString();
          summary.rawArtifacts = rawArtifactManifest(summary);
          summary.nativeModes = nativeModeEnvelope(summary);
          writeObservationReady(summary);
          const observation = await observeOwnedChild(child, OBSERVATION_WINDOW_MS);
          summary.observationElapsedMs = observation.elapsedMs;
          summary.observationChildClosed = observation.closed;
        }
      } catch (error) {
        promptAbort.abort(error);
        await promptTask.catch(() => {});
        throw error;
      }
    } finally {
      await promptTask?.catch(() => {});
      clearTimeout(timer);
    }
  } catch (error) {
    if (state !== undefined && state.failure === undefined) failState(state, error instanceof Error ? error.message : String(error));
    else summary.failureReason ??= scrubText(error instanceof Error ? error.message : String(error));
  } finally {
    const cleanupReason = new Error("owned Desktop driver cleanup");
    if (state !== undefined) {
      state.cleaningUp = true;
      state.cleanupReason = cleanupReason;
    }
    try { promptAbort?.abort(new Error("owned Desktop driver cleanup")); } catch {}
    if (sessionId !== undefined && summary.promptAttempted && !summary.turnEnded) {
      summary.cancelAttempted = true;
      summary.cleanup.officialSessionCancelAttempted = true;
      let cancelTimer;
      try {
        const cancelSignal = new AbortController();
        cancelTimer = setTimeout(() => cancelSignal.abort(new Error("session/cancel timed out")), CANCEL_TIMEOUT_MS);
        const rpcBase = transportBase ?? "http://127.0.0.1:19387";
        const rpcHost = transportHost ?? new URL(rpcBase).host;
        const rpcId = randomUUID();
        const response = await fetch(`${rpcBase}/api/session/cancel`, {
          method: "POST",
          headers: { "content-type": "application/json", Cookie: cookie, Host: rpcHost, Origin: rpcBase },
          body: JSON.stringify({ type: "client-request", rpcId, method: "session/cancel", payload: { args: { request: { sessionId } } } }),
          signal: cancelSignal.signal,
        });
        if (!response.ok) throw new Error(`session/cancel HTTP ${response.status}`);
        const cancelValue = parseRpcResponse(await response.json(), rpcId, "session/cancel");
        if (!isRecord(cancelValue) || cancelValue.accepted !== true) throw new Error("session/cancel returned an invalid result");
        summary.cancelSucceeded = true;
        summary.cleanup.officialSessionCancelSucceeded = true;
      } catch (error) {
        summary.failureReason ??= scrubText(error instanceof Error ? error.message : String(error));
      } finally {
        clearTimeout(cancelTimer);
      }
    }
    try { followAbort?.abort(cleanupReason); } catch {}
    queue?.end(cleanupReason);
    summary.cleanup.queueEnded = queue?.ended === true;
    await followTask?.catch(() => {});
    if (socket !== undefined) {
      try {
        if (socket.readyState === 1) socket.close(1000, "owned driver cleanup");
      } catch {}
      summary.cleanup.socketClosed = await new Promise((resolvePromise) => {
        if (socket.readyState === 3) return resolvePromise(true);
        const timer = setTimeout(() => {
          try { socket.terminate?.(); } catch {}
          resolvePromise(false);
        }, 3_000);
        socket.once("close", () => {
          clearTimeout(timer);
          resolvePromise(true);
        });
      });
    }
    if (summary.cleanup.lineageInitial === null && initialLineageTask !== undefined) {
      summary.cleanup.lineageInitial = await initialLineageTask.catch(() => null);
    }
    summary.cleanup.childClosed = await terminateOwnedChild(
      child,
      [userData, OWNED_ROOT, workspace],
      summary.cleanup,
    );
    if (SESSION_PRESET !== "bash-git-bash") {
      summary.cleanup.wslLedgerAfter = await queryOwnedWslLedger(workspace);
    }
    const protectedAfter = protectedFixtureEvidence(OWNED_ROOT, rootReal);
    summary.cleanup.protectedFixturePreserved = protectedAfter.preserved;
    summary.cleanup.profileContainment = pathContainmentEvidence(
      rootReal,
      [dshHome, userData, workspace],
    );
    summary.cleanup.profileContained = summary.cleanup.profileContainment.allInside === true;
    if (existsSync(canonicalTgzPath)) {
      summary.cleanup.canonicalTgzAfterSha256 = await sha256(canonicalTgzPath);
    }
    summary.cleanup.canonicalTgzPreserved = summary.cleanup.canonicalTgzBeforeSha256
      === CANONICAL_TGZ_SHA256
      && summary.cleanup.canonicalTgzAfterSha256 === CANONICAL_TGZ_SHA256;
    summary.cleanup.backendCleanup = backendCleanupEvidence(summary);
    const lineageInitialPass = summary.cleanup.lineageInitial?.available === true
      && summary.cleanup.lineageInitial.verified === true
      && summary.cleanup.lineageInitial.identities.length > 0
      && summary.cleanup.lineageInitial.markerProcessCount > 0;
    const lineagePostPass = summary.cleanup.lineageAfter?.available === true
      && summary.cleanup.lineageAfter.rootPresent === false
      && summary.cleanup.lineageAfter.remainingIdentityCount === 0
      && summary.cleanup.lineageAfter.markerProcessCount === 0;
    const cleanupPass = summary.cleanup.childClosed
      && summary.cleanup.reaped
      && summary.cleanup.socketClosed
      && lineageInitialPass
      && lineagePostPass
      && cleanupScopePass(summary.cleanup);
    const backendCleanupPass = summary.cleanup.backendCleanup?.observed === true;
    const normalTurnPass = summary.promptAccepted
      && summary.toolCalls === MARKERS.length
      && summary.toolResults === MARKERS.length
      && summary.toolErrors === 0
      && MARKERS.every((marker) => summary.markers[marker] === true)
      && summary.turnEnded
      && summary.turnEndKind === "completed"
      && summary.observationReady
      && summary.preflightModelRouteObserved
      && summary.modelRouteObserved
      && summary.deepSeekModelObserved
      && (SESSION_PRESET === "standard" || summary.agentPresetBinding.exact === true)
      && state?.failure === undefined
      && summary.observationChildClosed
      && backendCleanupPass
      && cleanupPass;
    summary.rawArtifacts = rawArtifactManifest(summary);
    summary.nativeModes = nativeModeEnvelope(summary);
    // The first observation-ready write happens before owned cleanup so the
    // follow can be observed.  Refresh it after cleanup so its native-mode
    // entries carry the same backend-specific evidence as the final adapter.
    if (summary.observationReady) writeObservationReady(summary);
    summary.status = preflightOnly
      ? (summary.preflightOnlyPromptSkipped && summary.followReady && !summary.promptAttempted
        && !summary.promptAccepted && state?.failure === undefined && cleanupPass
        ? "PREFLIGHT_PASS"
        : "FAIL")
      : (normalTurnPass ? "PASS" : "FAIL");
    mkdirSync(RUN_ROOT, { recursive: true });
    writeFileSync(RESULT_PATH, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  }
  console.log(JSON.stringify(summary));
  process.exitCode = exitCodeForStatus(summary.status);
}

async function runOwnedLinuxLedgerBaseline() {
  const workspace = join(OWNED_ROOT, "workspace 中文 space");
  const ledger = await queryOwnedWslLedger(workspace);
  const result = { schemaVersion: 1, available: ledger.available, markerCount: ledger.markerCount };
  mkdirSync(RUN_ROOT, { recursive: true });
  writeFileSync(LEDGER_BASELINE_PATH, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(result));
  if (!ledger.available || ledger.markerCount !== 0) process.exitCode = 1;
}

async function runOwnedLineageSelfCheck() {
  if (process.platform !== "win32") throw new Error("owned lineage self-check requires Windows Node");
  const markers = [`DSH_LINEAGE_SELF_${ATTEMPT_ID}`, "DSH_LINEAGE_SECOND_MARKER"];
  const childScript = [
    "const {spawn}=require('node:child_process');",
    "const marker=process.argv.at(-1);",
    "spawn(process.execPath,['--expose-internals','--eval','setTimeout(()=>{},5000)',marker],",
    "{env:{...process.env,ELECTRON_RUN_AS_NODE:'1',ELECTRON_NO_ATTACH_CONSOLE:'1'},stdio:'ignore'});",
    "setTimeout(()=>{},5000);",
  ].join("");
  const child = spawn(process.execPath, ["--expose-internals", "--eval", childScript, ...markers], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", ELECTRON_NO_ATTACH_CONSOLE: "1" },
    windowsHide: true,
    shell: false,
    stdio: "ignore",
  });
  const evidence = { lineageInitial: null, lineageBeforeTerminate: null, lineageBeforeConfirm: null };
  try {
    evidence.lineageInitial = await captureInitialLineage(child.pid, markers);
    const during = await queryOwnedLineage(child.pid, markers, evidence.lineageInitial.identities);
    const result = {
      available: evidence.lineageInitial.available && during.available,
      verified: evidence.lineageInitial.verified && during.verified,
      markerCount: evidence.lineageInitial.markerProcessCount,
      identityCount: evidence.lineageInitial.identities.length,
      expectedIdentityCount: evidence.lineageInitial.identities.length,
      identityQueueMatched: during.remainingIdentityCount === evidence.lineageInitial.identities.length,
    };
    await terminateOwnedChild(child, markers, evidence);
    result.postAvailable = evidence.lineageAfter?.available === true;
    result.postMarkerCount = evidence.lineageAfter?.markerProcessCount ?? null;
    result.postIdentityQueueEmpty = evidence.lineageAfter?.remainingIdentityCount === 0;
    result.reaped = evidence.reaped === true;
    console.log(JSON.stringify(result));
    if (!result.available || !result.verified || result.markerCount < 2 || result.identityCount < 2
      || !result.identityQueueMatched || !result.postAvailable || result.postMarkerCount !== 0
      || !result.postIdentityQueueEmpty || !result.reaped) process.exitCode = 1;
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      try { child.kill(); } catch {}
      await waitForChildClose(child, 2_000);
    }
  }
}

export {
  AsyncQueue,
  CANONICAL_TGZ_SHA256,
  OBSERVATION_WINDOW_MS,
  TURN_TIMEOUT_MS,
  buildFollowRequest,
  buildSessionTitle,
  EXPECTED_COMMANDS,
  EXPECTED_OUTPUT_LINES,
  markerLine,
  parseRenderedExitCode,
  nativeModeEnvelope,
  cleanupScopePass,
  gitFullAccessAuthorized,
  requireGitFullAccessAuthorization,
  permissionAckEvidence,
  permissionCommandEvidence,
  permissionEnvelopeEvidence,
  permissionProjectionEvidence,
  parseServerFrame,
  projectionMatchesTarget,
  shouldIgnoreFollowCleanupError,
  exitCodeForStatus,
  formatRpcError,
  safeAttemptId,
  snapshotShapeDiagnostic,
  selectDeepSeekCatalogModel,
  selectSessionPreset,
  requireFreshNativePreset,
  selectDriverMode,
  observeOwnedChild,
  summarizeEvent,
  validCommand,
};

const isMain = process.argv[1] !== undefined
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  let task;
  try {
    const mode = selectDriverMode(process.argv.slice(2));
    task = mode === "owned-linux-ledger-baseline"
      ? runOwnedLinuxLedgerBaseline()
      : mode === "owned-lineage-self-check"
        ? runOwnedLineageSelfCheck()
        : main();
  } catch (error) {
    try {
      console.error(`real Desktop session driver failed: ${scrubText(error?.stack ?? error)}`);
    } catch {}
    process.exitCode = 1;
  }
  task?.catch((error) => {
    try {
      console.error(`real Desktop session driver failed: ${scrubText(error?.stack ?? error)}`);
    } catch {}
    process.exitCode = 1;
  });
}
