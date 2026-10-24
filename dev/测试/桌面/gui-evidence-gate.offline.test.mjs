#!/usr/bin/env node

/**
 * Offline regression checks for the current release-check D16 validator.
 *
 * This test extracts the production validator from scripts/release-check.mjs
 * with the installed TypeScript parser. It does not import release-check.mjs,
 * create a real D16 artifact, start a host/model/GUI, or run the full gate.
 * Synthetic JSON is written below 测试/运行产物 only for the duration of each
 * case and removed in the finally block.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import vm from "node:vm";
import ts from "typescript";
import {
  buildGitNormalCloseGapFromBridge,
  extractGitNormalCloseGapBridge,
  KNOWN_GIT_NORMAL_CLOSE_GAP_ID,
  KNOWN_SESSION_DRIVER_SHA256,
} from "./git-normal-close-gap-evidence.mjs";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(TEST_DIR, "../../..");
const RELEASE_CHECK_PATH = join(ROOT, "scripts", "release-check.mjs");
const RUN_OUTPUT_ROOT = join(ROOT, "测试", "运行产物");
const TARBALL = join(ROOT, "dsh-plugin-bash-wsl-0.2.0.tgz");
const LAUNCHER_PATH = join(ROOT, "dev", "测试", "桌面", "run-owned-gui-session-wrapper.mjs");
const SESSION_DRIVER_PATH = join(ROOT, "dev", "测试", "桌面", "run-owned-gui-session.mjs");
const GUI_PROBE_PATH = join(ROOT, "dev", "测试", "桌面", "new-modes-desktop-artifact.mjs");
const GUI_LAUNCHER_PATH = join(ROOT, "dev", "测试", "桌面", "launch-owned-gui.mjs");
const GUI_WRAPPER_PATH = join(ROOT, "dev", "测试", "桌面", "run-owned-gui-session-wrapper.mjs");
const GUI_CANDIDATE_BINDING_PATH = join(ROOT, "dev", "测试", "桌面", "gui-candidate-binding.mjs");

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function sha256Text(value) {
  return createHash("sha256").update(value).digest("hex");
}

const releaseSource = readFileSync(RELEASE_CHECK_PATH, "utf8");
const releaseAst = ts.createSourceFile(
  RELEASE_CHECK_PATH,
  releaseSource,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.JS,
);

function findFunctionSource(name) {
  let found;
  const visit = (node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node;
    ts.forEachChild(node, visit);
  };
  visit(releaseAst);
  assert.ok(found, `could not extract ${name} from release-check.mjs`);
  return releaseSource.slice(found.getStart(releaseAst), found.end);
}

function findInitializerSource(name) {
  let found;
  const visit = (node) => {
    if (ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.name.text === name) {
      found = node.initializer;
    }
    ts.forEachChild(node, visit);
  };
  visit(releaseAst);
  assert.ok(found, `could not extract ${name} from release-check.mjs`);
  return releaseSource.slice(found.getStart(releaseAst), found.end);
}

const helperSources = [
  "isRecord",
  "isSha256",
  "stableJson",
  "sameStableJson",
  "sameStringArray",
  "permissionTransitionIsStrict",
  "nativeModePermissionIsStrict",
  "reusedProtectedFixtureCleanupIsStrict",
  "validateNativeGuiModeEnvelope",
  "validateD16GitNormalCloseGap",
]
  .map(findFunctionSource);
const validatorSource = findFunctionSource("validateD16Evidence");
const guiCheckIds = vm.runInNewContext(`(${findInitializerSource("d16GuiCheckIds")})`);

const fixtureRoot = mkdtempSync(join(RUN_OUTPUT_ROOT, "gui-evidence-gate-offline-"));
const fakeAsarPath = join(fixtureRoot, "offline-app.asar");
const fakeExecutablePath = join(fixtureRoot, "offline-desktop.exe");
writeFileSync(fakeAsarPath, "offline ASAR fixture; never used as a Desktop runtime\n");
writeFileSync(fakeExecutablePath, "offline executable fixture; never executed\n");
const fakeAsarSha256 = sha256(fakeAsarPath);
const fakeExecutableSha256 = sha256(fakeExecutablePath);
const launcherSha256 = sha256(LAUNCHER_PATH);
const sessionDriverSha256 = sha256(SESSION_DRIVER_PATH);
const tarballSha256 = sha256(TARBALL);
const CANDIDATE_TARBALL = join(ROOT, "测试", "运行产物", "new-modes-pack-20261014-native-protocol-batching", "dsh-plugin-bash-wsl-0.2.0.tgz");
const candidateTarballSha256 = sha256(CANDIDATE_TARBALL);
const candidateSourceHashes = {
  probe: sha256(GUI_PROBE_PATH),
  sessionDriver: sessionDriverSha256,
  launcher: sha256(GUI_LAUNCHER_PATH),
  wrapper: sha256(GUI_WRAPPER_PATH),
  candidateBinding: sha256(GUI_CANDIDATE_BINDING_PATH),
};
const callHashes = [sha256Text("offline-call-one"), sha256Text("offline-call-two")];
const sessionIdSha256 = sha256Text("offline-session-id");
const CANONICAL_TGZ_SHA256 =
  "9cb01907dd7a9558255b6b8d5fe5ef03349927711fef0aadf9456656fe2b6f63";

function pathInside(parent, child) {
  const relativePath = relative(parent, child);
  const separator = parent.includes("\\") ? "\\" : "/";
  return relativePath.length > 0
    && relativePath !== ".."
    && !relativePath.startsWith(`..${separator}`)
    && !isAbsolute(relativePath);
}

function assertFixtureRootSafe(path) {
  const testRoot = realpathSync(join(ROOT, "测试"));
  const outputRoot = realpathSync(RUN_OUTPUT_ROOT);
  const candidate = realpathSync(path);
  const leaf = candidate.split(/[\\/]/).at(-1) ?? "";
  assert.match(leaf, /^gui-evidence-gate-offline-/);
  assert.ok(pathInside(testRoot, candidate), "fixture root escaped repository 测试");
  assert.ok(pathInside(outputRoot, candidate), "fixture root escaped 测试/运行产物");
}

const vmContext = {
  __validateD16Evidence: undefined,
  root: ROOT,
  runOutputRoot: RUN_OUTPUT_ROOT,
  expectedDesktopAsarSha256: fakeAsarSha256,
  expectedDesktopExecutableSha256: fakeExecutableSha256,
  d16LauncherPath: LAUNCHER_PATH,
  d16SessionDriverPath: SESSION_DRIVER_PATH,
  d16GuiCheckIds: guiCheckIds,
  buildGitNormalCloseGapFromBridge,
  extractGitNormalCloseGapBridge,
  KNOWN_GIT_NORMAL_CLOSE_GAP_ID,
  KNOWN_SESSION_DRIVER_SHA256,
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  resolve,
  relative,
  isAbsolute,
  extname,
  fileSha256: sha256,
  installedDesktopPathsForGate: () => ({
    asar: fakeAsarPath,
    executable: fakeExecutablePath,
  }),
};

vm.runInNewContext(
  `${helperSources.join("\n\n")}\nthis.__validateD16Evidence = ${validatorSource};`,
  vmContext,
  { filename: RELEASE_CHECK_PATH },
);
const validateD16Evidence = vmContext.__validateD16Evidence;
assert.equal(typeof validateD16Evidence, "function");

let caseNumber = 0;

function baseLineage() {
  return {
    available: true,
    verified: true,
    rootPresent: true,
    identities: [{ pid: 1001, ppid: 999, starttime: 1 }],
    markerProcessCount: 1,
  };
}

function baseAfterLineage() {
  return {
    available: true,
    rootPresent: false,
    identities: [],
    remainingIdentityCount: 0,
    markerProcessCount: 0,
  };
}

function createFixture(mutate, mutateEvidence, tarballPath = TARBALL, mutateAfterNativeModes) {
  const fixtureTgzSha256 = sha256(tarballPath);
  const caseRoot = mkdtempSync(join(fixtureRoot, `case-${String(caseNumber++).padStart(2, "0")}-`));
  const adapter = {
    schemaVersion: 2,
    attemptId: "offline-attempt-001",
    resultArtifact: "gui-deepseek-real-session-20261011-offline.json",
    observationArtifact: "gui-deepseek-real-session-observation-ready-20261011-offline.json",
    mode: "real-turn",
    status: "PASS",
    fixture: "gui-human-canonical-20261010-2340",
    runtime: "DeepSeek Harness Desktop 0.2.1-rc.3",
    tgzSha256: fixtureTgzSha256,
    appAsarSha256: fakeAsarSha256,
    sessionIdSha256,
    cwd: "owned fixture workspace 中文 space",
    agentPreset: "standard",
    provider: "deepseek-account",
    model: "deepseek-flash",
    modelRouteObserved: true,
    deepSeekModelObserved: true,
    preflightModelRouteObserved: true,
    preflightProvider: "deepseek-account",
    preflightModel: "deepseek-flash",
    sessionTitle: "GUI Bash WSL smoke offline-attempt-session",
    followReady: true,
    promptAttempted: true,
    promptAccepted: true,
    protocolFailure: false,
    failureReason: null,
    toolCalls: 2,
    toolResults: 2,
    toolErrors: 0,
    toolNames: ["bash", "bash"],
    toolCallIdsSha256: [...callHashes],
    toolResultCallIdsSha256: [...callHashes],
    markers: { DSH_GUI_TURN1: true, DSH_GUI_TURN2: true },
    turnStarts: 1,
    turnEnded: true,
    turnEndKind: "completed",
    accountCredentialsRead: false,
    accountCredentialsPersisted: false,
    userConversationRead: false,
    ephemeralLocalTransportAuthHandled: true,
    cancelAttempted: false,
    observationReady: true,
    observationChildClosed: true,
    cleanup: {
      childClosed: true,
      socketClosed: true,
      queueEnded: true,
      reaped: true,
      lineageInitial: baseLineage(),
      lineageAfter: baseAfterLineage(),
      wslLedgerBefore: { available: true, markerCount: 1, identities: [{ pid: 1 }] },
      wslLedgerAfter: { available: true, markerCount: 0, identities: [] },
    },
  };
  const gui = {
    schemaVersion: 1,
    status: "PASS",
    source: "@oai/sky",
    independent: true,
    windowId: 42,
    uniqueWindow: true,
    attemptId: adapter.attemptId,
    sessionIdSha256,
    sessionTitle: adapter.sessionTitle,
    systemPromptVisibility: "not-visually-verified",
    initialWindowsLineage: baseLineage(),
    finalWindowsLineage: baseAfterLineage(),
    route: { provider: adapter.provider, model: adapter.model },
    desktopIdentity: {
      tgzSha256: fixtureTgzSha256,
      appAsarSha256: fakeAsarSha256,
      executableSha256: fakeExecutableSha256,
    },
    helperSourceHashes: {
      launcher: launcherSha256,
      sessionDriver: sessionDriverSha256,
    },
    checks: Object.fromEntries(guiCheckIds.map((id) => [id, true])),
    toolCards: [
      {
        observed: true,
        toolName: "bash",
        callIdSha256: callHashes[0],
        identityCorrelation: "session-order-and-exact-output",
        outputMarker: "DSH_GUI_TURN1:DSH_GUI_TURN1",
      },
      {
        observed: true,
        toolName: "bash",
        callIdSha256: callHashes[1],
        identityCorrelation: "session-order-and-exact-output",
        outputMarker: "DSH_GUI_TURN2:DSH_GUI_TURN1",
      },
    ],
    normalGuiExit: { closeObserved: true, reaped: true, aliveAfter: false },
    temporaryProfileCleanup: { temporaryRootRemoved: true, profileContained: true },
    resultArtifact: "gui-deepseek-real-session-gui-observation-20261011-offline.json",
  };
  const ready = {
    schemaVersion: 2,
    status: "OBSERVATION_READY",
    mode: "real-turn",
    attemptId: adapter.attemptId,
    sessionIdSha256: adapter.sessionIdSha256,
    sessionTitle: adapter.sessionTitle,
    tgzSha256: adapter.tgzSha256,
    appAsarSha256: adapter.appAsarSha256,
    followReady: true,
    provider: adapter.provider,
    model: adapter.model,
    toolCalls: 2,
    toolResults: 2,
    toolErrors: 0,
    toolNames: ["bash", "bash"],
    markers: { DSH_GUI_TURN1: true, DSH_GUI_TURN2: true },
    turnStarts: 1,
    turnEnded: true,
    turnEndKind: "completed",
  };
  mutate?.({ adapter, gui, ready });
  const artifactPath = (path) => relative(ROOT, path).replaceAll("\\", "/");
  if (Array.isArray(adapter.nativeModes)) {
    const backendByMode = {
      "bash-wsl": { backendType: "wsl", cleanupKind: "wsl-public-session" },
      "bash-git-bash": { backendType: "git-bash", cleanupKind: "native-process-tree" },
    };
    gui.nativeModes = adapter.nativeModes.map((adapterMode) => {
      const backend = backendByMode[adapterMode.modeId];
      const nativeArtifactPath = join(caseRoot, `${adapterMode.modeId}-native.json`);
      const nativeChecks = [
        {
          id: `${adapterMode.modeId}:standard-composition`,
          status: "PASS",
          evidence: {},
        },
        {
          id: `${adapterMode.modeId}:system-prompt`,
          status: "PASS",
          evidence: {},
        },
        {
          id: `${adapterMode.modeId}:native-lifecycle`,
          status: "PASS",
          evidence: { publicSessionObserved: true },
        },
        {
          id: `${adapterMode.modeId}:owner-dispose`,
          status: "PASS",
          evidence: {
            processCleanupOk: true,
            processObservationErrors: [],
          },
        },
        {
          id: `${adapterMode.modeId}:natural-exit-reset`,
          status: "PASS",
          evidence: {
            processLedger: {
              available: true,
              naturalOwnedIdentities: adapterMode.modeId === "bash-git-bash"
                ? ["2001:/Date(offline)/"]
                : [],
              afterDelayRows: [],
            },
          },
        },
      ];
      if (adapterMode.modeId === "bash-wsl") {
        nativeChecks.push({
          id: "bash-wsl:background-process-cleanup",
          status: "PASS",
          evidence: { backendType: "wsl", backgroundReapOk: true },
        });
      } else {
        nativeChecks.push(
          {
            id: "bash-git-bash:native-pid-pty",
            status: "PASS",
            evidence: {
              nativePid: 23340,
              truePty: true,
              helperSpawnObserved: true,
            },
          },
          {
            id: "bash-git-bash:helper-job-quiescence",
            status: "PASS",
            evidence: {
              nativeHandlesSettled: true,
              processCleanupOk: true,
              processObservationErrors: [],
              processAfterOwnerDisposeRows: [],
            },
          },
          ...[
            "bash-git-bash:natural-exit-noisy-background",
            "bash-git-bash:natural-exit-delayed-background",
          ].map((id) => ({
            id,
            status: "PASS",
            evidence: {
              processLedger: { available: true, afterDelayRows: [] },
            },
          })),
        );
      }
      const nativeReport = {
        schemaVersion: 1,
        status: "PASS",
        probeIdentity: {
          sourcePath: "dev/测试/桌面/new-modes-desktop-artifact.mjs",
          sourceSha256: candidateSourceHashes.probe,
        },
        checks: [
          {
            id: "tgz-content-dependency-path-audit",
            status: "PASS",
            evidence: { sha256: candidateTarballSha256 },
          },
          {
            id: "desktop-runtime-hashes",
            status: "PASS",
            evidence: {
              appAsarSha256: fakeAsarSha256,
              executableSha256: fakeExecutableSha256,
            },
          },
        ],
        phases: [{
          label: "enabled-retained",
          status: "PASS",
          child: {
            exitCode: 0,
            timedOut: false,
            closeObserved: true,
            reaped: true,
            error: null,
          },
          evidence: { checks: nativeChecks },
        }],
      };
      writeFileSync(nativeArtifactPath, `${JSON.stringify(nativeReport)}\n`);
      const cards = adapterMode.calls.map((call, index) => ({
        observed: true,
        toolName: "bash",
        callIdSha256: call.callIdSha256,
        identityCorrelation: "session-order-and-exact-output",
        outputMarker: [
          "DSH_GUI_TURN1:DSH_GUI_TURN1",
          "DSH_GUI_TURN2:DSH_GUI_TURN1",
        ][index],
      }));
      return {
        modeId: adapterMode.modeId,
        observed: true,
        backendObservation: {
          source: "new-modes-desktop-artifact",
          backendType: backend.backendType,
          artifact: {
            path: artifactPath(nativeArtifactPath),
            sha256: sha256(nativeArtifactPath),
          },
          strictNativeBinding: {
            validator: "native-modes-release-validator",
            accepted: true,
            modeId: adapterMode.modeId,
            backendType: backend.backendType,
            phaseLabel: "enabled-retained",
            candidateTgzSha256: candidateTarballSha256,
            appAsarSha256: fakeAsarSha256,
            executableSha256: fakeExecutableSha256,
            probeSourceSha256: candidateSourceHashes.probe,
            artifactSha256: sha256(nativeArtifactPath),
          },
        },
        toolCards: cards,
        normalGuiExit: { closeObserved: true, reaped: true, aliveAfter: false },
        cleanup: {
          kind: backend.cleanupKind,
          observed: true,
          guiProcessObservation: true,
          remaining: [],
          observationErrors: [],
        },
      };
    });
  }
  mutateAfterNativeModes?.({ adapter, gui, ready });
  const adapterPath = join(caseRoot, adapter.resultArtifact);
  const guiPath = join(caseRoot, gui.resultArtifact);
  const readyPath = join(caseRoot, adapter.observationArtifact);
  writeFileSync(adapterPath, `${JSON.stringify(adapter)}\n`);
  writeFileSync(guiPath, `${JSON.stringify(gui)}\n`);
  writeFileSync(readyPath, `${JSON.stringify(ready)}\n`);
  const evidence = {
    schemaVersion: 1,
    status: "PASS",
    adapter,
    guiObservation: gui,
    artifactBindings: {
      adapter: { path: artifactPath(adapterPath), sha256: sha256(adapterPath) },
      guiObservation: { path: artifactPath(guiPath), sha256: sha256(guiPath) },
      observationReady: { path: artifactPath(readyPath), sha256: sha256(readyPath) },
    },
  };
  mutateEvidence?.(evidence);
  return { evidence, caseRoot };
}

const cases = [];

function pass(name, fn) {
  try {
    fn();
    cases.push({ name, status: "PASS" });
    console.log(`PASS ${name}`);
  } catch (error) {
    cases.push({ name, status: "FAIL", error });
    console.error(`FAIL ${name}: ${error instanceof Error ? error.stack : String(error)}`);
    process.exitCode = 1;
  }
}

function expectRejected(name, mutate, mutateEvidence, detailPattern) {
  pass(name, () => {
    const { evidence } = createFixture(mutate, mutateEvidence);
    const result = validateD16Evidence(evidence, TARBALL);
    assert.equal(result.ok, false);
    if (detailPattern !== undefined) assert.match(result.detail, detailPattern);
  });
}

function mutateGitNativePtyEvidence(mutator) {
  return ({ gui }) => {
    const mode = gui.nativeModes.find((value) => value.modeId === "bash-git-bash");
    assert.ok(mode, "offline Git Bash native mode is present");
    const artifactPath = resolve(ROOT, mode.backendObservation.artifact.path);
    const artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
    const checks = artifact.phases?.find((phase) => phase.label === "enabled-retained")
      ?.evidence?.checks;
    const check = checks?.find((value) => value.id === "bash-git-bash:native-pid-pty");
    assert.ok(check, "offline Git Bash native-pid-pty check is present");
    mutator(check.evidence);
    writeFileSync(artifactPath, `${JSON.stringify(artifact)}\n`);
    const artifactSha256 = sha256(artifactPath);
    mode.backendObservation.artifact.sha256 = artifactSha256;
    mode.backendObservation.strictNativeBinding.artifactSha256 = artifactSha256;
  };
}

function createCandidateFixture(mutate, mutateEvidence) {
  return createFixture(({ adapter, gui, ready }) => {
    adapter.candidateBinding = {
      tgzRelativePath: "candidate-dsh-plugin-bash-wsl-0.2.0.tgz",
      expectedSha256: candidateTarballSha256,
      supplied: true,
      freshRequired: true,
      isCanonical: false,
      candidateIndependent: true,
    };
    adapter.sourceHashes = { ...candidateSourceHashes };
    adapter.cleanup = {
      ...adapter.cleanup,
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
      terminationAttempted: false,
      killAuthorizedByLineage: false,
      socketClosed: true,
      queueEnded: true,
    };
    gui.temporaryProfileCleanup = structuredClone(adapter.cleanup);
    const permissionEnvelope = (modeId) => {
      const preset = modeId === "bash-wsl"
        ? "workspace-write"
        : "danger-full-access";
      const transition = (value) => ({
        ack: {
          commandIdSha256: sha256Text(`offline-${modeId}-permission-${value}`),
          kind: "success",
          text: `preset ${value}`,
          sourceEventSeq: 7,
        },
        projection: { asOfSeq: 8, currentValue: value },
      });
      return {
        mode: preset,
        authorizationGranted: modeId === "bash-git-bash" ? true : null,
        authorizationInput: modeId === "bash-git-bash"
          ? "DSH_GUI_ALLOW_GIT_FULL_ACCESS=1"
          : null,
        authorizationSource: modeId === "bash-git-bash"
          ? "explicit-user-test-authorization"
          : null,
        authorizationScope: modeId === "bash-git-bash"
          ? "owned-gui-session"
          : null,
        command: {
          name: "permission",
          definitionId: "@deepseek-ai/dsh-permission-presets",
          inputHint: "<preset>",
        },
        workspaceWrite: transition("workspace-write"),
        fullAccess: modeId === "bash-git-bash"
          ? transition("danger-full-access")
          : null,
        prePromptProjection: { asOfSeq: 9, currentValue: preset },
      };
    };
    const nativeModeEnvelope = (modeId) => {
      const modeSessionIdSha256 = sha256Text(`offline-${modeId}-session`);
      const callIds = [1, 2].map((sequence) =>
        sha256Text(`offline-${modeId}-call-${sequence}`));
      const calls = [1, 2].map((sequence, index) => ({
        sequence,
        toolName: "bash",
        callIdSha256: callIds[index],
        resultCallIdSha256: callIds[index],
        accepted: true,
        completed: true,
        parsedExitCode: 0,
        isError: false,
        timedOut: false,
        aborted: false,
        outputMarker: [
          "DSH_GUI_TURN1:DSH_GUI_TURN1",
          "DSH_GUI_TURN2:DSH_GUI_TURN1",
        ][index],
      }));
      return {
        modeId,
        sessionIdSha256: modeSessionIdSha256,
        permission: permissionEnvelope(modeId),
        agentPresetBinding: {
          requested: modeId,
          sessionCreate: modeId,
          sessionHeader: modeId,
          sessionHeaderIdSha256: modeSessionIdSha256,
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
        rawArtifacts: {
          adapter: { kind: "session-summary", artifact: adapter.resultArtifact },
          observationReady: {
            kind: "observation-ready",
            artifact: adapter.observationArtifact,
          },
        },
        normalExit: { closeObserved: true, reaped: true, aliveAfter: false },
        cleanup: structuredClone(adapter.cleanup),
        backendCleanup: modeId === "bash-wsl"
          ? {
            kind: "wsl-public-session",
            source: "owned Linux ledger",
            observed: true,
            prepositive: { available: true, markerCount: 1 },
            postempty: { available: true, markerCount: 0 },
            creationIdentities: [],
            observationErrors: [],
          }
          : {
            kind: "native-process-tree",
            source: "owned Windows CIM Win32_Process CreationDate lineage",
            observed: true,
            prepositive: {
              available: true,
              verified: true,
              identities: [{ pid: 2001, creation: "offline-before" }],
            },
            postempty: {
              available: true,
              rootPresent: false,
              identities: [],
              remainingIdentityCount: 0,
            },
            creationIdentities: [{ pid: 2001, creation: "offline-before" }],
            observationErrors: [],
          },
      };
    };
    adapter.nativeModes = ["bash-wsl", "bash-git-bash"].map(nativeModeEnvelope);
  }, mutateEvidence, CANDIDATE_TARBALL, mutate);
}

function candidateOptions() {
  return {
    candidateMode: true,
    expectedTgzSha256: candidateTarballSha256,
    sourceHashes: candidateSourceHashes,
  };
}

function expectCandidateRejected(name, mutate, detailPattern) {
  pass(name, () => {
    const { evidence } = createCandidateFixture(mutate);
    const result = validateD16Evidence(evidence, CANDIDATE_TARBALL, candidateOptions());
    assert.equal(result.ok, false);
    if (detailPattern !== undefined) assert.match(result.detail, detailPattern);
  });
}

try {
    pass("synthetic structure accepted (not runtime evidence)", () => {
    const { evidence } = createFixture();
    const result = validateD16Evidence(evidence, TARBALL);
    assert.equal(result.ok, true);
    assert.equal(result.detail, "strict rc.3/TGZ/session/tool/UI/Windows+Linux cleanup evidence matched");
  });

  pass("fresh candidate D16 shape accepted (synthetic, not runtime evidence)", () => {
    const { evidence } = createCandidateFixture();
    const result = validateD16Evidence(evidence, CANDIDATE_TARBALL, candidateOptions());
    assert.equal(result.ok, true);
    assert.equal(result.detail, "strict rc.3/TGZ/session/tool/UI/Windows+Linux cleanup evidence matched");
  });
  expectCandidateRejected("candidate rejects direct false truePty", mutateGitNativePtyEvidence((evidence) => {
    evidence.truePty = false;
  }), /backend observation\/artifact/);
  expectCandidateRejected("candidate rejects missing direct truePty", mutateGitNativePtyEvidence((evidence) => {
    delete evidence.truePty;
  }), /backend observation\/artifact/);
  expectCandidateRejected("candidate rejects zero native PID", mutateGitNativePtyEvidence((evidence) => {
    evidence.nativePid = 0;
  }), /backend observation\/artifact/);
  expectCandidateRejected("candidate rejects false helper spawn observation", mutateGitNativePtyEvidence((evidence) => {
    evidence.helperSpawnObserved = false;
  }), /backend observation\/artifact/);
  expectCandidateRejected("candidate rejects nested-only native PTY evidence", mutateGitNativePtyEvidence((evidence) => {
    delete evidence.nativePid;
    delete evidence.truePty;
    delete evidence.helperSpawnObserved;
    evidence.nativePtyEvidence = {
      nativePid: 23340,
      truePty: true,
      helperSpawnObserved: true,
    };
  }), /backend observation\/artifact/);
  expectCandidateRejected("candidate protected-fixture cleanup requires the exact canonical TGZ", ({ gui }) => {
    gui.temporaryProfileCleanup.canonicalTgzAfterSha256 = "0".repeat(64);
  }, /temporary profile cleanup/);
  expectCandidateRejected("candidate protected-fixture cleanup requires all three contained entries", ({ gui }) => {
    gui.temporaryProfileCleanup.profileContainment.entries.pop();
  }, /temporary profile cleanup/);
  expectCandidateRejected("candidate protected-fixture cleanup rejects a transient-root claim", ({ gui }) => {
    gui.temporaryProfileCleanup.temporaryRootRemoved = true;
  }, /temporary profile cleanup/);
  expectCandidateRejected("candidate native WSL permission projection is required", ({ adapter }) => {
    delete adapter.nativeModes[0].permission.prePromptProjection;
  }, /permission acknowledgement\/projection/);
  expectCandidateRejected("candidate native Git authorization scope is required", ({ adapter }) => {
    adapter.nativeModes[1].permission.authorizationScope = "wrong-scope";
  }, /permission acknowledgement\/projection/);
  expectCandidateRejected("candidate native Git danger transition is required", ({ adapter }) => {
    adapter.nativeModes[1].permission.fullAccess.projection.currentValue = "workspace-write";
  }, /permission acknowledgement\/projection/);
  pass("independent Windows MCP GUI observation accepted (synthetic, not runtime evidence)", () => {
    const { evidence } = createFixture(({ gui }) => {
      gui.source = "mcp__windows_mcp";
    });
    const result = validateD16Evidence(evidence, TARBALL);
    assert.equal(result.ok, true);
    assert.equal(result.detail, "strict rc.3/TGZ/session/tool/UI/Windows+Linux cleanup evidence matched");
  });
  expectRejected("unknown GUI observation source is rejected", ({ gui }) => {
    gui.source = "unknown-gui-driver";
  }, undefined, /allowlisted GUI observation/);
  expectRejected("driver-labeled GUI observation source is rejected", ({ gui }) => {
    gui.source = "run-owned-gui-session-driver";
  }, undefined, /allowlisted GUI observation/);
  expectRejected("synthetic GUI observation source is rejected", ({ gui }) => {
    gui.source = "synthetic-fixture";
  }, undefined, /allowlisted GUI observation/);
  expectRejected("non-independent Windows MCP observation is rejected", ({ gui }) => {
    gui.source = "mcp__windows_mcp";
    gui.independent = false;
  }, undefined, /allowlisted GUI observation/);
  expectCandidateRejected("candidate cannot reuse the protected old TGZ", ({ adapter, gui, ready }) => {
    adapter.tgzSha256 = tarballSha256;
    gui.desktopIdentity.tgzSha256 = tarballSha256;
    ready.tgzSha256 = tarballSha256;
    adapter.candidateBinding = {
      tgzRelativePath: "dsh-plugin-bash-wsl-0.2.0.tgz",
      expectedSha256: tarballSha256,
      supplied: false,
      freshRequired: false,
      isCanonical: true,
      candidateIndependent: false,
    };
  }, /adapter TGZ SHA does not match this gate's fresh pack/);
  expectCandidateRejected("candidate must bind the current driver source", ({ adapter }) => {
    adapter.sourceHashes.probe = "0".repeat(64);
  }, /fresh GUI source hash mismatch: probe/);
  expectCandidateRejected("candidate driver raw hash ledger is required", ({ adapter }) => {
    delete adapter.sourceHashes;
  }, /fresh GUI driver source hash ledger/);
  expectCandidateRejected("candidate D16 must include both exact native mode envelopes", ({ adapter }) => {
    delete adapter.nativeModes;
  }, /candidate D16 nativeModes/);
  expectCandidateRejected("candidate D16 cannot use Standard as a native mode preset", ({ adapter }) => {
    adapter.nativeModes[0].agentPresetBinding.sessionCreate = "standard";
  }, /agentPresetBinding\/session header identity/);
  expectCandidateRejected("candidate D16 requires the real session header identity", ({ adapter }) => {
    delete adapter.nativeModes[0].agentPresetBinding.sessionHeaderIdSha256;
  }, /agentPresetBinding\/session header identity/);
  expectCandidateRejected("candidate D16 rejects synthetic raw-frame fields", ({ adapter }) => {
    adapter.nativeModes[0].rawFrames = [{ nonce: "forged" }];
  }, /synthetic header\/backend\/order\/raw-frame/);
  expectCandidateRejected("candidate D16 requires distinct call and result IDs", ({ adapter }) => {
    adapter.nativeModes[0].calls[1].callIdSha256 = adapter.nativeModes[0].calls[0].callIdSha256;
    adapter.nativeModes[0].calls[1].resultCallIdSha256 = adapter.nativeModes[0].calls[0].resultCallIdSha256;
  }, /call IDs are not unique/);
  expectCandidateRejected("candidate D16 requires contained raw artifacts", ({ adapter }) => {
    delete adapter.nativeModes[0].rawArtifacts;
  }, /raw artifact binding/);
  expectCandidateRejected("candidate D16 requires a turn and marker ledger", ({ adapter }) => {
    delete adapter.nativeModes[0].turnLedger;
  }, /turn\/marker ledger/);
  expectCandidateRejected("candidate D16 native Git cleanup cannot be generic", ({ adapter }) => {
    adapter.nativeModes[1].cleanup.lineageAfter.rootPresent = true;
  }, /owned Desktop cleanup/);
  expectCandidateRejected("candidate D16 requires hashed native backend evidence", ({ gui }) => {
    gui.nativeModes[0].backendObservation.artifact.sha256 = "0".repeat(64);
  }, /backend observation\/artifact/);
  expectCandidateRejected("candidate D16 rejects an arbitrary PASS backend artifact", ({ gui }) => {
    gui.nativeModes[0].backendObservation.artifact.sha256 = "0".repeat(64);
    gui.nativeModes[0].backendObservation.strictNativeBinding.accepted = false;
  }, /backend observation\/artifact|accepted current native probe/);
  expectCandidateRejected("candidate D16 binds the native probe and current Desktop hashes", ({ gui }) => {
    gui.nativeModes[1].backendObservation.strictNativeBinding.appAsarSha256 = "0".repeat(64);
  }, /accepted current native probe/);
  expectCandidateRejected("candidate D16 keeps GUI cleanup separate from native host facts", ({ gui }) => {
    delete gui.nativeModes[0].cleanup.guiProcessObservation;
    gui.nativeModes[0].cleanup.hostAliveAfterExit = true;
  }, /normal process cleanup/);
  expectCandidateRejected("candidate D16 requires per-backend GUI cleanup", ({ gui }) => {
    gui.nativeModes[1].cleanup.remaining.push({ pid: 99 });
  }, /backend-specific cleanup/);
  expectCandidateRejected("candidate cleanup must prove reaping", ({ adapter }) => {
    adapter.cleanup.reaped = false;
  }, /Windows child\/socket cleanup/);
  expectCandidateRejected("candidate normal GUI exit must be observed", ({ gui }) => {
    gui.normalGuiExit.reaped = false;
  }, /GUI normal exit\/reap/);

  expectRejected("outer FAIL is rejected", undefined, (evidence) => {
    evidence.status = "FAIL";
  }, /combined evidence must explicitly report PASS/);
  expectRejected("PREFLIGHT_PASS is rejected", undefined, (evidence) => {
    evidence.status = "PREFLIGHT_PASS";
  }, /combined evidence must explicitly report PASS/);
    expectRejected("adapter FAIL is rejected", ({ adapter }) => {
      adapter.status = "FAIL";
    }, undefined, /adapter status must be PASS/);
    expectRejected("follow preflight is rejected", ({ adapter }) => {
      adapter.followReady = false;
    }, undefined, /real turn/);
    expectRejected("invalid session SHA is rejected", ({ adapter }) => {
      adapter.sessionIdSha256 = "not-a-sha256";
    }, undefined, /owned session identity hash/);
  expectRejected("missing artifact binding is rejected", undefined, (evidence) => {
    delete evidence.artifactBindings.adapter;
  }, /adapter does not match/);
  expectRejected("artifact path escape is rejected", undefined, (evidence) => {
    evidence.artifactBindings.adapter.path = "README.md";
  }, /adapter does not match/);
  expectRejected("artifact hash mismatch is rejected", undefined, (evidence) => {
    evidence.artifactBindings.guiObservation.sha256 = "0".repeat(64);
  }, /GUI observation does not match/);
  expectRejected("observation-ready session mismatch is rejected", ({ ready }) => {
    ready.sessionIdSha256 = sha256Text("different-session");
  }, undefined, /observation-ready artifact is not bound/);
    expectRejected("observation-ready marker loss is rejected", ({ ready }) => {
      ready.markers.DSH_GUI_TURN2 = false;
    }, undefined, /observation-ready artifact is not bound/);
    expectRejected("observation-ready incomplete turn is rejected", ({ ready }) => {
      ready.turnEndKind = "aborted";
    }, undefined, /observation-ready artifact is not bound/);
  expectRejected("adapter protocol failure is rejected", ({ adapter }) => {
    adapter.protocolFailure = true;
  }, undefined, /adapter reports a protocol failure/);
  expectRejected("preflight adapter mode is rejected", ({ adapter }) => {
    adapter.mode = "preflight-only";
  }, undefined, /real turn/);
  expectRejected("duplicate callId hashes are rejected", ({ adapter }) => {
    adapter.toolCallIdsSha256 = [callHashes[0], callHashes[0]];
    adapter.toolResultCallIdsSha256 = [callHashes[0], callHashes[0]];
  }, undefined, /distinct callIds/);
  expectRejected("missing owner lineage is rejected", ({ gui }) => {
    gui.initialWindowsLineage.rootPresent = false;
  }, undefined, /independent Windows prepositive/);
  expectRejected("Windows residual identity is rejected", ({ adapter }) => {
    adapter.cleanup.lineageAfter.rootPresent = true;
  }, undefined, /Windows postempty/);
  expectRejected("Linux residual marker is rejected", ({ adapter }) => {
    adapter.cleanup.wslLedgerAfter.markerCount = 1;
  }, undefined, /Linux postempty/);
  expectRejected("missing GUI observation is rejected", undefined, (evidence) => {
    delete evidence.guiObservation;
  }, /GUI observation does not match/);
  expectRejected("visible system-prompt claim is rejected", ({ gui }) => {
    gui.systemPromptVisibility = "visible";
  }, undefined, /unverified prompt visibility/);
  expectRejected("wrong tool output is rejected", ({ gui }) => {
    gui.toolCards[0].outputMarker = "wrong marker";
  }, undefined, /real callId\/output marker/);
  expectRejected("wrong helper hash is rejected", ({ gui }) => {
    gui.helperSourceHashes.launcher = "0".repeat(64);
  }, undefined, /helper source hashes/);
} finally {
    assertFixtureRootSafe(fixtureRoot);
  rmSync(fixtureRoot, { recursive: true, force: true });
}

const failed = cases.filter((entry) => entry.status === "FAIL");
console.log(`Offline D16 validator regression: ${cases.length - failed.length} passed, ${failed.length} failed`);
if (failed.length > 0) process.exitCode = 1;
