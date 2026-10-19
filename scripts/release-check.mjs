#!/usr/bin/env node

/**
 * Local, non-publishing release gate for dsh-plugin-bash-wsl.
 *
 * The script deliberately does not invoke `npm publish`, `git push`, or mutate
 * a user's host profile. The temporary profile install is local and offline;
 * Desktop and CLI 0.2.1-rc.2 bundles resolve from the installed host, and every result is
 * reported as PASS/FAIL/SKIP.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { runNativeModesReleaseGate } from "../dev/测试/桌面/native-modes-release-gate.mjs";
import {
  buildGitNormalCloseGapFromBridge,
  extractGitNormalCloseGapBridge,
  KNOWN_GIT_NORMAL_CLOSE_GAP_ID,
  KNOWN_SESSION_DRIVER_SHA256,
} from "../dev/测试/桌面/git-normal-close-gap-evidence.mjs";

const root = resolve(import.meta.dirname, "..");
const packageJsonPath = join(root, "package.json");
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
const expectedName = "dsh-plugin-bash-wsl";
const expectedVersion = "0.2.2";
const expectedCliVersion = "0.2.1-rc.2";
const expectedSecurityModes = ["read-only", "workspace-write", "danger-full-access"];
const requiredSecurityCheckIds = [
  "SEC-01 WSL capability preflight",
  "SEC-02 sandbox mode write boundary",
  "SEC-03 external fixture write remains outside the restricted bind",
  "SEC-04 restricted WSL interop marker boundary",
  "SEC-05 symlink/junction escape is denied outside restricted workspace",
  "SEC-06 invalid workdir/path forms fail before command spawn",
  "SEC-06 official wsl_bash canonical cwd and zero-spawn boundary",
  "SEC-07 Git Bash restricted rejection starts zero children",
  "SEC-08 approval guard and official danger retry start zero children",
  "SEC-09 missing sandbox dependency fails closed",
  "SEC-10 timeout cancels and reaps a one-shot process tree",
  "SEC-11 caller cancellation aborts and reaps a one-shot process",
  "SEC-12 captured output is explicitly bounded",
  "SEC-13 owner isolation covers read/signal/close/dispose/natural exit",
  "SEC-14 live persistent mode mutation remains fail-closed",
  "SEC-15 WSL command framing and metadata special characters",
  "SEC-16 Git Bash timeout/cancellation reaping",
];
const requiredIntegrationIds = [
  "CLI-01 official services, version, and registration",
  "CLI-02 persistent cwd/environment/function state",
  "CLI-03 official wsl_bash tool executes",
  "CLI-03-SEAM executeWslBash helper",
  "CLI-04 official git_bash tool executes",
  "CLI-04-SEAM executeGitBash helper",
  "CLI-11 official wsl_bash canonical cwd and invalid path zero-spawn boundary",
  "CLI-13 registered Git Bash workspace-root cwd regression",
  "CLI-05 persistent cancellation followed by explicit reaping",
  "CLI-10 persistent timeout resets and next call is clean",
  "CLI-12 persistent output cap and next call remain usable",
  "CLI-06 concurrent persistent sends are serialized",
  "CLI-07 preserved PowerShell tool executes",
  "CLI-08 Windows doctor is read-only",
  "CLI-09 initialization cancellation sends zero commands",
];
const runOutputRoot = join(root, "测试", "运行产物");
const expectedDesktopAsarSha256 = "47874618bf5b3011fcaac10cd4c85f69da333e70d4f99b921207c78d0999512a";
const expectedDesktopExecutableSha256 = "9c789407850773ce7d914a3ec0476852bf1ceea69789d8ccf4e39be953f4bf52";
const d16SessionDriverPath = join(root, "dev", "测试", "桌面", "run-owned-gui-session.mjs");
const d16LauncherPath = join(root, "dev", "测试", "桌面", "run-owned-gui-session-wrapper.mjs");
const nativeModesDesktopProbePath = join(root, "dev", "测试", "桌面", "new-modes-desktop-artifact.mjs");
const d16GuiLauncherPath = join(root, "dev", "测试", "桌面", "launch-owned-gui.mjs");
const d16CandidateBindingPath = join(root, "dev", "测试", "桌面", "gui-candidate-binding.mjs");
const nativeModesValidatorRegressionPath = join(root, "dev", "测试", "桌面", "native-modes-release-validator.offline.test.mjs");
const gitNormalCloseGapRegressionPath = join(root, "dev", "测试", "桌面", "git-normal-close-gap-evidence.offline.test.mjs");
const nativeModesDesktopLifecycleRegressionPath = join(root, "dev", "测试", "桌面", "native-modes-desktop-cancel.offline.test.mjs");
const nativeModesRawObserverRegressionPath = join(root, "dev", "测试", "桌面", "new-modes-desktop-artifact.raw-observer.offline.test.mjs");
const nativePtyHelperContractPath = join(root, "dev", "测试", "单元", "pty-helper-failure-contract.test.mjs");
const packCliContractRegressionPath = join(root, "dev", "测试", "单元", "release-pack-cli-contract.test.mjs");
const windowsProcessObserverContractPath = join(root, "dev", "测试", "单元", "windows-process-observer.test.mjs");
const nativeTerminalQueryContractPath = join(root, "dev", "测试", "单元", "native-terminal-query-contract.test.mjs");
const desktopContextProbeIdentityRegressionPath = join(
  root,
  "dev",
  "测试",
  "桌面",
  "desktop-context-probe.identity.offline.test.mjs",
);
const outputCapGateRegressionPath = join(
  root,
  "dev",
  "测试",
  "桌面",
  "output-cap-gate.offline.test.mjs",
);
const d16GuiCheckIds = [
  "uniqueOwnedWindow",
  "pluginEnabled",
  "standardPresetVisible",
  "workspaceWriteVisible",
  "deepSeekModelVisible",
  "sessionCardVisible",
  "sessionHeaderVisible",
  "selectionAndHeaderMatch",
  "toolCardOneVisible",
  "toolCardTwoVisible",
  "outputOneVisible",
  "outputTwoVisible",
  "normalGuiExit",
  "temporaryProfileCleanup",
];
const sourceProbeIndexPath = join(root, "dev", "测试", "CLI", "probe-package", "index.mjs");
const sourceProbeIndexSha256 = existsSync(sourceProbeIndexPath)
  ? fileSha256(sourceProbeIndexPath)
  : undefined;
const sourceProbeObserverPath = join(root, "dev", "测试", "CLI", "probe-package", "windows-process-observer.mjs");
const sourceProbeObserverSha256 = existsSync(sourceProbeObserverPath)
  ? fileSha256(sourceProbeObserverPath)
  : undefined;
let selectedPackCli;
const results = [];
mkdirSync(runOutputRoot, { recursive: true });
const temporary = mkdtempSync(join(runOutputRoot, "release-check-"));
const dshHome = join(temporary, "dsh-home");
const isolatedNpmrc = join(temporary, "npmrc");
const dshProfileName = "release-check-cli";
const dshProfileDir = join(dshHome, "profiles", dshProfileName);
mkdirSync(dshProfileDir, { recursive: true });
writeFileSync(isolatedNpmrc, "# isolated release gate; no credentials or registry overrides\n");
assertTemporaryContainment();

function record(label, status, detail = "") {
  results.push({ label, status, detail });
  const suffix = detail ? ` — ${detail.replace(/\s+/g, " ").slice(0, 240)}` : "";
  console.log(`${status.padEnd(5)} ${label}${suffix}`);
}

function commandPath(name) {
  const bin = join(root, "node_modules", ".bin", name);
  const candidates = process.platform === "win32" ? [`${bin}.cmd`, `${bin}.exe`] : [bin];
  return candidates.find((candidate) => existsSync(candidate));
}

function isWindowsShim(executable) {
  return process.platform === "win32" && /\.(?:cmd|bat)$/i.test(executable);
}

function directNodeScript(executable) {
  if (process.platform !== "win32" || typeof executable !== "string") return undefined;
  const normalized = executable.replaceAll("\\", "/").toLowerCase();
  if (selectedPackCli?.path !== undefined
    && normalized === selectedPackCli.path.replaceAll("\\", "/").toLowerCase()) {
    return executable;
  }
  if (normalized.endsWith("/node_modules/.bin/tsc.cmd")) {
    return join(root, "node_modules", "typescript", "bin", "tsc");
  }
  if (normalized.endsWith("/node_modules/.bin/vitest.cmd")) {
    return join(root, "node_modules", "vitest", "vitest.mjs");
  }
  if (normalized.endsWith("/node_modules/npm/bin/npm-cli.js")) return executable;
  return undefined;
}

function quoteCmdArg(value) {
  if (/^[A-Za-z0-9_./\\:=+-]+$/.test(value)) return value;
  if (/[\r\n\0]/.test(value)) throw new Error("release-check: invalid command argument");
  return `"${value.replace(/(["^])/g, "^$1").replace(/%/g, "^%")}"`;
}

function isolatedEnvironment(overrides = {}) {
  const filtered = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !/^(?:(?:DSH_|DEEPSEEK_|OPENAI_|ANTHROPIC_|AWS_|GITHUB_).*$|.*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PRIVATE[_-]?KEY))$/i.test(name),
  ));
  return {
    ...filtered,
    HOME: temporary,
    TEMP: temporary,
    TMP: temporary,
    TMPDIR: temporary,
    NPM_CONFIG_USERCONFIG: isolatedNpmrc,
    npm_config_userconfig: isolatedNpmrc,
    NPM_CONFIG_UPDATE_NOTIFIER: "false",
    npm_config_update_notifier: "false",
    DSH_TELEMETRY_DISABLED: "1",
    DSH_TELEMETRY_MODE: "DISABLED",
    ...overrides,
  };
}

function cleanupSpawnTree(result) {
  if (process.platform !== "win32" || result?.error?.code !== "ETIMEDOUT") return undefined;
  const pid = result.pid;
  if (!Number.isInteger(pid) || pid <= 0) return { attempted: false, reaped: false, reason: "timed-out child PID was unavailable" };
  const listPid = () => spawnSync("tasklist.exe", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], {
    encoding: "utf8",
    timeout: 15_000,
    windowsHide: true,
  });
  const listed = (listing) => new RegExp(`[,\\"]${pid}[,\\"]`).test(`${listing?.stdout ?? ""}${listing?.stderr ?? ""}`);
  const parentAliveBeforeKill = listed(listPid());
  // A PID observed after a synchronous timeout is not an identity proof: it
  // may already have been reused by an unrelated Windows process. Never use
  // PID-only taskkill here. The caller must inspect the owned test root's
  // command line, creation time, and parent lineage before precise cleanup;
  // this result deliberately keeps the release gate failing.
  return {
    attempted: false,
    pid,
    parentAliveBeforeKill,
    closeObserved: false,
    treeTerminationProven: false,
    reaped: false,
    reason: parentAliveBeforeKill
      ? "timed-out child PID was present, but ownership identity was not proven; refusing PID-only taskkill"
      : "timed-out child PID was already absent, but ownership and descendant reaping were not proven",
  };
}

function run(label, executable, args, options = {}) {
  const windowsShim = isWindowsShim(executable);
  const nodeScript = directNodeScript(executable);
  const acceptedExitCodes = options.acceptExitCodes ?? [0];
  const result = spawnSync(
    nodeScript !== undefined ? process.execPath : windowsShim ? process.env.ComSpec ?? "cmd.exe" : executable,
    nodeScript !== undefined
      ? [nodeScript, ...args]
      : windowsShim
        ? ["/d", "/s", "/c", [executable, ...args].map(quoteCmdArg).join(" ")]
        : args,
    {
    cwd: options.cwd ?? root,
    env: isolatedEnvironment(options.env ?? {}),
    encoding: "utf8",
    timeout: options.timeout ?? 180_000,
    windowsHide: true,
    },
  );
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  const cleanup = cleanupSpawnTree(result);
  if (result.error || !acceptedExitCodes.includes(result.status)) {
    const detail = cleanup?.reaped === false
      ? `${result.error?.message ?? `exit ${result.status}`}; timed-out child cleanup was not proven reaped`
      : result.error?.message ?? (output || `exit ${result.status}`);
    const missingWindowsShim = options.skipIfMissing && windowsShim && /(?:not recognized|不是内部或外部命令|cannot find|找不到指定文件)/i.test(output);
    if (options.skipIfMissing && (result.error?.code === "ENOENT" || missingWindowsShim)) skip(label, "DSH executable is unavailable in this host; this is not a pass");
    else record(label, "FAIL", detail);
    return { ok: false, output, result, cleanup };
  }
  if (options.skipOutputPattern instanceof RegExp && options.skipOutputPattern.test(output)) {
    skip(label, options.skipOutputDetail ?? "the standalone contract reported SKIP; skipped checks are not passes");
    return { ok: false, output, result, cleanup };
  }
  const skippedCount = options.failOnSkipped
    ? [...output.matchAll(/(?:^|\s)(\d+)\s+(?:skipped|pending|todo)\b/gi)].reduce((sum, match) => sum + Number(match[1]), 0)
    : 0;
  if (skippedCount > 0) record(label, "SKIP", `${skippedCount} test cases were skipped/pending; skipped tests are not passes`);
  else record(label, "PASS", output);
  return { ok: true, output, result, cleanup };
}

function skip(label, reason) {
  record(label, "SKIP", reason);
}

function runNativeStandaloneContractChecks(build) {
  const windowsObserverLabel = "standalone Windows process observer contract";
  if (!existsSync(windowsProcessObserverContractPath)) {
    record(windowsObserverLabel, "FAIL", "dev/测试/单元/windows-process-observer.test.mjs is missing");
  } else {
    // Keep this parser/identity contract as a release-gate subprocess.  It is
    // intentionally not hidden inside the Vitest glob, so the gate cannot
    // report a green unit suite while the Windows CIM observer contract is
    // absent from the standalone checks.
    run(windowsObserverLabel, process.execPath, [windowsProcessObserverContractPath], {
      cwd: root,
      timeout: 120_000,
      skipOutputPattern: /^\s*SKIP(?:\s|$)/im,
      skipOutputDetail: "Windows process observer contract reported SKIP; parser/identity assertions are not a pass",
    });
  }

  const validatorLabel = "standalone native-mode validator regression";
  if (!existsSync(nativeModesValidatorRegressionPath)) {
    record(validatorLabel, "FAIL", "dev/测试/桌面/native-modes-release-validator.offline.test.mjs is missing");
  } else {
    run(validatorLabel, process.execPath, [nativeModesValidatorRegressionPath], {
      cwd: root,
      timeout: 120_000,
      skipOutputPattern: /^\s*SKIP(?:\s|$)/im,
      skipOutputDetail: "native-mode validator reported SKIP; its 33-case regression is not a pass",
    });
  }

  const gitGapLabel = "standalone Git normal-close gap regression";
  if (!existsSync(gitNormalCloseGapRegressionPath)) {
    record(gitGapLabel, "FAIL", "dev/测试/桌面/git-normal-close-gap-evidence.offline.test.mjs is missing");
  } else {
    run(gitGapLabel, process.execPath, [gitNormalCloseGapRegressionPath], {
      cwd: root,
      timeout: 120_000,
      skipOutputPattern: /^\s*SKIP(?:\s|$)/im,
      skipOutputDetail: "Git normal-close gap regression reported SKIP; strict supplement assertions are not a pass",
    });
  }

  const desktopLifecycleLabel = "standalone Desktop native lifecycle validator regression";
  if (!existsSync(nativeModesDesktopLifecycleRegressionPath)) {
    record(desktopLifecycleLabel, "FAIL", "dev/测试/桌面/native-modes-desktop-cancel.offline.test.mjs is missing");
  } else {
    run(desktopLifecycleLabel, process.execPath, [nativeModesDesktopLifecycleRegressionPath], {
      cwd: root,
      timeout: 120_000,
      skipOutputPattern: /^\s*SKIP(?:\s|$)/im,
      skipOutputDetail: "Desktop lifecycle validator reported SKIP; synthetic schema regressions are not a pass",
    });
  }

  const rawObserverLabel = "standalone Desktop raw observer regression";
  if (!existsSync(nativeModesRawObserverRegressionPath)) {
    record(rawObserverLabel, "FAIL", "dev/测试/桌面/new-modes-desktop-artifact.raw-observer.offline.test.mjs is missing");
  } else {
    run(rawObserverLabel, process.execPath, [nativeModesRawObserverRegressionPath], {
      cwd: root,
      timeout: 120_000,
      skipOutputPattern: /^\s*SKIP(?:\s|$)/im,
      skipOutputDetail: "Desktop raw observer regression reported SKIP; parser/readiness assertions are not a pass",
    });
  }

  const nativeTerminalQueryLabel = "standalone native terminal query contract";
  if (!existsSync(nativeTerminalQueryContractPath)) {
    record(nativeTerminalQueryLabel, "FAIL", "dev/测试/单元/native-terminal-query-contract.test.mjs is missing");
  } else {
    run(nativeTerminalQueryLabel, process.execPath, [nativeTerminalQueryContractPath], {
      cwd: root,
      timeout: 120_000,
      skipOutputPattern: /^\s*SKIP(?:\s|$)/im,
      skipOutputDetail: "native terminal query contract reported SKIP; query prerequisite assertions are not a pass",
    });
  }

  const desktopContextProbeIdentityLabel = "standalone Desktop context probe identity regression";
  if (!existsSync(desktopContextProbeIdentityRegressionPath)) {
    record(
      desktopContextProbeIdentityLabel,
      "FAIL",
      "dev/测试/桌面/desktop-context-probe.identity.offline.test.mjs is missing",
    );
  } else {
    run(
      desktopContextProbeIdentityLabel,
      process.execPath,
      [desktopContextProbeIdentityRegressionPath],
      {
        cwd: root,
        timeout: 120_000,
        skipOutputPattern: /^\s*SKIP(?:\s|$)/im,
        skipOutputDetail: "Desktop context probe identity regression reported SKIP; observer identity assertions are not a pass",
      },
    );
  }

  const helperLabel = "standalone native PTY helper fault contract";
  if (process.platform !== "win32") {
    skip(helperLabel, "requires Windows Node and the Windows helper runtime; WSL/Linux capability is not a pass");
  } else if (!build.ok) {
    record(helperLabel, "FAIL", "formal clean build did not pass; the current dist helper was not executed");
  } else if (!existsSync(join(root, "dist", "git", "pty-helper.js"))) {
    record(helperLabel, "FAIL", "formal clean build produced no dist/git/pty-helper.js");
  } else if (!existsSync(nativePtyHelperContractPath)) {
    record(helperLabel, "FAIL", "dev/测试/单元/pty-helper-failure-contract.test.mjs is missing");
  } else {
    run(helperLabel, process.execPath, [nativePtyHelperContractPath], {
      cwd: root,
      timeout: 120_000,
      skipOutputPattern: /^\s*SKIP(?:\s|$)/im,
      skipOutputDetail: "native PTY helper contract reported SKIP; its 9-case Windows regression is not a pass",
    });
  }

  const outputCapGateLabel = "standalone output-cap gate offline regression";
  if (!existsSync(outputCapGateRegressionPath)) {
    record(outputCapGateLabel, "FAIL", "dev/测试/桌面/output-cap-gate.offline.test.mjs is missing");
  } else {
    run(outputCapGateLabel, process.execPath, [outputCapGateRegressionPath], {
      cwd: root,
      timeout: 120_000,
      skipOutputPattern: /^\s*SKIP(?:\s|$)/im,
      skipOutputDetail: "output-cap gate offline regression reported SKIP; strict evidence assertions are not a pass",
    });
  }
}

function runPackCliContractRegression() {
  const label = "standalone pack CLI negative contract";
  if (!existsSync(packCliContractRegressionPath)) {
    record(label, "FAIL", "dev/测试/单元/release-pack-cli-contract.test.mjs is missing");
    return;
  }
  run(label, process.execPath, [packCliContractRegressionPath], {
    cwd: root,
    timeout: 120_000,
    // The pack contract prefixes capability skips with its own label.  Keep
    // this narrower than /\bSKIP\b/ so a test line such as
    // `PASS SKIP mandatory nested case` cannot downgrade a passing check.
    skipOutputPattern: /^\s*(?:SKIP(?:\s|$)|PACK_CLI_CONTRACT\s+SKIP(?:\s|$))/im,
    skipOutputDetail: "pack CLI negative contract requires Windows Node; SKIP is not a pass",
  });
}

function fileSha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function isSha256(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/i.test(value);
}

function actualCliManifestPath() {
  const configured = process.env.DSH_WINDOWS_CLI_PACKAGE;
  const userProfile = process.env.USERPROFILE;
  const defaultPath = /^[A-Za-z]:[\\/]/.test(String(userProfile ?? ""))
    ? join(userProfile, "AppData", "Roaming", "npm", "node_modules", "@deepseek-ai", "dsh", "package.json")
    : undefined;
  return [configured, defaultPath]
    .filter((path) => typeof path === "string" && path.length > 0)
    .find((path) => existsSync(path));
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function wslMergedStderrCapEvidenceIsStrict(value) {
  return isRecord(value)
    && value.tool === "wsl_bash"
    && value.mode === "workspace-write"
    && value.stream === "stderr"
    && value.sentStream === "stderr"
    && value.capturedStream === "stdout"
    && value.ptyMergingObserved === true
    && value.command === "printf '\\377\\377\\377\\377' >&2"
    && value.requestedRawBytes === 4
    && value.sentRawBytes === 4
    && value.configuredVisibleCapBytes === 4
    && value.exitCode === 0
    && value.truncated === true
    && typeof value.output === "string"
    && value.output.length > 0
    && Number.isInteger(value.visibleBytes)
    && value.visibleBytes >= 0
    && value.visibleBytes <= 4
    && value.visibleBytes === Buffer.byteLength(value.output ?? "", "utf8")
    && Number.isInteger(value.replacementCount)
    && value.replacementCount > 0
    && value.replacementCount === (value.output.match(/\uFFFD/g) ?? []).length
    && value.officialToolRuntime === true;
}

function sameStringArray(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
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

function nativeModePermissionIsStrict(permission, modeId) {
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

function reusedProtectedFixtureCleanupIsStrict(cleanup) {
  const canonicalTgzSha256 =
    "9cb01907dd7a9558255b6b8d5fe5ef03349927711fef0aadf9456656fe2b6f63";
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
    && cleanup.canonicalTgzSha256 === canonicalTgzSha256
    && cleanup.canonicalTgzBeforeSha256 === canonicalTgzSha256
    && cleanup.canonicalTgzAfterSha256 === canonicalTgzSha256;
}

function validateNativeGuiModeEnvelope(envelope, require) {
  const expectedModes = ["bash-wsl", "bash-git-bash"];
  const expectedMarkers = [
    "DSH_GUI_TURN1:DSH_GUI_TURN1",
    "DSH_GUI_TURN2:DSH_GUI_TURN1",
  ];
  require(Array.isArray(envelope) && envelope.length === expectedModes.length,
    "candidate D16 nativeModes must contain exactly bash-wsl and bash-git-bash");
  const byId = new Map((Array.isArray(envelope) ? envelope : [])
    .map((mode) => [mode?.modeId, mode]));
  require(byId.size === expectedModes.length,
    "candidate D16 nativeModes must have unique modeId values");
  for (const modeId of expectedModes) {
    const mode = byId.get(modeId);
    require(isRecord(mode), `candidate D16 ${modeId} envelope is missing`);
    require(!Object.hasOwn(mode ?? {}, "header")
      && !Object.hasOwn(mode ?? {}, "backendType")
      && !Object.hasOwn(mode ?? {}, "serialOrder")
      && !Object.hasOwn(mode ?? {}, "rawFrames"),
    `candidate D16 ${modeId} must not use synthetic header/backend/order/raw-frame fields`);
    const binding = mode?.agentPresetBinding;
    require(isSha256(mode?.sessionIdSha256)
      && isRecord(binding)
      && binding.requested === modeId
      && binding.sessionCreate === modeId
      && binding.sessionHeader === modeId
      && binding.exact === true
      && isSha256(binding.sessionHeaderIdSha256)
      && binding.sessionHeaderIdSha256 === mode.sessionIdSha256,
    `candidate D16 ${modeId} agentPresetBinding/session header identity is incomplete`);
    require(nativeModePermissionIsStrict(mode?.permission, modeId),
      `candidate D16 ${modeId} permission acknowledgement/projection is incomplete`);
    const calls = mode?.calls;
    require(Array.isArray(calls) && calls.length === 2,
      `candidate D16 ${modeId} must contain exactly two serial calls`);
    const callIds = [];
    const resultIds = [];
    for (const [index, call] of (Array.isArray(calls) ? calls : []).entries()) {
      callIds.push(call?.callIdSha256);
      resultIds.push(call?.resultCallIdSha256);
      require(call?.sequence === index + 1
        && call?.toolName === "bash"
        && call?.accepted === true
        && call?.completed === true
        && call?.parsedExitCode === 0
        && call?.isError === false
        && call?.timedOut === false
        && call?.aborted === false
        && call?.outputMarker === expectedMarkers[index]
        && isSha256(call?.callIdSha256)
        && call?.callIdSha256 === call?.resultCallIdSha256,
      `candidate D16 ${modeId} call ${index + 1} is not an exact successful bash call`);
    }
    require(new Set(callIds).size === 2,
      `candidate D16 ${modeId} call IDs are not unique`);
    require(sameStringArray(callIds, resultIds),
      `candidate D16 ${modeId} result IDs do not match call IDs in order`);
    require(Array.isArray(mode?.callOrder)
      && mode.callOrder.length === 2
      && mode.callOrder.every((entry, index) => entry?.sequence === index + 1
        && entry?.callIdSha256 === callIds[index]
        && entry?.resultCallIdSha256 === resultIds[index]),
    `candidate D16 ${modeId} call/result order ledger is incomplete`);
    const ledger = mode?.turnLedger;
    require(isRecord(ledger)
      && ledger.turnStarts === 1
      && ledger.turnEnded === true
      && ledger.turnEndKind === "completed"
      && ledger.toolCalls === 2
      && ledger.toolResults === 2
      && ledger.toolErrors === 0
      && ledger.markers?.DSH_GUI_TURN1 === true
      && ledger.markers?.DSH_GUI_TURN2 === true,
    `candidate D16 ${modeId} turn/marker ledger is incomplete`);
    require(isRecord(mode?.rawArtifacts)
      && isRecord(mode.rawArtifacts.adapter)
      && typeof mode.rawArtifacts.adapter.artifact === "string"
      && isRecord(mode.rawArtifacts.observationReady)
      && typeof mode.rawArtifacts.observationReady.artifact === "string",
    `candidate D16 ${modeId} raw artifact binding is incomplete`);
    require(mode?.normalExit?.closeObserved === true
      && mode?.normalExit?.reaped === true
      && mode?.normalExit?.aliveAfter === false,
    `candidate D16 ${modeId} normal exit/reap is incomplete`);
    const backendCleanup = mode?.backendCleanup;
    const processIdentity = (value) => isRecord(value)
      && Number.isInteger(value.pid)
      && value.pid > 0
      && typeof value.creation === "string"
      && value.creation.length > 0;
    if (modeId === "bash-wsl") {
      require(isRecord(backendCleanup)
        && backendCleanup.kind === "wsl-public-session"
        && backendCleanup.observed === true
        && backendCleanup.prepositive?.available === true
        && Number.isInteger(backendCleanup.prepositive.markerCount)
        && backendCleanup.prepositive.markerCount > 0
        && backendCleanup.postempty?.available === true
        && backendCleanup.postempty.markerCount === 0
        && Array.isArray(backendCleanup.creationIdentities)
        && backendCleanup.creationIdentities.length === 0
        && Array.isArray(backendCleanup.observationErrors)
        && backendCleanup.observationErrors.length === 0,
      `candidate D16 ${modeId} must carry the real WSL prepositive/postempty ledger`);
    } else {
      require(isRecord(backendCleanup)
        && backendCleanup.kind === "native-process-tree"
        && backendCleanup.observed === true
        && backendCleanup.prepositive?.available === true
        && backendCleanup.prepositive.verified === true
        && Array.isArray(backendCleanup.prepositive.identities)
        && backendCleanup.prepositive.identities.length > 0
        && backendCleanup.prepositive.identities.every(processIdentity)
        && backendCleanup.postempty?.available === true
        && backendCleanup.postempty.rootPresent === false
        && Array.isArray(backendCleanup.postempty.identities)
        && backendCleanup.postempty.identities.length === 0
        && backendCleanup.postempty.remainingIdentityCount === 0
        && Array.isArray(backendCleanup.creationIdentities)
        && backendCleanup.creationIdentities.length > 0
        && backendCleanup.creationIdentities.every(processIdentity)
        && Array.isArray(backendCleanup.observationErrors)
        && backendCleanup.observationErrors.length === 0,
      `candidate D16 ${modeId} must carry the real Windows CIM CreationDate lineage`);
    }
    const cleanup = mode?.cleanup;
    require(isRecord(cleanup)
      && cleanup.childClosed === true
      && cleanup.socketClosed === true
      && cleanup.queueEnded === true
      && cleanup.reaped === true
      && cleanup.lineageAfter?.available === true
      && cleanup.lineageAfter.rootPresent === false
      && Array.isArray(cleanup.lineageAfter.identities)
      && cleanup.lineageAfter.identities.length === 0
      && cleanup.lineageAfter.remainingIdentityCount === 0
      && cleanup.lineageAfter.markerProcessCount === 0,
    `candidate D16 ${modeId} owned Desktop cleanup is incomplete`);
  }
}

function readD16EvidenceArgument() {
  const positions = process.argv
    .map((value, index) => value === "--gui-evidence" ? index : -1)
    .filter((index) => index >= 0);
  if (positions.length === 0) return { kind: "missing" };
  if (positions.length !== 1) {
    return { kind: "invalid", detail: "--gui-evidence must be supplied once" };
  }
  const rawPath = process.argv[positions[0] + 1];
  if (typeof rawPath !== "string" || rawPath.length === 0 || rawPath.startsWith("--")) {
    return { kind: "invalid", detail: "--gui-evidence requires a JSON path" };
  }
  const candidatePath = resolve(root, rawPath);
  if (!existsSync(candidatePath)) {
    return { kind: "invalid", detail: "the requested GUI evidence file does not exist" };
  }
  let path;
  let outputRoot;
  try {
    path = realpathSync(candidatePath);
    outputRoot = realpathSync(runOutputRoot);
  } catch (error) {
    return { kind: "invalid", detail: `GUI evidence path could not be resolved: ${error.message}` };
  }
  const relativePath = relative(outputRoot, path);
  const escaped = relativePath === ".."
    || relativePath.startsWith(`..${path.includes("\\") ? "\\" : "/"}`)
    || isAbsolute(relativePath);
  if (relativePath.length === 0 || escaped) {
    return { kind: "invalid", detail: "GUI evidence must be inside 测试/运行产物" };
  }
  try {
    return {
      kind: "present",
      path: relative(root, path).replaceAll("\\", "/"),
      evidence: JSON.parse(readFileSync(path, "utf8")),
    };
  } catch (error) {
    return { kind: "invalid", detail: `GUI evidence JSON could not be read: ${error.message}` };
  }
}

function readOwnedArtifactArgument(flag, extension, label) {
  const positions = process.argv
    .map((value, index) => value === flag ? index : -1)
    .filter((index) => index >= 0);
  if (positions.length === 0) return { kind: "missing" };
  if (positions.length !== 1) {
    return { kind: "invalid", detail: `${flag} must be supplied once` };
  }
  const rawPath = process.argv[positions[0] + 1];
  if (typeof rawPath !== "string" || rawPath.length === 0 || rawPath.startsWith("--")) {
    return { kind: "invalid", detail: `${flag} requires a ${label} path` };
  }
  const candidatePath = resolve(root, rawPath);
  if (!existsSync(candidatePath)) {
    return { kind: "invalid", detail: `the requested ${label} does not exist` };
  }
  let path;
  let outputRoot;
  try {
    path = realpathSync(candidatePath);
    outputRoot = realpathSync(runOutputRoot);
  } catch (error) {
    return { kind: "invalid", detail: `${label} path could not be resolved: ${error.message}` };
  }
  const relativePath = relative(outputRoot, path);
  const escaped = relativePath === ".."
    || relativePath.startsWith(`..${path.includes("\\") ? "\\" : "/"}`)
    || isAbsolute(relativePath);
  if (relativePath.length === 0 || escaped) {
    return { kind: "invalid", detail: `${label} must be inside 测试/运行产物` };
  }
  if (extension !== undefined && extname(path).toLowerCase() !== extension) {
    return { kind: "invalid", detail: `${label} must use ${extension}` };
  }
  return {
    kind: "present",
    path,
    relativePath: relativePath.replaceAll("\\", "/"),
  };
}

function readPackCliArgument() {
  const positions = process.argv
    .map((value, index) => value === "--pack-cli" ? index : -1)
    .filter((index) => index >= 0);
  if (positions.length === 0) return { kind: "missing" };
  if (positions.length !== 1) {
    return { kind: "invalid", detail: "--pack-cli must be supplied once" };
  }
  if (process.platform !== "win32") {
    return { kind: "invalid", detail: "--pack-cli requires Windows Node" };
  }
  const rawPath = process.argv[positions[0] + 1];
  if (typeof rawPath !== "string" || rawPath.length === 0 || rawPath.startsWith("--")) {
    return { kind: "invalid", detail: "--pack-cli requires an absolute pnpm.mjs path" };
  }
  if (!isAbsolute(rawPath)) {
    return { kind: "invalid", detail: "--pack-cli requires an absolute Windows path" };
  }
  let scriptPath;
  try {
    scriptPath = realpathSync(rawPath);
  } catch (error) {
    return { kind: "invalid", detail: `--pack-cli path could not be resolved: ${error.message}` };
  }
  if (!lstatSync(scriptPath).isFile()
    || scriptPath.split(/[\\/]/).at(-1)?.toLowerCase() !== "pnpm.mjs") {
    return { kind: "invalid", detail: "--pack-cli must point to a regular pnpm.mjs file" };
  }
  const packageManager = /^([a-z0-9_-]+)@([0-9]+\.[0-9]+\.[0-9]+)$/.exec(
    String(packageJson.packageManager ?? ""),
  );
  if (packageManager === null || packageManager[1] !== "pnpm") {
    return { kind: "invalid", detail: "project packageManager must be an exact pnpm@x.y.z declaration" };
  }
  const packagePath = join(dirname(dirname(scriptPath)), "package.json");
  if (!existsSync(packagePath)) {
    return { kind: "invalid", detail: "--pack-cli adjacent pnpm package.json is missing" };
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(packagePath, "utf8"));
  } catch (error) {
    return { kind: "invalid", detail: `--pack-cli adjacent package.json is invalid: ${error.message}` };
  }
  if (manifest?.name !== packageManager[1]) {
    return { kind: "invalid", detail: `--pack-cli package name must be pnpm, received ${String(manifest?.name ?? "missing")}` };
  }
  if (manifest?.version !== packageManager[2]) {
    return { kind: "invalid", detail: `--pack-cli version must equal ${packageManager[2]}, received ${String(manifest?.version ?? "missing")}` };
  }
  return {
    kind: "present",
    path: scriptPath,
    packagePath,
    name: manifest.name,
    version: manifest.version,
  };
}

class ReleaseCheckInputError extends Error {
  constructor(detail) {
    super(detail);
    this.code = "RELEASE_CHECK_INPUT";
  }
}

function validateD16GitNormalCloseGap(evidence, adapter, options, require) {
  const gitMode = Array.isArray(adapter?.nativeModes)
    ? adapter.nativeModes.find((mode) => mode?.modeId === "bash-git-bash")
    : undefined;
  const bridge = extractGitNormalCloseGapBridge(evidence);
  const aggregateQualification = evidence?.nativeModeQualification
    ?? adapter?.nativeModeQualification;
  const needsKnownGap = gitMode?.rawDriverStatus === "FAIL"
    || gitMode?.qualificationStatus === "QUALIFIED_KNOWN_GAP"
    || gitMode?.gapId === KNOWN_GIT_NORMAL_CLOSE_GAP_ID
    || aggregateQualification !== undefined
    || bridge !== undefined;
  if (!needsKnownGap) return;
  require(isRecord(bridge),
    "Git raw FAIL aggregate is missing the five-proof known-gap bridge");
  let derived;
  try {
    derived = buildGitNormalCloseGapFromBridge(bridge, {
      root,
      runOutputRoot,
      modeId: "bash-git-bash",
      fixture: adapter.fixture,
      runtime: adapter.runtime,
      provider: adapter.provider,
      model: adapter.model,
      candidateSha256: options.expectedTgzSha256,
      appAsarSha256: options.expectedDesktopAsarSha256,
      sourceHashes: options.sourceHashes,
    });
  } catch (error) {
    require(false, `Git known-gap five-proof recomputation failed: ${error.message}`);
    return;
  }
  require(derived.rawDriverStatus === "FAIL"
    && derived.gapId === KNOWN_GIT_NORMAL_CLOSE_GAP_ID
    && derived.sourceHashes.sessionDriver === KNOWN_SESSION_DRIVER_SHA256,
  "Git known-gap recomputation did not preserve the reviewed raw FAIL/driver binding");
  require(bridge.status === undefined || bridge.status === "QUALIFIED_KNOWN_GAP",
    "Git known-gap bridge status disagrees with recomputation");
  require(bridge.rawDriverStatus === undefined || bridge.rawDriverStatus === "FAIL",
    "Git known-gap bridge raw status does not preserve FAIL");
  require(bridge.gapId === undefined || bridge.gapId === derived.gapId,
    "Git known-gap bridge gapId disagrees with recomputation");
  require(isRecord(gitMode)
    && sameStableJson(gitMode, derived.derivedNativeMode),
  "aggregate Git mode does not match the recomputed qualified native mode");
  const rawProof = derived.qualification.inputArtifacts.rawDriver;
  const rawBinding = bridge.bindings?.rawDriver;
  const normalizePath = (value) => String(value).replaceAll("\\", "/");
  require(isRecord(rawBinding)
    && normalizePath(rawBinding.path) === normalizePath(rawProof.path)
    && rawBinding.sha256 === rawProof.sha256,
  "Git known-gap raw proof path/SHA is not bound to the recomputed raw artifact");
  require(aggregateQualification?.status === "AGGREGATE_QUALIFIED"
    && aggregateQualification.rawDriverStatus === "FAIL"
    && aggregateQualification.independentSupplementStatus === "QUALIFIED_KNOWN_GAP",
  "aggregate qualification status is missing or was not computed from the supplement");
}

function validateD16Evidence(evidence, tarball, options = {}) {
  const failures = [];
  const require = (condition, detail) => {
    if (!condition) failures.push(detail);
  };
  const packedTgzSha256 = tarball !== undefined && existsSync(tarball)
    ? fileSha256(tarball)
    : undefined;
  const candidateMode = options.candidateMode === true;
  const expectedTgzSha256 = options.expectedTgzSha256 ?? packedTgzSha256;
  const expectedSourceHashes = isRecord(options.sourceHashes)
    ? options.sourceHashes
    : {};
  const desktopPaths = installedDesktopPathsForGate();
  const actualAsarSha256 = desktopPaths !== undefined && existsSync(desktopPaths.asar)
    ? fileSha256(desktopPaths.asar)
    : undefined;
  const actualExecutableSha256 = desktopPaths !== undefined && existsSync(desktopPaths.executable)
    ? fileSha256(desktopPaths.executable)
    : undefined;
  const launcherSourceSha256 = existsSync(d16LauncherPath) ? fileSha256(d16LauncherPath) : undefined;
  const sessionDriverSourceSha256 = existsSync(d16SessionDriverPath)
    ? fileSha256(d16SessionDriverPath)
    : undefined;
  const adapter = isRecord(evidence?.adapter) ? evidence.adapter : {};
  const gui = evidence?.guiObservation;
  const callHashes = adapter.toolCallIdsSha256;
  const resultHashes = adapter.toolResultCallIdsSha256;

  validateD16GitNormalCloseGap(evidence, adapter, options, require);

  require(isRecord(evidence), "evidence must be a JSON object");
  require(evidence?.schemaVersion === 1 && evidence?.status === "PASS",
    "combined evidence must explicitly report PASS");
  const boundArtifact = (binding, expectedName) => {
    try {
      if (!isRecord(binding) || typeof binding.path !== "string" || !isSha256(binding.sha256)
        || typeof expectedName !== "string" || !expectedName.endsWith(".json")) return undefined;
      const path = realpathSync(resolve(root, binding.path));
      const outputRoot = realpathSync(runOutputRoot);
      const relativePath = relative(outputRoot, path);
      if (relativePath.length === 0 || relativePath === ".."
        || relativePath.startsWith(`..${path.includes("\\") ? "\\" : "/"}`)
        || isAbsolute(relativePath) || !lstatSync(path).isFile()
        || path.split(/[\\/]/).at(-1) !== expectedName
        || fileSha256(path) !== binding.sha256) return undefined;
      return JSON.parse(readFileSync(path, "utf8"));
    } catch {
      return undefined;
    }
  };
  const boundContainedJsonArtifact = (binding) => {
    try {
      if (!isRecord(binding) || typeof binding.path !== "string"
        || !isSha256(binding.sha256)) return undefined;
      const path = realpathSync(resolve(root, binding.path));
      const outputRoot = realpathSync(runOutputRoot);
      const relativePath = relative(outputRoot, path);
      if (relativePath.length === 0 || relativePath === ".."
        || relativePath.startsWith(`..${path.includes("\\") ? "\\" : "/"}`)
        || isAbsolute(relativePath) || extname(path).toLowerCase() !== ".json"
        || !lstatSync(path).isFile() || fileSha256(path) !== binding.sha256) {
        return undefined;
      }
      return JSON.parse(readFileSync(path, "utf8"));
    } catch {
      return undefined;
    }
  };
  const expectedNativeProbeSha256 = options.nativeProbeSourceSha256
    ?? expectedSourceHashes.probe;
  const nativeModeArtifactMatches = (artifact, modeId, backendType) => {
    if (!isRecord(artifact) || artifact.schemaVersion !== 1
      || artifact.status !== "PASS"
      || artifact.probeIdentity?.sourcePath !== "dev/测试/桌面/new-modes-desktop-artifact.mjs"
      || artifact.probeIdentity?.sourceSha256 !== expectedNativeProbeSha256) {
      return false;
    }
    const topChecks = Array.isArray(artifact.checks) ? artifact.checks : [];
    const topCheck = (id) => topChecks.find((check) => check?.id === id);
    const tgzCheck = topCheck("tgz-content-dependency-path-audit");
    const runtimeCheck = topCheck("desktop-runtime-hashes");
    if (tgzCheck?.status !== "PASS"
      || tgzCheck.evidence?.sha256 !== expectedTgzSha256
      || runtimeCheck?.status !== "PASS"
      || runtimeCheck.evidence?.appAsarSha256 !== actualAsarSha256
      || runtimeCheck.evidence?.executableSha256 !== actualExecutableSha256) {
      return false;
    }
    const phases = Array.isArray(artifact.phases) ? artifact.phases : [];
    const phase = phases.find((value) => value?.label === "enabled-retained");
    if (phase?.status !== "PASS"
      || phase.child?.exitCode !== 0
      || phase.child?.timedOut !== false
      || phase.child?.closeObserved !== true
      || phase.child?.reaped !== true
      || phase.child?.error != null) {
      return false;
    }
    const checks = Array.isArray(phase.evidence?.checks)
      ? phase.evidence.checks
      : [];
    const check = (id) => checks.find((value) => value?.id === id);
    const pass = (id) => check(id)?.status === "PASS";
    const common = [
      `${modeId}:standard-composition`,
      `${modeId}:system-prompt`,
      `${modeId}:native-lifecycle`,
      `${modeId}:owner-dispose`,
    ];
    if (!common.every(pass)) return false;
    const lifecycle = check(`${modeId}:native-lifecycle`)?.evidence;
    const owner = check(`${modeId}:owner-dispose`)?.evidence;
    if (lifecycle?.publicSessionObserved !== true
      || owner?.processCleanupOk !== true
      || !Array.isArray(owner?.processObservationErrors)
      || owner.processObservationErrors.length !== 0) {
      return false;
    }
    if (backendType === "wsl") {
      const background = check(`${modeId}:background-process-cleanup`)?.evidence;
      const natural = check(`${modeId}:natural-exit-reset`)?.evidence;
      return pass(`${modeId}:background-process-cleanup`)
        && background?.backendType === "wsl"
        && background?.backgroundReapOk === true
        && pass(`${modeId}:natural-exit-reset`)
        && natural?.processLedger?.available === true
        && Array.isArray(natural.processLedger.afterDelayRows)
        && natural.processLedger.afterDelayRows.length === 0;
    }
    const pty = check(`${modeId}:native-pid-pty`)?.evidence;
    const helper = check(`${modeId}:helper-job-quiescence`)?.evidence;
    const natural = check(`${modeId}:natural-exit-reset`)?.evidence;
    const noisy = check(`${modeId}:natural-exit-noisy-background`)?.evidence;
    const delayed = check(`${modeId}:natural-exit-delayed-background`)?.evidence;
    return pass(`${modeId}:native-pid-pty`)
      && Number.isSafeInteger(pty?.nativePid)
      && pty.nativePid > 0
      && pty.truePty === true
      && pty.helperSpawnObserved === true
      && pass(`${modeId}:helper-job-quiescence`)
      && helper?.nativeHandlesSettled === true
      && helper?.processCleanupOk === true
      && Array.isArray(helper?.processObservationErrors)
      && helper.processObservationErrors.length === 0
      && Array.isArray(helper?.processAfterOwnerDisposeRows)
      && helper.processAfterOwnerDisposeRows.length === 0
      && pass(`${modeId}:natural-exit-reset`)
      && natural?.processLedger?.available === true
      && Array.isArray(natural.processLedger.naturalOwnedIdentities)
      && natural.processLedger.naturalOwnedIdentities.length > 0
      && Array.isArray(natural.processLedger.afterDelayRows)
      && natural.processLedger.afterDelayRows.length === 0
      && pass(`${modeId}:natural-exit-noisy-background`)
      && noisy?.processLedger?.available === true
      && Array.isArray(noisy.processLedger.afterDelayRows)
      && noisy.processLedger.afterDelayRows.length === 0
      && pass(`${modeId}:natural-exit-delayed-background`)
      && delayed?.processLedger?.available === true
      && Array.isArray(delayed.processLedger.afterDelayRows)
      && delayed.processLedger.afterDelayRows.length === 0;
  };
  const rawAdapter = boundArtifact(evidence?.artifactBindings?.adapter, adapter.resultArtifact);
  const rawGui = boundArtifact(evidence?.artifactBindings?.guiObservation, gui?.resultArtifact);
  const rawReady = boundArtifact(evidence?.artifactBindings?.observationReady, adapter.observationArtifact);
  require(isRecord(rawAdapter) && JSON.stringify(rawAdapter) === JSON.stringify(adapter),
    "adapter does not match its contained raw artifact and SHA");
  require(isRecord(rawGui) && JSON.stringify(rawGui) === JSON.stringify(gui),
    "GUI observation does not match its contained raw artifact and SHA");
  require(rawReady?.status === "OBSERVATION_READY" && rawReady?.mode === "real-turn"
    && rawReady?.attemptId === adapter.attemptId
    && rawReady?.sessionIdSha256 === adapter.sessionIdSha256
    && rawReady?.sessionTitle === adapter.sessionTitle
    && rawReady?.tgzSha256 === adapter.tgzSha256
    && rawReady?.appAsarSha256 === adapter.appAsarSha256
    && rawReady?.followReady === true
    && rawReady?.provider === adapter.provider && rawReady?.model === adapter.model
    && rawReady?.toolCalls === 2 && rawReady?.toolResults === 2 && rawReady?.toolErrors === 0
    && sameStringArray(rawReady?.toolNames, ["bash", "bash"])
    && rawReady?.markers?.DSH_GUI_TURN1 === true && rawReady?.markers?.DSH_GUI_TURN2 === true
    && rawReady?.turnStarts === 1 && rawReady?.turnEnded === true && rawReady?.turnEndKind === "completed",
  "observation-ready artifact is not bound to this real session");
  require(adapter.schemaVersion === 2, "adapter schemaVersion must be 2");
  require(adapter.status === "PASS", "adapter status must be PASS");
  require(adapter.mode === "real-turn" && adapter.followReady === true,
    "adapter must observe a ready real turn, not a connection preflight");
  require(adapter.protocolFailure === false && adapter.failureReason === null,
    "adapter reports a protocol failure");
  require(isSha256(adapter.sessionIdSha256), "owned session identity hash is missing");
  require(adapter.fixture === "gui-human-canonical-20261010-2340", "owned canonical fixture identity mismatch");
  require(adapter.runtime === "DeepSeek Harness Desktop 0.2.1-rc.2", "Desktop rc.2 runtime identity mismatch");
  require(isSha256(expectedTgzSha256) && adapter.tgzSha256 === expectedTgzSha256,
    "adapter TGZ SHA does not match this gate's fresh pack");
  if (candidateMode) {
    const binding = adapter.candidateBinding;
    require(isSha256(options.expectedTgzSha256)
      && expectedTgzSha256 === options.expectedTgzSha256,
    "fresh GUI candidate SHA is missing from the gate");
    require(isRecord(binding)
      && binding.candidateIndependent === true
      && binding.freshRequired === true
      && binding.isCanonical === false
      && binding.expectedSha256 === expectedTgzSha256
      && typeof binding.tgzRelativePath === "string"
      && binding.tgzRelativePath.length > 0
      && !isAbsolute(binding.tgzRelativePath)
      && !binding.tgzRelativePath.split(/[\\/]/).includes(".."),
    "fresh GUI candidate binding is missing, canonical, or path-unsafe");
    require(isRecord(adapter.sourceHashes),
      "fresh GUI driver source hash ledger is missing");
    for (const [name, expected] of Object.entries(expectedSourceHashes)) {
      require(isSha256(expected) && adapter.sourceHashes?.[name] === expected,
        `fresh GUI source hash mismatch: ${name}`);
    }
  } else {
    require(adapter.tgzSha256 === "9cb01907dd7a9558255b6b8d5fe5ef03349927711fef0aadf9456656fe2b6f63",
      "adapter TGZ SHA is not canonical 9cb");
  }
  require(isSha256(actualAsarSha256)
    && actualAsarSha256 === expectedDesktopAsarSha256
    && adapter.appAsarSha256 === actualAsarSha256,
  "adapter app.asar SHA does not match the installed rc.2 artifact");
  if (candidateMode) {
    validateNativeGuiModeEnvelope(adapter.nativeModes, require);
  } else {
    require(adapter.agentPreset === "standard", "adapter agent preset is not standard");
  }
  require(adapter.cwd === "owned fixture workspace 中文 space", "adapter cwd is not the owned fixture workspace");
  require(adapter.preflightModelRouteObserved === true, "DeepSeek model preflight was not observed");
  const preflightModelId = typeof adapter.preflightModel === "string"
    ? adapter.preflightModel
    : "";
  const preflightModelIdIsCatalogFlash = preflightModelId === "deepseek-flash"
    || (/deepseek/i.test(preflightModelId)
      && /(?:v4\.?1|v41)/i.test(preflightModelId)
      && /flash/i.test(preflightModelId));
  require(adapter.preflightProvider === "deepseek-account",
    "preflight provider is not the approved deepseek-account route");
  require(preflightModelIdIsCatalogFlash,
    "preflight model id is not the catalog-selected DeepSeek Flash route");
  require(adapter.modelRouteObserved === true && adapter.deepSeekModelObserved === true,
    "authoritative request header did not observe the DeepSeek route");
  require(adapter.provider === adapter.preflightProvider && adapter.model === adapter.preflightModel,
    "request header route does not equal the preflight selection");
  require(adapter.promptAttempted === true && adapter.promptAccepted === true,
    "official session prompt was not accepted");
  require(adapter.toolCalls === 2 && adapter.toolResults === 2 && adapter.toolErrors === 0,
    "adapter did not record exactly two successful tool calls/results");
  require(sameStringArray(adapter.toolNames, ["bash", "bash"]), "tool identity/order is not exactly bash,bash");
  require(Array.isArray(callHashes) && callHashes.length === 2 && callHashes.every(isSha256),
    "tool callId hashes are incomplete");
  require(Array.isArray(callHashes) && new Set(callHashes).size === 2,
    "the two tool calls must have distinct callIds");
  require(Array.isArray(resultHashes) && resultHashes.length === 2 && resultHashes.every(isSha256),
    "tool result callId hashes are incomplete");
  require(sameStringArray(callHashes, resultHashes), "tool result callIds do not match tool callIds in order");
  require(adapter.markers?.DSH_GUI_TURN1 === true && adapter.markers?.DSH_GUI_TURN2 === true,
    "both exact stdout markers were not proven");
  // rc.2 isVisibleChatNode filters system-prompt rows out of the normal flow.
  // Actual Host prompt assembly/removal is mandatory in every Desktop phase
  // below; a hidden prompt must never be fabricated into visual evidence.
  require(adapter.turnStarts === 1 && adapter.turnEnded === true && adapter.turnEndKind === "completed",
    "the owned turn did not complete exactly once");
  require(adapter.accountCredentialsRead === false
    && adapter.accountCredentialsPersisted === false
    && adapter.userConversationRead === false,
  "credential or unrelated conversation boundary was not clean");
  require(adapter.ephemeralLocalTransportAuthHandled === true, "ephemeral local transport auth was not bounded");
  require(adapter.cancelAttempted === false, "completed D16 turn unexpectedly required cancellation");
  require(adapter.observationReady === true && adapter.observationChildClosed === true,
    "GUI observation window did not close cleanly");

  const cleanup = adapter.cleanup;
  require(cleanup?.childClosed === true && cleanup?.socketClosed === true
    && cleanup?.queueEnded === true && cleanup?.reaped === true,
    "Windows child/socket cleanup was not proven");
  require(cleanup?.lineageInitial?.available === true
    && cleanup.lineageInitial.verified === true
    && cleanup.lineageInitial.rootPresent === true
    && Array.isArray(cleanup.lineageInitial.identities)
    && cleanup.lineageInitial.identities.length > 0
    && cleanup.lineageInitial.markerProcessCount > 0,
  "adapter Windows prepositive identity evidence is missing");
  require(cleanup?.lineageAfter?.available === true
    && cleanup.lineageAfter.rootPresent === false
    && Array.isArray(cleanup.lineageAfter.identities)
    && cleanup.lineageAfter.identities.length === 0
    && cleanup.lineageAfter.remainingIdentityCount === 0
    && cleanup.lineageAfter.markerProcessCount === 0,
  "adapter Windows postempty identity evidence is missing");
  require(cleanup?.wslLedgerBefore?.available === true
    && cleanup.wslLedgerBefore.markerCount > 0,
  "Linux prepositive ledger evidence is missing");
  require(cleanup?.wslLedgerAfter?.available === true
    && cleanup.wslLedgerAfter.markerCount === 0,
  "Linux postempty ledger evidence is missing");

  require(isRecord(gui), "independent guiObservation object is missing");
  if (isRecord(gui)) {
    require(gui.schemaVersion === 1, "guiObservation schemaVersion must be 1");
    require(gui.status === "PASS", "guiObservation status must be PASS");
    const guiObservationSources = new Set(["@oai/sky", "mcp__windows_mcp"]);
    require(guiObservationSources.has(gui.source) && gui.independent === true,
      "GUI evidence must be an independent allowlisted GUI observation");
    require(Number.isInteger(gui.windowId) && gui.windowId > 0 && gui.uniqueWindow === true,
      "GUI evidence does not identify one unique owned window");
    require(gui.sessionIdSha256 === adapter.sessionIdSha256,
      "GUI observation is not associated with this adapter session");
    require(typeof adapter.attemptId === "string" && adapter.attemptId.length > 0
      && gui.attemptId === adapter.attemptId && gui.sessionTitle === adapter.sessionTitle,
    "GUI attempt/title does not identify this owned session");
    require(gui.systemPromptVisibility === "not-visually-verified",
      "GUI evidence must distinguish unverified prompt visibility from Host assembly");
    const initialWindowsLineage = gui.initialWindowsLineage ?? gui.windowsLineage?.before;
    const finalWindowsLineage = gui.finalWindowsLineage ?? gui.windowsLineage?.after;
    require(initialWindowsLineage?.available === true
      && initialWindowsLineage.verified === true
      && initialWindowsLineage.rootPresent === true
      && Array.isArray(initialWindowsLineage.identities)
      && initialWindowsLineage.identities.length > 0
      && Number.isInteger(initialWindowsLineage.markerProcessCount)
      && initialWindowsLineage.markerProcessCount > 0,
    "independent Windows prepositive CIM identity set is missing");
    require(finalWindowsLineage?.available === true
      && finalWindowsLineage.rootPresent === false
      && Array.isArray(finalWindowsLineage.identities)
      && finalWindowsLineage.identities.length === 0
      && finalWindowsLineage.remainingIdentityCount === 0
      && finalWindowsLineage.markerProcessCount === 0,
    "independent Windows postempty CIM identity set is missing");
    require(gui.route?.provider === adapter.provider && gui.route?.model === adapter.model,
      "GUI model selection/header route does not match the real request header");
    require(gui.desktopIdentity?.tgzSha256 === expectedTgzSha256
      && gui.desktopIdentity?.appAsarSha256 === actualAsarSha256
      && gui.desktopIdentity?.executableSha256 === actualExecutableSha256
      && actualExecutableSha256 === expectedDesktopExecutableSha256,
    "GUI Desktop/TGZ identity does not match the installed canonical artifacts");
    require(gui.helperSourceHashes?.launcher === launcherSourceSha256
      && gui.helperSourceHashes?.sessionDriver === sessionDriverSourceSha256,
    "GUI helper source hashes do not match the helpers under test");
    for (const id of d16GuiCheckIds) require(gui.checks?.[id] === true, `GUI check ${id} is not PASS`);
    if (candidateMode) {
      const expectedNativeModes = [
        { id: "bash-wsl", backendType: "wsl", cleanupKind: "wsl-public-session" },
        { id: "bash-git-bash", backendType: "git-bash", cleanupKind: "native-process-tree" },
      ];
      const guiNativeModes = Array.isArray(gui.nativeModes) ? gui.nativeModes : [];
      const guiNativeById = new Map(guiNativeModes.map((mode) => [mode?.modeId, mode]));
      require(guiNativeModes.length === expectedNativeModes.length
        && guiNativeById.size === expectedNativeModes.length,
      "GUI native mode observation must contain both unique mode IDs");
      for (const expected of expectedNativeModes) {
        const mode = guiNativeById.get(expected.id);
        const adapterMode = (Array.isArray(adapter.nativeModes)
          ? adapter.nativeModes : []).find((value) => value?.modeId === expected.id);
        const adapterCalls = Array.isArray(adapterMode?.calls) ? adapterMode.calls : [];
        require(isRecord(mode) && mode.observed === true,
          `GUI native mode ${expected.id} was not independently observed`);
        const backendObservation = mode?.backendObservation;
        const backendArtifact = boundContainedJsonArtifact(backendObservation?.artifact);
        require(isRecord(backendObservation)
          && backendObservation.source === "new-modes-desktop-artifact"
          && backendObservation.backendType === expected.backendType
          && isRecord(backendArtifact)
          && nativeModeArtifactMatches(backendArtifact, expected.id, expected.backendType),
        `GUI native mode ${expected.id} backend observation/artifact is incomplete`);
        const strictNativeBinding = backendObservation?.strictNativeBinding;
        require(isRecord(strictNativeBinding)
          && strictNativeBinding.validator === "native-modes-release-validator"
          && strictNativeBinding.accepted === true
          && strictNativeBinding.modeId === expected.id
          && strictNativeBinding.backendType === expected.backendType
          && strictNativeBinding.phaseLabel === "enabled-retained"
          && strictNativeBinding.candidateTgzSha256 === expectedTgzSha256
          && strictNativeBinding.appAsarSha256 === actualAsarSha256
          && strictNativeBinding.executableSha256 === actualExecutableSha256
          && strictNativeBinding.probeSourceSha256 === expectedNativeProbeSha256
          && strictNativeBinding.artifactSha256 === backendObservation?.artifact?.sha256,
        `GUI native mode ${expected.id} is not bound to the accepted current native probe`);
        const cards = mode?.toolCards;
        require(Array.isArray(cards) && cards.length === 2,
          `GUI native mode ${expected.id} must show its two tool cards`);
        if (Array.isArray(cards) && cards.length === 2) {
          const expectedOutput = [
            "DSH_GUI_TURN1:DSH_GUI_TURN1",
            "DSH_GUI_TURN2:DSH_GUI_TURN1",
          ];
          cards.forEach((card, index) => {
            require(card?.observed === true
              && card.toolName === "bash"
              && card.callIdSha256 === adapterCalls[index]?.callIdSha256
              && card.identityCorrelation === "session-order-and-exact-output"
              && card.outputMarker === expectedOutput[index],
            `GUI native mode ${expected.id} card ${index + 1} is not tied to its real callId/output`);
          });
        }
        const cleanup = mode?.cleanup;
        require(cleanup?.kind === expected.cleanupKind
          && cleanup?.observed === true
          && Array.isArray(cleanup.remaining)
          && cleanup.remaining.length === 0
          && Array.isArray(cleanup.observationErrors)
          && cleanup.observationErrors.length === 0,
        `GUI native mode ${expected.id} backend-specific cleanup is incomplete`);
        if (expected.cleanupKind === "wsl-public-session") {
          require(cleanup?.guiProcessObservation === true,
            "GUI bash-wsl normal process cleanup was not independently observed");
        } else {
          require(cleanup?.guiProcessObservation === true,
            "GUI bash-git-bash normal process cleanup was not independently observed");
        }
        require(mode?.normalGuiExit?.closeObserved === true
          && mode?.normalGuiExit?.reaped === true
          && mode?.normalGuiExit?.aliveAfter === false,
        `GUI native mode ${expected.id} normal exit/reap evidence is incomplete`);
      }
    }
    require(Array.isArray(gui.toolCards) && gui.toolCards.length === 2,
      "GUI did not independently observe exactly two tool cards");
    if (Array.isArray(gui.toolCards) && gui.toolCards.length === 2) {
      const expectedOutput = ["DSH_GUI_TURN1:DSH_GUI_TURN1", "DSH_GUI_TURN2:DSH_GUI_TURN1"];
      gui.toolCards.forEach((card, index) => {
        require(card?.observed === true && card.toolName === "bash"
          && card.callIdSha256 === callHashes?.[index]
          && card.identityCorrelation === "session-order-and-exact-output"
          && card.outputMarker === expectedOutput[index],
        `GUI tool card ${index + 1} is not tied to its real callId/output marker`);
      });
    }
    require(gui.normalGuiExit?.closeObserved === true
      && gui.normalGuiExit?.reaped === true
      && gui.normalGuiExit?.aliveAfter === false,
    "GUI normal exit/reap evidence is incomplete");
    const legacyProfileCleanup =
      gui.temporaryProfileCleanup?.strategy !== "reused-protected-owned-fixture"
      &&
      gui.temporaryProfileCleanup?.temporaryRootRemoved === true
      && gui.temporaryProfileCleanup?.profileContained === true;
    require(legacyProfileCleanup
      || reusedProtectedFixtureCleanupIsStrict(gui.temporaryProfileCleanup),
    "GUI temporary profile cleanup/containment is unproven");
  }
  return {
    ok: failures.length === 0,
    detail: failures.length === 0
      ? "strict rc.2/TGZ/session/tool/UI/Windows+Linux cleanup evidence matched"
      : failures.slice(0, 12).join("; "),
  };
}

function childLifecycleIsClean(value) {
  return value?.exitCode === 0
    && value?.timedOut === false
    && value?.closeObserved === true
    && value?.reaped === true
    && value?.error == null;
}

function probeIdentityIsClean(host, sourceProbeSha256, sourceObserverSha256 = sourceProbeObserverSha256) {
  return isSha256(sourceProbeSha256)
    && isSha256(host?.probeSourceIndexSha256)
    && isSha256(host?.probeInstalledIndexSha256)
    && host.probeSourceIndexSha256 === sourceProbeSha256
    && host.probeSourceIndexSha256 === host.probeInstalledIndexSha256
    && host.probeIndexHashesMatch === true
    && isSha256(sourceObserverSha256)
    && host.probeObserverRequired === true
    && isSha256(host?.probeSourceObserverSha256)
    && isSha256(host?.probeInstalledObserverSha256)
    && host.probeSourceObserverSha256 === sourceObserverSha256
    && host.probeSourceObserverSha256 === host.probeInstalledObserverSha256
    && host.probeObserverHashesMatch === true;
}

function pluginDistIdentityIsClean(host) {
  return isSha256(host?.sourceDistSha256)
    && isSha256(host?.installedDistSha256)
    && host.sourceDistSha256 === host.installedDistSha256
    && host.distHashesMatch === true;
}

function installedDesktopPathsForGate() {
  if (process.platform !== "win32" || !process.env.LOCALAPPDATA) return undefined;
  const executable = process.env.DSH_DESKTOP_EXE ?? join(
    process.env.LOCALAPPDATA,
    "Programs",
    "DeepSeek Harness",
    "DeepSeek Harness.exe",
  );
  return {
    executable,
    asar: process.env.DSH_DESKTOP_ASAR ?? join(dirname(executable), "resources", "app.asar"),
  };
}

function desktopRuntimeNegativeIsClean(evidence, oldTgz) {
  const paths = installedDesktopPathsForGate();
  if (paths === undefined || !existsSync(paths.executable) || !existsSync(paths.asar) || !existsSync(oldTgz)) {
    return false;
  }
  const diagnostic = String(evidence?.loaderResult?.diagnostic ?? "");
  return evidence?.schemaVersion === 2
    && evidence.acceptanceId === "D-14 old-version runtime rejection"
    && evidence.status === "PASS"
    && evidence.loaderStatus === "PASS"
    && evidence.host?.desktopVersion === "0.2.1-rc.2"
    && evidence.host?.executableSha256 === fileSha256(paths.executable)
    && evidence.host?.appAsarSha256 === fileSha256(paths.asar)
    && evidence.fixture?.name === expectedName
    && evidence.fixture?.version === "0.1.0"
    && evidence.fixture?.tgzSha256 === fileSha256(oldTgz)
    && evidence.fixture?.dshPeerRange === "0.1.0-rc.6"
    && Array.isArray(evidence.loaderResult?.activeLayers)
    && evidence.loaderResult.activeLayers.includes("@deepseek-ai/dsh-base")
    && evidence.loaderResult.activeLayers.includes("@deepseek-ai/dsh-web-app")
    && Array.isArray(evidence.loaderResult?.skippedBundles)
    && evidence.loaderResult.skippedBundles.includes(expectedName)
    && evidence.loaderResult?.pluginLayerLoaded === false
    && evidence.loaderResult?.skippedBundle === expectedName
    && evidence.loaderResult?.expectedPeerMismatch === true
    && /0\.1\.0-rc\.6/.test(diagnostic)
    && /incompatib|peerDependencies|exact-version exemption/i.test(diagnostic)
    && evidence.oldToolsPrompt?.registered === false
    && childLifecycleIsClean(evidence.child)
    && evidence.ownedTemp?.containmentChecked === true
    && evidence.ownedTemp?.rootRemoved === true;
}

function desktopRuntimeNegativeContextIsClean(evidence) {
  const audit = evidence?.hostRegistrationAudit;
  const toolCheck = audit?.toolRegistration;
  const promptCheck = audit?.systemPrompt;
  const schemaCheck = audit?.promptToolSchemas;
  const anchorCheck = audit?.profileContextAnchor;
  return evidence?.acceptanceId === "D-14 old-version runtime rejection"
    && evidence?.fullD14Status === "PASS"
    && evidence.runtimeContext?.started === true
    && evidence.runtimeContext?.fullAuditStatus === "PASS"
    && evidence.hostEvidence?.status === "PASS"
    && childLifecycleIsClean(evidence.hostChild)
    && audit?.status === "PASS"
    && toolCheck?.status === "PASS"
    && Array.isArray(toolCheck.evidence?.observedExpectedNames)
    && toolCheck.evidence.observedExpectedNames.length === 0
    && promptCheck?.status === "PASS"
    && promptCheck.evidence?.sectionPresent === false
    && promptCheck.evidence?.renderedMarker === false
    && schemaCheck?.status === "PASS"
    && Array.isArray(schemaCheck.evidence?.observed)
    && schemaCheck.evidence.observed.length === 0
    && anchorCheck?.status === "PASS";
}

function assertTemporaryContainment() {
  const parent = resolve(runOutputRoot);
  const candidate = resolve(temporary);
  const prefix = parent.endsWith("\\") || parent.endsWith("/") ? parent : `${parent}${candidate.includes("\\") ? "\\" : "/"}`;
  if (candidate !== parent && !candidate.startsWith(prefix)) {
    throw new Error(`release-check temporary path escaped 测试/运行产物: ${candidate}`);
  }
}

function plantStaleDistSentinel(path) {
  const distDir = join(root, "dist");
  if (existsSync(distDir)) {
    const distStat = lstatSync(distDir);
    if (distStat.isSymbolicLink() || !distStat.isDirectory()) {
      throw new Error(`refusing to seed stale sentinel in unexpected dist path: ${distDir}`);
    }
  } else {
    mkdirSync(distDir);
  }
  writeFileSync(path, "stale release-check sentinel\n");
}

function removeStaleDistSentinel(path) {
  const distDir = join(root, "dist");
  if (!existsSync(distDir)) return;
  const distStat = lstatSync(distDir);
  if (distStat.isSymbolicLink() || !distStat.isDirectory() || !existsSync(path)) return;
  const sentinelStat = lstatSync(path);
  if (sentinelStat.isSymbolicLink() || !sentinelStat.isFile()) return;
  rmSync(path, { force: true });
}

function assertPackageMetadata() {
  if (packageJson.name !== expectedName) {
    record("package metadata", "FAIL", `name=${packageJson.name}, expected ${expectedName}`);
  } else if (packageJson.version !== expectedVersion) {
    record("package metadata", "FAIL", `version=${packageJson.version}, expected ${expectedVersion}`);
  } else if (packageJson.engines?.node !== ">=22") {
    record("package metadata", "FAIL", `engines.node=${packageJson.engines?.node}`);
  } else if (packageJson.engines?.dsh !== "0.2.1-rc.2") {
    record("package metadata", "FAIL", `engines.dsh=${packageJson.engines?.dsh}`);
  } else {
    const peerEntries = Object.entries(packageJson.peerDependencies ?? {});
    const unsupported = peerEntries.filter(([, spec]) => {
      const value = String(spec);
      return value.includes("0.1.0-rc.6") || value.includes("*") || value.includes("latest");
    });
    const requiredPeers = [
      "@deepseek-ai/cordis",
      "@deepseek-ai/dsh",
      "@deepseek-ai/dsh-agent",
      "@deepseek-ai/dsh-agent-preset-registry",
      "@deepseek-ai/dsh-app-boot",
      "@deepseek-ai/dsh-sandbox",
      "@deepseek-ai/dsh-sandbox-policy",
      "@deepseek-ai/dsh-subprocess",
      "@deepseek-ai/dsh-subprocess-local",
      "@deepseek-ai/dsh-system-prompt",
      "@deepseek-ai/dsh-terminal",
      "@deepseek-ai/dsh-terminal-bash",
      "@deepseek-ai/dsh-tool-bash-persistent",
      "@deepseek-ai/dsh-tools",
      "@deepseek-ai/dsh-user-approval",
      "@deepseek-ai/dsh-win32-process",
      "@deepseek-ai/dsh-working-directory",
    ];
    const missingPeers = requiredPeers.filter((name) => packageJson.peerDependencies?.[name] === undefined);
    if (unsupported.length > 0 || missingPeers.length > 0) {
      record("package metadata", "FAIL", `unsupported peer declarations=${unsupported.map(([name]) => name).join(",") || "none"}; missing=${missingPeers.join(",") || "none"}`);
    } else {
      record("package metadata", "PASS", `${expectedName}@${expectedVersion}, exact Desktop/CLI peer declarations, Node ${packageJson.engines.node}`);
      const dshPeerNames = requiredPeers.filter((name) => name !== "@deepseek-ai/cordis");
      const expectedDshPeerSpec = "0.2.1-rc.2";
      const currentHostMissing = dshPeerNames.filter((name) => {
        const spec = String(packageJson.peerDependencies[name]);
        return spec !== expectedDshPeerSpec;
      });
      record("current-host peer matrix", currentHostMissing.length === 0 ? "PASS" : "FAIL", currentHostMissing.length === 0
        ? `all DSH peers equal ${expectedDshPeerSpec}`
        : `DSH peers must equal ${expectedDshPeerSpec}: ${currentHostMissing.join(",")}`);
      const cordisSpec = String(packageJson.peerDependencies["@deepseek-ai/cordis"]);
      const expectedCordisSpec = "4.0.5";
      record("Cordis peer matrix", cordisSpec === expectedCordisSpec ? "PASS" : "FAIL", cordisSpec === expectedCordisSpec
        ? `Cordis peer equals ${expectedCordisSpec}`
        : `Cordis peer must equal ${expectedCordisSpec}, received ${cordisSpec}`);
    }
  }
}

function packageManagerExecutable() {
  if (process.platform === "win32") {
    const bundledNpm = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
    if (existsSync(bundledNpm)) return bundledNpm;
    const systemNodeRoot = process.env.ProgramW6432
      ?? process.env.ProgramFiles
      ?? "C:\\Program Files";
    const systemNpm = join(systemNodeRoot, "nodejs", "node_modules", "npm", "bin", "npm-cli.js");
    if (existsSync(systemNpm)) return systemNpm;
  }
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  return npm;
}

function localPeerDependencies() {
  return Object.fromEntries(Object.keys(packageJson.peerDependencies ?? {}).map((name) => {
    const packagePath = join(root, "node_modules", name);
    if (!existsSync(join(packagePath, "package.json"))) {
      throw new Error(`release-check: host peer package is missing from node_modules: ${name}`);
    }
    return [name, `file:${packagePath}`];
  }));
}

function inspectTarball(tarball) {
  const tar = process.platform === "win32" ? "tar.exe" : "tar";
  if (!tarball || !existsSync(tarball)) {
    record("tarball content", "FAIL", "pack command did not produce a tarball");
    return;
  }
  const result = spawnSync(tar, ["-tzf", tarball], { encoding: "utf8", timeout: 30_000 });
  if (result.error || result.status !== 0) {
    record("tarball content", "FAIL", result.error?.message ?? result.stderr ?? `exit ${result.status}`);
    return;
  }
  const names = String(result.stdout).split(/\r?\n/).filter(Boolean);
  const forbidden = names.filter((name) =>
    /(?:^|\/)(?:node_modules|coverage|\.env(?:\.|$)|\.git|测试|tests?|desktop-upstream)(?:\/|$)|(?:^|\/)(?:.*password.*|.*secret.*)$/i.test(name),
  );
  const required = [
    "package/README.md",
    "package/README.zh-CN.md",
    "package/SECURITY.md",
    "package/CONTRIBUTING.md",
    "package/CHANGELOG.md",
    "package/NOTICE",
    "package/LICENSE",
    "package/package.json",
    "package/dist/index.js",
    "package/cordis.patch.yml",
    "package/profiles/windows.example.cordis.patch.yml",
    "package/bin/dsh-bash-wsl.mjs",
  ];
  const staleSentinel = "package/dist/stale-secret.js";
  const unexpectedBinSources = names.filter((name) => /^package\/bin\/.*\.ts$/i.test(name));
  const missing = required.filter((name) => !names.includes(name));
  const absolutePathNames = names.filter((name) => /(?:[A-Za-z]:[\\/]|\/mnt\/[a-z]\/|C__Users|dsh_plugin_code)/i.test(name));
  if (forbidden.length > 0 || missing.length > 0 || names.includes(staleSentinel) || unexpectedBinSources.length > 0 || absolutePathNames.length > 0) {
    record("tarball content", "FAIL", `forbidden=${forbidden.join(",") || "none"}; missing=${missing.join(",") || "none"}; stale=${names.includes(staleSentinel) ? staleSentinel : "none"}; bin-sources=${unexpectedBinSources.join(",") || "none"}; absolute-path-names=${absolutePathNames.join(",") || "none"}`);
    return;
  }
  const auditRoot = join(temporary, "tar-audit");
  mkdirSync(auditRoot, { recursive: true });
  const extracted = spawnSync(tar, ["-xzf", tarball, "-C", auditRoot], { encoding: "utf8", timeout: 30_000 });
  if (extracted.error || extracted.status !== 0) {
    record("tarball path audit", "FAIL", extracted.error?.message ?? extracted.stderr ?? `exit ${extracted.status}`);
    return;
  }
  const sensitiveText = /(?:[A-Za-z]:[\\/]Users[\\/][^\s"']+|\/mnt\/[a-z]\/Users\/[^\s"']+|(?:api[_-]?key|access[_-]?token|private[_-]?key)\s*[:=])/i;
  const textFiles = names.filter((name) => /\.(?:cjs|d\.ts|js|json|map|mjs|md|yml|yaml)$/i.test(name));
  const leaked = [];
  for (const name of textFiles) {
    const path = join(auditRoot, name);
    if (!existsSync(path)) continue;
    const text = readFileSync(path, "utf8");
    if (sensitiveText.test(text)) leaked.push(name);
  }
  if (leaked.length > 0) {
    record("tarball path audit", "FAIL", `personal path or secret-like text found in ${leaked.join(",")}`);
    return;
  }
  record("tarball content", "PASS", `${names.length} files`);
  record("tarball path audit", "PASS", "declared archive paths and text contents contain no personal absolute paths or secret-like values");
}

try {
  // Resolve the optional native-mode candidate before any build/pack work so
  // an invalid explicit path fails immediately.  With no flag the historical
  // release gate keeps its existing root-canonical behavior unchanged.
  const nativeModesCandidate = readOwnedArtifactArgument("--candidate-tgz", ".tgz", "candidate TGZ");
  const nativeModesCliInput = readOwnedArtifactArgument("--native-modes-cli-evidence", ".json", "CLI native evidence");
  const nativeModesGuiInput = readOwnedArtifactArgument("--native-modes-gui-roster", ".json", "GUI roster evidence");
  const packCliInput = readPackCliArgument();
  if (nativeModesCandidate.kind === "invalid") {
    record("new native modes candidate TGZ input", "FAIL", nativeModesCandidate.detail);
    // An explicit candidate is a release identity input.  Do not continue into
    // typecheck/build/pack or any Desktop probe after rejecting it; the final
    // summary still runs after the controlled catch below.
    throw new ReleaseCheckInputError(nativeModesCandidate.detail);
  }
  if (nativeModesCliInput.kind === "invalid") {
    record("new native modes fresh CLI native evidence", "FAIL", nativeModesCliInput.detail);
    throw new ReleaseCheckInputError(nativeModesCliInput.detail);
  }
  if (nativeModesGuiInput.kind === "invalid") {
    record("new native modes independent GUI roster", "FAIL", nativeModesGuiInput.detail);
    throw new ReleaseCheckInputError(nativeModesGuiInput.detail);
  }
  if (packCliInput.kind === "invalid") {
    record("pack CLI input", "FAIL", packCliInput.detail);
    throw new ReleaseCheckInputError(packCliInput.detail);
  }
  if (packCliInput.kind === "present") {
    selectedPackCli = packCliInput;
    record("pack CLI contract", "PASS", `direct Windows Node pnpm@${packCliInput.version} matches packageManager`);
  }
  assertPackageMetadata();
  runPackCliContractRegression();
  let profileInstalled = false;

  const tsc = commandPath("tsc");
  if (tsc) run("typecheck", tsc, ["-p", "tsconfig.json", "--noEmit"], { timeout: 180_000 });
  else skip("typecheck", "node_modules/.bin/tsc is unavailable; install dependencies through the host workflow");

  const vitest = commandPath("vitest");
  if (vitest) run("tests", vitest, ["run"], { timeout: 180_000, failOnSkipped: true });
  else skip("tests", "node_modules/.bin/vitest is unavailable; install dependencies through the host workflow");

  // Build and pack once before the security probe. The probe must install the
  // package produced by this gate, never an older root TGZ left by a prior run.
  const securityPackageRoot = join(temporary, "security-pack");
  mkdirSync(securityPackageRoot, { recursive: true });
  const securityNpm = packageManagerExecutable();
  run("security pre-build", securityNpm, ["run", "build"], { timeout: 180_000 });
  const securityPackCli = selectedPackCli?.path ?? securityNpm;
  const securityPackLabel = selectedPackCli === undefined
    ? "security pre-pack"
    : "security pre-pack (pnpm)";
  const securityPackArgs = selectedPackCli === undefined
    ? ["pack", "--ignore-scripts", "--pack-destination", securityPackageRoot]
    : ["--config.ignore-scripts=true", "pack", "--pack-destination", securityPackageRoot];
  const securityPack = run(securityPackLabel, securityPackCli, securityPackArgs, {
    cwd: root,
    timeout: 120_000,
  });
  const securityTgz = securityPack.ok
    ? join(securityPackageRoot, `${expectedName}-${expectedVersion}.tgz`)
    : undefined;

  // Real-environment security regression: PTY geometry and the WSL interop
  // escape block. Requires a live WSL2 distro; SKIP is not a pass.
  const wslAvailability = spawnSync("wsl.exe", ["-l", "-q"], {
    encoding: "utf8",
    timeout: 15_000,
    windowsHide: true,
    env: isolatedEnvironment(),
  });
  const wslCleanup = cleanupSpawnTree(wslAvailability);
  if (wslCleanup?.reaped === false) {
    record("real security probe (PTY geometry + interop escape)", "FAIL", "timed-out wsl.exe capability probe process tree was not proven reaped");
  } else if (wslAvailability.error || wslAvailability.status !== 0) {
    skip("real security probe (PTY geometry + interop escape)", "wsl.exe unavailable in this host");
  } else {
    const probe = spawnSync(process.execPath, [join(root, "dev", "测试", "smoke", "security-probe.mjs")], {
      cwd: root,
      encoding: "utf8",
      timeout: 180_000,
      windowsHide: true,
      env: isolatedEnvironment({ DSH_PLUGIN_TGZ: securityTgz ?? "" }),
      });
      const probeCleanup = cleanupSpawnTree(probe);
      const probeOutput = `${probe.stdout ?? ""}${probe.stderr ?? ""}`.trim();
      const summary = /CLI smoke security:\s*(\d+) passed,\s*(\d+) skipped,\s*(\d+) failed/i.exec(probeOutput);
      const evidencePath = /Evidence:\s*(.+)\s*$/im.exec(probeOutput)?.[1]?.trim();
      let evidence;
      if (evidencePath !== undefined && existsSync(evidencePath)) {
        try {
          evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
        } catch {}
      }
      const modeEntries = Array.isArray(evidence?.modes) ? evidence.modes : [];
      const modeNames = modeEntries.map((mode) => mode?.mode);
      const modeShapeOk = modeEntries.length === expectedSecurityModes.length
        && new Set(modeNames).size === expectedSecurityModes.length
        && expectedSecurityModes.every((mode) => modeNames.filter((name) => name === mode).length === 1);
      const modeAudits = expectedSecurityModes.map((modeName) => {
        const modeEntry = modeEntries.find((entry) => entry?.mode === modeName);
        const checks = Array.isArray(modeEntry?.evidence?.checks) ? modeEntry.evidence.checks : [];
        const processOk = childLifecycleIsClean(modeEntry?.process);
        const securityChecks = requiredSecurityCheckIds.map((id) => checks.filter((check) => check?.id === id));
        const duplicateIds = securityChecks.filter((matches) => matches.length !== 1).length;
        const nonPassIds = securityChecks.flat().filter((check) => check.status !== "PASS").map((check) => check.id);
        const cliCheck = checks.filter((check) => String(check?.id).startsWith("CLI-01 "));
        const lifecycleEvidence = (id) => checks.find((check) => check?.id === id)?.evidence ?? {};
        const oneShotTimeout = lifecycleEvidence("SEC-10 timeout cancels and reaps a one-shot process tree");
        const oneShotCancel = lifecycleEvidence("SEC-11 caller cancellation aborts and reaps a one-shot process");
        const gitLifecycle = lifecycleEvidence("SEC-16 Git Bash timeout/cancellation reaping");
        const subprocessLifecycleOk = oneShotTimeout.tree === "reaped"
          && oneShotTimeout.managedWaitForExit === true
          && oneShotTimeout.managedQuiescent === true
          && oneShotCancel.managedWaitForExit === true
          && oneShotCancel.managedQuiescent === true
          && gitLifecycle.timeout?.managedWaitForExit === true
          && gitLifecycle.timeout?.managedQuiescent === true
          && gitLifecycle.timeout?.tree === "reaped"
          && gitLifecycle.cancellation?.managedWaitForExit === true
          && gitLifecycle.cancellation?.managedQuiescent === true
          && gitLifecycle.cancellation?.tree === "reaped";
        return {
          mode: modeName,
          present: modeEntry !== undefined,
          processOk,
          exitCode: modeEntry?.exitCode ?? null,
          evidenceStatus: modeEntry?.evidence?.status ?? null,
          checksCount: checks.length,
          duplicateOrMissingSecurityIds: duplicateIds,
          nonPassIds,
          subprocessLifecycleOk,
          cliCheckPass: cliCheck.length === 1 && cliCheck[0].status === "PASS",
          complete: processOk
            && modeEntry?.evidence?.status === "PASS"
            && checks.filter((check) => String(check?.id).startsWith("CLI-01 ")).length === 1
            && cliCheck[0]?.status === "PASS"
            && duplicateIds === 0
            && nonPassIds.length === 0
            && subprocessLifecycleOk,
        };
      });
      const cliHostOk = evidence?.host?.cliVersion === expectedCliVersion
        && evidence?.host?.pluginTgzSha256 === (securityTgz !== undefined && existsSync(securityTgz) ? fileSha256(securityTgz) : undefined)
        && pluginDistIdentityIsClean(evidence?.host)
        && probeIdentityIsClean(evidence?.host, sourceProbeIndexSha256);
      const modeChecks = modeEntries.flatMap((mode) => mode.evidence?.checks ?? []);
      const securityCleanupOk = evidence?.cleanup?.temporaryRootRemoved === true;
      const failedSecurityChecks = modeChecks.filter((check) => check.status === "FAIL");
      const skippedSecurityChecks = modeChecks.filter((check) => check.status === "SKIP");
      const incompleteModes = modeAudits.filter((audit) => !audit.complete);
      if (probe.error || probe.status === null || probeCleanup?.reaped === false || summary === null || evidence === undefined || !modeShapeOk || !cliHostOk || !securityCleanupOk || incompleteModes.length > 0) {
        record("real security probe (PTY geometry + interop escape)", "FAIL", probe.error?.message
          ?? (probeCleanup?.reaped === false
            ? "timed-out security probe process tree was not proven reaped"
            : `security evidence incomplete: summary=${summary?.[0] ?? "missing"}; modes=${modeShapeOk ? "exact" : "invalid"}; host=${cliHostOk ? "match" : "mismatch"}; cleanup=${securityCleanupOk ? "removed" : "unproven"}; incomplete=${incompleteModes.map((audit) => audit.mode).join(",") || "none"}`));
      } else if (failedSecurityChecks.length > 0 || evidence.status === "FAIL" || Number(summary[3]) > 0) {
        record("real security probe (PTY geometry + interop escape)", "FAIL", `official security probe reported ${summary[3]} failed checks`);
      } else if (skippedSecurityChecks.length > 0 || evidence.status === "SKIP" || Number(summary[2]) > 0) {
        record("real security probe (PTY geometry + interop escape)", "SKIP", `official security probe reported ${summary[2]} skipped checks; skipped checks are not passes`);
      } else {
        record("real security probe (PTY geometry + interop escape)", "PASS", "official PTY geometry and interop security checks passed");
      }
    }

  // The security matrix is not a substitute for the real CLI tool entrance.
  // Run the separate integration suite against the same freshly packed TGZ;
  // it exercises the official composed CLI probe, including persistent bash
  // timeout/reset and the natural-exit lifecycle checks.
  if (securityTgz === undefined || !existsSync(securityTgz)) {
    skip("real CLI integration probe", "security pre-pack did not produce the target TGZ");
  } else {
    const integration = spawnSync(process.execPath, [join(root, "dev", "测试", "smoke", "integration.mjs")], {
      cwd: root,
      encoding: "utf8",
      timeout: 600_000,
      windowsHide: true,
      env: isolatedEnvironment({ DSH_PLUGIN_TGZ: securityTgz }),
    });
    const integrationCleanup = cleanupSpawnTree(integration);
    const integrationOutput = `${integration.stdout ?? ""}${integration.stderr ?? ""}`.trim();
    const integrationSummary = /CLI smoke integration:\s*(\d+) passed,\s*(\d+) skipped,\s*(\d+) failed/i.exec(integrationOutput);
    const integrationEvidencePath = /Evidence:\s*(.+)\s*$/im.exec(integrationOutput)?.[1]?.trim();
    let integrationEvidence;
    if (integrationEvidencePath !== undefined && existsSync(integrationEvidencePath)) {
      try {
        integrationEvidence = JSON.parse(readFileSync(integrationEvidencePath, "utf8"));
      } catch {}
    }
    const integrationEntry = integrationEvidence?.checks?.find((check) => check.id === "SMOKE-CLI-01");
    const integrationProcess = integrationEntry?.evidence?.process;
    const integrationInner = integrationEntry?.evidence?.probe ?? integrationEntry?.evidence;
    const integrationChecks = Array.isArray(integrationInner?.checks) ? integrationInner.checks : [];
    const integrationIds = requiredIntegrationIds.map((id) => integrationChecks.filter((check) => check?.id === id));
    const integrationMissingOrDuplicate = integrationIds.filter((matches) => matches.length !== 1).length;
    const failedIntegrationChecks = integrationChecks.filter((check) => check.status === "FAIL");
    const skippedIntegrationChecks = integrationChecks.filter((check) => check.status === "SKIP");
    const integrationHostOk = integrationEvidence?.host?.cliVersion === expectedCliVersion
      && integrationEvidence?.host?.pluginTgzSha256 === fileSha256(securityTgz)
      && pluginDistIdentityIsClean(integrationEvidence?.host)
      && probeIdentityIsClean(integrationEvidence?.host, sourceProbeIndexSha256);
    const integrationEvidenceFor = (id) => integrationChecks.find((check) => check?.id === id)?.evidence ?? {};
    const integrationCwd = integrationEvidenceFor("CLI-02 persistent cwd/environment/function state");
    const integrationCancel = integrationEvidenceFor("CLI-05 persistent cancellation followed by explicit reaping");
    const integrationCanonical = integrationEvidenceFor("CLI-11 official wsl_bash canonical cwd and invalid path zero-spawn boundary");
    const integrationTimeout = integrationEvidenceFor("CLI-10 persistent timeout resets and next call is clean");
    const integrationOutputCap = integrationEvidenceFor("CLI-12 persistent output cap and next call remain usable");
    const integrationGitWorkdir = integrationEvidenceFor("CLI-13 registered Git Bash workspace-root cwd regression");
    const integrationBehaviorOk = integrationCwd.cwdAndEnvPersisted === true
      && integrationCwd.canonicalCwdPersisted === true
      && integrationCwd.backgroundJobPersisted === true
      && integrationCwd.backgroundJobReaped === true
      && integrationCancel.resetVerified === true
      && integrationCancel.leakMarkerCreated === false
      && Array.isArray(integrationCanonical.equivalent)
      && integrationCanonical.equivalent.length === 2
      && integrationCanonical.equivalent.every((entry) => entry.accepted === true
        && entry.exitCode === 0 && entry.commandSpawnCount === 1)
      && Array.isArray(integrationCanonical.rejected)
      && integrationCanonical.rejected.length === 5
      && integrationCanonical.rejected.every((entry) => entry.rejected === true
        && entry.commandSpawnCount === 0)
      && integrationTimeout.timedOut === true
      && integrationTimeout.cleanReset === true
      && integrationTimeout.cwdReset === true
      && integrationTimeout.naturalExit === true
      && integrationTimeout.naturalCleanReset === true
      && integrationTimeout.timeoutOwnerActivityCleared === true
      && integrationTimeout.naturalOwnerActivityCleared === true;
    const integrationOutputOk = integrationOutputCap.clipped === true
      && integrationOutputCap.configuredMaxOutputChars === 16_000
      && integrationOutputCap.nextCallClean === true
      && Number(integrationOutputCap.payloadBytes) > 0
      && Number(integrationOutputCap.payloadBytes) <= 16_000
      && Number(integrationOutputCap.payloadXCount) > 0
      && Number(integrationOutputCap.visibleBytes) <= 16_512;
    const integrationGitWorkdirOk = integrationGitWorkdir.processCwdDistinctFromWorkspace === true
      && integrationGitWorkdir.agentSessionWorkspace === integrationGitWorkdir.workspace
      && integrationGitWorkdir.policyWorkspaceRoot === integrationGitWorkdir.workspace
      && integrationGitWorkdir.officialToolRuntime === true
      && integrationGitWorkdir.omitted?.matchesExpectedWorkspace === true
      && integrationGitWorkdir.relative?.matchesExpectedWorkspace === true
      && integrationGitWorkdir.absolute?.matchesExpectedWorkspace === true
      && Array.isArray(integrationGitWorkdir.namespaceResults)
      && integrationGitWorkdir.namespaceResults.length === 2
      && integrationGitWorkdir.namespaceResults.every((entry) => entry.rejected === true
        && entry.observedSpawnCount === 0);
    const integrationComplete = integration.status === 0
      && childLifecycleIsClean(integrationProcess)
      && integrationEvidence?.status === "PASS"
      && integrationInner?.status === "PASS"
      && integrationMissingOrDuplicate === 0
      && integrationChecks.every((check) => check.status === "PASS")
      && integrationHostOk
      && integrationBehaviorOk
      && integrationOutputOk
      && integrationGitWorkdirOk
      && integrationEvidence?.cleanup?.temporaryRootRemoved === true;
    if (integration.error || integration.status === null || integrationCleanup?.reaped === false || integrationSummary === null || integrationEvidence === undefined || !integrationComplete) {
      record("real CLI integration probe", "FAIL", integration.error?.message
        ?? (integrationCleanup?.reaped === false
          ? "timed-out CLI integration process tree was not proven reaped"
          : `CLI integration evidence incomplete: summary=${integrationSummary?.[0] ?? "missing"}; child=${childLifecycleIsClean(integrationProcess) ? "close/reaped" : "exit/close evidence missing"}; ids=${integrationMissingOrDuplicate === 0 ? "complete" : "missing-or-duplicate"}; host=${integrationHostOk ? "match" : "mismatch"}; behavior=${integrationBehaviorOk ? "complete" : "missing"}; output=${integrationOutputOk ? "bounded" : "missing"}; CLI13=${integrationGitWorkdirOk ? "complete" : "missing"}; cleanup=${integrationEvidence?.cleanup?.temporaryRootRemoved === true ? "removed" : "unproven"}`));
    } else if (failedIntegrationChecks.length > 0 || integrationEvidence.status === "FAIL" || Number(integrationSummary[3]) > 0) {
      record("real CLI integration probe", "FAIL", `official CLI integration probe reported ${integrationSummary[3]} failed checks`);
    } else if (skippedIntegrationChecks.length > 0 || integrationEvidence.status === "SKIP" || Number(integrationSummary[2]) > 0) {
      record("real CLI integration probe", "SKIP", `official CLI integration probe reported ${integrationSummary[2]} skipped checks; skipped checks are not passes`);
    } else {
      record("real CLI integration probe", "PASS", "official CLI integration probe passed against the fresh security TGZ");
    }
  }

  // Registered low-cap regression: this is a separate required host check,
  // not a unit-only assertion. It uses the same freshly packed candidate TGZ
  // and verifies source/installed identities plus strict child cleanup.
  if (securityTgz === undefined || !existsSync(securityTgz)) {
    skip("real CLI registered malformed UTF-8 output-cap probe", "security pre-pack did not produce the target TGZ");
  } else if (process.platform !== "win32") {
    skip("real CLI registered malformed UTF-8 output-cap probe", "requires the Windows CLI host");
  } else {
    const outputCapScript = join(root, "dev", "测试", "CLI", "cli-output-cap.mjs");
    const capProbe = spawnSync(process.execPath, [outputCapScript], {
      cwd: root,
      encoding: "utf8",
      timeout: 180_000,
      windowsHide: true,
      env: isolatedEnvironment({ DSH_PLUGIN_TGZ: securityTgz }),
    });
    const capCleanup = cleanupSpawnTree(capProbe);
    const capOutput = `${capProbe.stdout ?? ""}${capProbe.stderr ?? ""}`.trim();
    const capEvidencePath = /Evidence:\s*(.+)\s*$/im.exec(capOutput)?.[1]?.trim();
    let capEvidence;
    if (capEvidencePath !== undefined && existsSync(capEvidencePath)) {
      try { capEvidence = JSON.parse(readFileSync(capEvidencePath, "utf8")); } catch {}
    }
    const capCheck = capEvidence?.checks?.find((check) => check?.id === "CLI-OUTPUT-CAP-01");
    const capProcess = capCheck?.evidence?.process;
    const capProbeChecks = capCheck?.evidence?.probe?.checks;
    const capDedicatedChecks = Array.isArray(capProbeChecks)
      ? capProbeChecks.filter((check) =>
        check?.id === "CLI-OUTPUT-CAP-01 registered wsl_bash and git_bash cap malformed UTF-8")
      : [];
    const capDedicatedCheck = capDedicatedChecks.length === 1 ? capDedicatedChecks[0] : undefined;
    const wslStderrMerged = capDedicatedCheck?.evidence?.wsl_stderr_merged;
    const wslStderrMergedOk = capDedicatedCheck?.status === "PASS"
      && wslMergedStderrCapEvidenceIsStrict(wslStderrMerged);
    const capHostOk = capEvidence?.host?.cliVersion === expectedCliVersion
      && capEvidence?.host?.pluginTgzSha256 === fileSha256(securityTgz)
      && pluginDistIdentityIsClean(capEvidence?.host)
      && probeIdentityIsClean(capEvidence?.host, sourceProbeIndexSha256);
    const capComplete = capProbe.status === 0
      && childLifecycleIsClean(capProcess)
      && capEvidence?.status === "PASS"
      && capCheck?.status === "PASS"
      && wslStderrMergedOk
      && capHostOk
      && capEvidence?.cleanup?.temporaryRootRemoved === true;
    if (capEvidence?.status === "SKIP") {
      skip("real CLI registered malformed UTF-8 output-cap probe", capCheck?.detail ?? "registered low-cap capability was unavailable");
    } else if (capComplete) {
      record("real CLI registered malformed UTF-8 output-cap probe", "PASS", "registered wsl_bash and git_bash passed the malformed UTF-8 low-cap probe against the fresh candidate TGZ");
    } else {
      record("real CLI registered malformed UTF-8 output-cap probe", "FAIL",
        `CLI output-cap evidence incomplete: child=${capProbe.status}; process=${childLifecycleIsClean(capProcess) ? "clean" : "unclean"}; dedicated=${capDedicatedChecks.length}/${capDedicatedCheck?.status ?? "missing"}; merged-stderr=${wslStderrMergedOk ? "valid" : "invalid"}; host=${capHostOk ? "match" : "mismatch"}; cleanup=${capEvidence?.cleanup?.temporaryRootRemoved === true ? "removed" : "unproven"}`);
    }
  }

  // Seed a generated-output sentinel before the build. The build must remove
  // the complete old dist tree before tsc writes new output, otherwise a stale
  // file could silently enter the release tarball.
  const staleSentinelPath = join(root, "dist", "stale-secret.js");
  plantStaleDistSentinel(staleSentinelPath);

  // Pack commands disable lifecycle hooks with the selected tool's syntax, so
  // build explicitly before inspecting the release archive. This also works
  // from a clean checkout where dist/ has not been generated yet.
  const npm = packageManagerExecutable();
  const build = run("build", npm, ["run", "build"], { timeout: 180_000 });
  if (!build.ok) {
    record("stale dist cleanup", "FAIL", "build failed before the stale-output sentinel could be validated");
  } else if (existsSync(staleSentinelPath)) {
    record("stale dist cleanup", "FAIL", "build left dist/stale-secret.js behind");
  } else {
    record("stale dist cleanup", "PASS", "build removed the pre-existing dist sentinel");
  }
  // Standalone native-mode regressions are part of this release gate. The
  // validator is independent; the helper contract is deliberately after the
  // formal clean build so it executes the current dist artifact only.
  runNativeStandaloneContractChecks(build);

  // DSH's launcher expects a profile manifest plus an empty user patch. The
  // plugin must be installed into this throw-away profile so its bundle
  // metadata, peer line, and patch layer are exercised together.
  writeFileSync(join(dshProfileDir, "cordis.patch.yml"), "[]\n");
  writeFileSync(join(dshProfileDir, "cordis.yml"), "[]\n");
  writeFileSync(join(dshProfileDir, "package.json"), JSON.stringify({
    name: `dsh-profile-${dshProfileName}`,
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: [] } },
  }, null, 2) + "\n");

  const packCli = selectedPackCli?.path ?? npm;
  const packToolLabel = selectedPackCli === undefined ? "npm" : "pnpm";
  const dryRunArgs = selectedPackCli === undefined
    ? ["pack", "--dry-run", "--ignore-scripts"]
    : ["--config.ignore-scripts=true", "pack", "--dry-run"];
  const dryRun = run(`${packToolLabel} pack --dry-run`, packCli, dryRunArgs, { timeout: 120_000 });

  const packArgs = selectedPackCli === undefined
    ? ["pack", "--ignore-scripts", "--pack-destination", temporary]
    : ["--config.ignore-scripts=true", "pack", "--pack-destination", temporary];
  const pack = run(`${packToolLabel} pack tarball`, packCli, packArgs, {
    cwd: root,
    timeout: 120_000,
  });
  // npm's human-readable notice stream differs between npm versions. The
  // package filename itself is deterministic from the metadata we just read.
  const packedName = pack.ok ? `${expectedName}-${expectedVersion}.tgz` : undefined;
  const tarball = packedName ? join(temporary, packedName) : undefined;
  if (pack.ok) {
    inspectTarball(tarball);
  }
  if (securityTgz !== undefined && tarball !== undefined && existsSync(securityTgz) && existsSync(tarball)) {
    const securitySha = fileSha256(securityTgz);
    const finalSha = fileSha256(tarball);
    record("security/final TGZ identity", securitySha === finalSha ? "PASS" : "FAIL", securitySha === finalSha
      ? `security and final pack use SHA-256 ${finalSha}`
      : `security pre-pack ${securitySha} differs from final pack ${finalSha}`);
  } else {
    record("security/final TGZ identity", "FAIL", "security or final TGZ was not produced");
  }
  const rootTgz = join(root, `${expectedName}-${expectedVersion}.tgz`);
  const finalIdentityTarget = nativeModesCandidate.kind === "present"
    ? nativeModesCandidate.path
    : rootTgz;
  const finalIdentityLabel = nativeModesCandidate.kind === "present"
    ? "candidate/final TGZ identity"
    : "root/final TGZ identity";
  if (tarball !== undefined && existsSync(tarball) && existsSync(finalIdentityTarget)) {
    const finalSha = fileSha256(tarball);
    const targetSha = fileSha256(finalIdentityTarget);
    const sameBytes = finalSha === targetSha
      && readFileSync(tarball).byteLength === readFileSync(finalIdentityTarget).byteLength;
    record(finalIdentityLabel, sameBytes ? "PASS" : "FAIL", sameBytes
      ? `${nativeModesCandidate.kind === "present" ? "candidate" : "root TGZ"} and final pack are byte-identical at SHA-256 ${targetSha}`
      : `${nativeModesCandidate.kind === "present" ? "candidate" : "root TGZ"} ${targetSha} differs from final pack ${finalSha}`);
  } else {
    record(finalIdentityLabel, "FAIL", `${nativeModesCandidate.kind === "present" ? "candidate" : "root"} or final TGZ was not produced`);
  }

  const desktopProbe = join(root, "dev", "测试", "桌面", "desktop-context-probe.mjs");
  const preservedOldTgz = join(root, "dsh-plugin-bash-wsl-0.1.0.tgz");
  let desktopRuntimeNegativeOk = false;
  let d14OldVersionRejectionStatus = "SKIP";
  let d14OldVersionRejectionDetail = "actual rc.2 old-version runtime rejection was not attempted";
  if (process.platform !== "win32") {
    skip("D-14 runtime-negative: actual rc.2 loader", "requires the Windows Desktop Electron host; WSL is not a Desktop target");
  } else if (!existsSync(preservedOldTgz)) {
    skip("D-14 runtime-negative: actual rc.2 loader", "preserved 0.1.0 TGZ fixture is unavailable");
  } else if (!existsSync(desktopProbe)) {
    record("D-14 runtime-negative: actual rc.2 loader", "FAIL", "dev/测试/桌面/desktop-context-probe.mjs is missing");
  } else {
    const runtimeNegative = spawnSync(process.execPath, [desktopProbe, "--desktop-runtime-negative", "--tgz", preservedOldTgz], {
      cwd: root,
      encoding: "utf8",
      timeout: 180_000,
      windowsHide: true,
      env: {
        ...isolatedEnvironment(),
        DSH_TELEMETRY_DISABLED: "1",
        DSH_TELEMETRY_MODE: "DISABLED",
      },
    });
    const runtimeNegativeOutput = `${runtimeNegative.stdout ?? ""}${runtimeNegative.stderr ?? ""}`.trim();
    const runtimeNegativeEvidenceText = /Evidence:\s*(.+)\s*$/im.exec(runtimeNegativeOutput)?.[1]?.trim();
    const runtimeNegativeEvidencePath = runtimeNegativeEvidenceText === undefined
      ? undefined
      : resolve(root, runtimeNegativeEvidenceText);
    let runtimeNegativeEvidence;
    if (runtimeNegativeEvidencePath !== undefined && existsSync(runtimeNegativeEvidencePath)) {
      try {
        runtimeNegativeEvidence = JSON.parse(readFileSync(runtimeNegativeEvidencePath, "utf8"));
      } catch (error) {
        record("D-14 runtime-negative: actual rc.2 loader", "FAIL", `runtime-negative evidence JSON could not be read: ${error.message}`);
      }
    }
    if (runtimeNegativeEvidence?.status === "SKIP") {
      d14OldVersionRejectionStatus = "SKIP";
      d14OldVersionRejectionDetail = runtimeNegativeEvidence.qualification ?? "actual Desktop loader capability was unavailable";
      skip("D-14 runtime-negative: actual rc.2 loader", runtimeNegativeEvidence.qualification ?? "actual Desktop loader capability was unavailable");
      skip("D-14 full runtime-negative context", runtimeNegativeEvidence.fullD14Qualification ?? "actual Desktop context capability was unavailable");
    } else {
      const loaderNegativeOk = runtimeNegativeEvidence !== undefined
        && desktopRuntimeNegativeIsClean(runtimeNegativeEvidence, preservedOldTgz);
      if (loaderNegativeOk) {
        record("D-14 runtime-negative: actual rc.2 loader", "PASS", "actual rc.2 loader rejected the preserved rc.6-peer plugin; host/TGZ SHA, active-layer omission, and loader child cleanup identities match");
      } else {
        d14OldVersionRejectionStatus = "FAIL";
        d14OldVersionRejectionDetail = runtimeNegativeEvidence?.qualification
          ?? "actual rc.2 loader rejection evidence failed its identity/lifecycle assertions";
        record("D-14 runtime-negative: actual rc.2 loader", "FAIL", (runtimeNegativeEvidence?.qualification
          ?? `structured runtime-negative evidence was unavailable (exit=${runtimeNegative.status}, output=${runtimeNegativeOutput.slice(-900)})`).replace(/\s+/g, " "));
      }
      if (loaderNegativeOk && runtimeNegativeEvidence !== undefined
        && desktopRuntimeNegativeContextIsClean(runtimeNegativeEvidence)) {
        desktopRuntimeNegativeOk = true;
        d14OldVersionRejectionStatus = "PASS";
        d14OldVersionRejectionDetail = "actual rc.2 loader and runProfile/Host context independently rejected the old peer and proved old tool/prompt absence with strict identities and cleanup";
        record("D-14 full runtime-negative context", "PASS", "actual rc.2 runProfile mounted the owned old fixture and proved no old tools/prompt registration with clean Host child lifecycle");
      } else if (runtimeNegativeEvidence?.fullD14Status === "SKIP") {
        if (loaderNegativeOk) {
          d14OldVersionRejectionStatus = "SKIP";
          d14OldVersionRejectionDetail = runtimeNegativeEvidence.fullD14Qualification ?? "actual Desktop context audit was unavailable";
        }
        skip("D-14 full runtime-negative context", runtimeNegativeEvidence.fullD14Qualification ?? "actual Desktop context audit was unavailable");
      } else {
        d14OldVersionRejectionStatus = "FAIL";
        d14OldVersionRejectionDetail = runtimeNegativeEvidence?.fullD14Qualification
          ?? "full runtime-negative context evidence was unavailable";
        record("D-14 full runtime-negative context", "FAIL", runtimeNegativeEvidence?.fullD14Qualification
          ?? "full runtime-negative context evidence was unavailable");
      }
    }
  }
  if (d14OldVersionRejectionStatus === "PASS") {
    record("D-14 old-version runtime rejection", "PASS", d14OldVersionRejectionDetail);
  } else if (d14OldVersionRejectionStatus === "SKIP") {
    skip("D-14 old-version runtime rejection", d14OldVersionRejectionDetail);
  } else {
    record("D-14 old-version runtime rejection", "FAIL", d14OldVersionRejectionDetail);
  }
  if (!tarball || !existsSync(tarball)) {
    skip("real Desktop context probe", "the local TGZ was not created");
  } else if (process.platform !== "win32") {
    skip("real Desktop context probe", "requires Windows Node and the installed Desktop Electron host; this release-check process is not win32");
  } else if (!existsSync(desktopProbe)) {
    record("real Desktop context probe", "FAIL", "dev/测试/桌面/desktop-context-probe.mjs is missing");
  } else {
    const probe = spawnSync(process.execPath, [desktopProbe, "--tgz", tarball, "--no-answerer"], {
      cwd: root,
      encoding: "utf8",
      timeout: 900_000,
      windowsHide: true,
      env: {
        ...isolatedEnvironment(),
        DSH_TELEMETRY_DISABLED: "1",
        DSH_TELEMETRY_MODE: "DISABLED",
      },
    });
    const probeCleanup = cleanupSpawnTree(probe);
    const probeOutput = `${probe.stdout ?? ""}${probe.stderr ?? ""}`.trim();
    const probeSummary = /Desktop probe:\s+\d+ passed,\s+\d+ skipped,\s+\d+ failed/i.exec(probeOutput)?.[0];
    const desktopEvidencePath = /Evidence:\s*(.+)\s*$/im.exec(probeOutput)?.[1]?.trim();
    let desktopEvidence;
    if (desktopEvidencePath !== undefined && existsSync(desktopEvidencePath)) {
      try {
        desktopEvidence = JSON.parse(readFileSync(desktopEvidencePath, "utf8"));
      } catch {}
    }
    const desktopTopRequiredIds = [
      "desktop-runtime:version",
      "desktop-runtime:host-entry",
      "desktop-runtime:hash",
      "desktop-profile:offline-install",
      "desktop-profile:probe-identity",
      "desktop-negative:missing-tgz",
      "desktop-negative:malformed-tgz",
      "desktop-protected-profile-integrity",
    ];
    // The preserved old TGZ's ordinary pnpm --offline install remains a
    // diagnostic SKIP when its generic dependency cache is absent. It is not
    // the D-14 version-compatibility assertion; that required assertion is
    // recorded separately below from the actual rc.2 loader and Host context.
    const desktopSecurityRequiredIds = [
      "CLI-01 official services, version, and registration",
      ...requiredSecurityCheckIds,
    ];
    const desktopPresetRequiredIds = [
      "desktop-context:agent-preset-resolution",
      "desktop-context:agent-preset-mount",
    ];
    const expectedDesktopPhases = ["present", "present-read-only", "present-full-access", "absent", "reloaded"];
    const phaseEntries = Array.isArray(desktopEvidence?.phases) ? desktopEvidence.phases : [];
    const phaseByLabel = new Map(phaseEntries.map((phase) => [phase?.label, phase]));
    const desktopTopChecks = Array.isArray(desktopEvidence?.checks) ? desktopEvidence.checks : [];
    const topCheckAudits = desktopTopRequiredIds.map((id) => desktopTopChecks.filter((check) => check?.id === id));
    const desktopInstallCheck = desktopTopChecks.find((check) => check?.id === "desktop-profile:offline-install");
    const installerCleanupOk = desktopInstallCheck?.status === "PASS"
      && desktopInstallCheck?.evidence?.closeObserved === true
      && desktopInstallCheck?.evidence?.reaped === true;
    const desktopOldPnpmCacheDiagnostics = desktopEvidence?.diagnostics?.oldVersionPnpmCache;
    const desktopOldPnpmCacheDiagnosticOk = Array.isArray(desktopOldPnpmCacheDiagnostics)
      && desktopOldPnpmCacheDiagnostics.length > 0
      && desktopOldPnpmCacheDiagnostics.every((entry) => entry?.status === "SKIP"
        && entry?.evidence?.inputClass === "old-version-tgz"
        && entry?.evidence?.processProof === true
        && entry?.evidence?.timedOut === false
        && entry?.evidence?.error == null
        && entry?.evidence?.cleanup?.closeObserved === true
        && entry?.evidence?.cleanup?.reaped === true)
      && !desktopTopChecks.some((check) => check?.id === "desktop-negative:old-version-tgz");
    // Missing/malformed typed rejection remains a hard negative gate. The
    // old-version pnpm path is deliberately excluded: its cache diagnostics
    // cannot substitute for, or veto, the actual-host old-version rejection.
    const negativeInstallCleanupOk = ["desktop-negative:missing-tgz", "desktop-negative:malformed-tgz"]
      .map((id) => desktopTopChecks.find((check) => check?.id === id))
      .every((check) => check?.status === "PASS"
        && check?.evidence?.cleanup?.closeObserved === true
        && check?.evidence?.cleanup?.reaped === true);
    const topChecksComplete = topCheckAudits.every((matches) => matches.length === 1 && matches[0].status === "PASS")
      && installerCleanupOk
      && negativeInstallCleanupOk;
    const phaseShapeOk = phaseEntries.length === expectedDesktopPhases.length
      && expectedDesktopPhases.every((label) => phaseByLabel.has(label));
    const phaseAudits = expectedDesktopPhases.map((label) => {
      const phase = phaseByLabel.get(label);
      const checks = Array.isArray(phase?.evidence?.checks) ? phase.evidence.checks : [];
      const processCleanup = desktopTopChecks.find((check) => check?.id === `${label}:process-cleanup`);
      const peerManifestCheck = checks.filter((check) => check?.id === "desktop-runtime:peer-manifests");
      const presetChecks = desktopPresetRequiredIds.map((id) => checks.filter((check) => check?.id === id));
      const promptChecks = ["desktop-context:system-prompt", "desktop-context:prompt-tool-schemas"]
        .map((id) => checks.filter((check) => check?.id === id));
      const securityPhase = label === "present" || label === "present-read-only" || label === "present-full-access";
      const sharedChecks = desktopSecurityRequiredIds.map((id) => checks.filter((check) => check?.id === `desktop-context:shared-security:${id}`));
      const sharedAggregate = checks.filter((check) => check?.id === "desktop-context:shared-security");
      const sharedComplete = !securityPhase || (
        sharedAggregate.length === 1
        && sharedAggregate[0].status === "PASS"
        && sharedChecks.every((matches) => matches.length === 1 && matches[0].status === "PASS")
      );
      const childClean = phase?.close?.code === 0
        && phase?.close?.timedOut === false
        && phase?.close?.error == null
        && phase?.close?.kill?.closeObserved === true
        && phase?.close?.kill?.reaped === true
        && phase?.close?.kill?.aliveAfter === false
        && processCleanup?.status === "PASS"
        && processCleanup?.evidence?.closeObserved === true
        && processCleanup?.evidence?.reaped === true;
      return {
        label,
        present: phase !== undefined,
        childClean,
        peerManifestComplete: peerManifestCheck.length === 1 && peerManifestCheck[0].status === "PASS",
        presetComplete: presetChecks.every((matches) => matches.length === 1 && matches[0].status === "PASS"),
        promptComplete: promptChecks.every((matches) => matches.length === 1 && matches[0].status === "PASS"),
        sharedComplete,
        phaseStatus: phase?.evidence?.status ?? null,
        missingShared: securityPhase ? desktopSecurityRequiredIds.filter((id, index) => sharedChecks[index]?.length !== 1).join(",") : "",
      };
    });
    const desktopHashOk = desktopEvidence?.package?.tgzSha256 === fileSha256(tarball);
    const desktopProbeIdentityOk = probeIdentityIsClean({
      probeSourceIndexSha256: desktopEvidence?.probeIdentity?.sourceProbeIndexSha256,
      probeInstalledIndexSha256: desktopEvidence?.probeIdentity?.installedProbeIndexSha256,
      probeIndexHashesMatch: desktopEvidence?.probeIdentity?.probeIndexHashesMatch,
      probeObserverRequired: desktopEvidence?.probeIdentity?.probeObserverRequired,
      probeSourceObserverSha256: desktopEvidence?.probeIdentity?.probeSourceObserverSha256
        ?? desktopEvidence?.probeIdentity?.sourceProbeObserverSha256,
      probeInstalledObserverSha256: desktopEvidence?.probeIdentity?.probeInstalledObserverSha256
        ?? desktopEvidence?.probeIdentity?.installedProbeObserverSha256,
      probeObserverHashesMatch: desktopEvidence?.probeIdentity?.probeObserverHashesMatch,
    }, sourceProbeIndexSha256);
    const desktopRuntimeOk = desktopEvidence?.target === "Desktop 0.2.1-rc.2 / plugin 0.2.2"
      && desktopTopChecks.find((check) => check?.id === "desktop-runtime:version")?.status === "PASS";
    const desktopApprovalVariantOk = desktopEvidence?.approvalVariant?.mode === "no-remote-answerer"
      && desktopEvidence?.approvalVariant?.disabled === true
      && Array.isArray(desktopEvidence?.approvalVariant?.rowIds)
      && desktopEvidence.approvalVariant.rowIds.length === 1
      && desktopEvidence.approvalVariant.rowIds[0] === "api-remotes";
    const desktopCleanupOk = desktopEvidence?.cleanup?.temporaryRootRemoved === true
      && phaseAudits.every((audit) => audit.childClean);
    const desktopIntegrationPhase = desktopEvidence?.integration;
    const desktopIntegrationChecks = desktopTopChecks.filter((check) => String(check?.id).startsWith("desktop-integration:desktop-context:shared-integration:"));
    const desktopIntegrationIds = requiredIntegrationIds.map((id) => desktopIntegrationChecks.filter((check) => check.id === `desktop-integration:desktop-context:shared-integration:${id}`));
    const desktopIntegrationComplete = desktopIntegrationPhase?.close?.code === 0
      && desktopIntegrationPhase?.close?.timedOut === false
      && desktopIntegrationPhase?.close?.error == null
      && desktopIntegrationPhase?.close?.kill?.closeObserved === true
      && desktopIntegrationPhase?.close?.kill?.reaped === true
      && desktopIntegrationPhase?.close?.kill?.aliveAfter === false
      && desktopIntegrationPhase?.evidence?.status === "PASS"
      && desktopTopChecks.find((check) => check?.id === "desktop-integration:desktop-context:shared-integration")?.status === "PASS"
      && desktopIntegrationIds.every((matches) => matches.length === 1 && matches[0].status === "PASS");
    const desktopEvidenceComplete = desktopEvidence !== undefined
      && probe.status === 0
      && desktopEvidence.status === "PASS"
      && desktopHashOk
      && desktopProbeIdentityOk
      && desktopRuntimeOk
      && desktopRuntimeNegativeOk
        && desktopApprovalVariantOk
        && desktopOldPnpmCacheDiagnosticOk
      && desktopCleanupOk
      && topChecksComplete
      && phaseShapeOk
      && phaseAudits.every((audit) => audit.phaseStatus === "PASS"
        && audit.sharedComplete
        && audit.peerManifestComplete
        && audit.presetComplete
        && audit.promptComplete)
      && desktopIntegrationComplete;
    if (probe.error || probe.status === null || probeCleanup?.reaped === false || desktopEvidence === undefined || probeSummary === undefined || !desktopEvidenceComplete) {
      const hasFail = /\bFAIL\b|\b[1-9]\d* failed\b/i.test(probeOutput);
      const hasSkip = /\bSKIP\b|\b[1-9]\d* skipped\b/i.test(probeOutput);
      if (probeCleanup?.reaped === false) record("real Desktop context probe", "FAIL", "timed-out Desktop child process tree was not proven reaped");
      else if (desktopEvidence === undefined && hasSkip && !hasFail) skip("real Desktop context probe", `${probeSummary ?? "Desktop capability unavailable"}; structured rc.2 evidence was not available`);
      else record("real Desktop context probe", "FAIL", (probe.error?.message
            ?? `Desktop evidence incomplete: summary=${probeSummary ?? "missing"}; hash=${desktopHashOk ? "match" : "mismatch"}; probe=${desktopProbeIdentityOk ? "match" : "mismatch"}; runtime=${desktopRuntimeOk ? "match" : "mismatch"}; runtime-negative=${desktopRuntimeNegativeOk ? "pass" : "missing"}; approval=${desktopApprovalVariantOk ? "no-remote" : "unexpected"}; oldcache=${desktopOldPnpmCacheDiagnosticOk ? "diagnostic-only" : "misclassified"}; top=${topChecksComplete ? "complete" : "incomplete"}; phases=${phaseShapeOk ? "complete" : "incomplete"}; preset=${phaseAudits.filter((audit) => !audit.presetComplete).map((audit) => audit.label).join(",") || "complete"}; cleanup=${desktopCleanupOk ? "proven" : "unproven"}; shared=${phaseAudits.filter((audit) => !audit.sharedComplete).map((audit) => audit.label).join(",") || "complete"}; integration=${desktopIntegrationComplete ? "complete" : "incomplete"}`).slice(-1200));
    } else {
      record("real Desktop context probe", "PASS", `${probeSummary}; rc.2 JSON, per-phase SEC01-16, fresh TGZ SHA, and child cleanup verified`);
    }
  }

  // Registered low-cap Desktop regression: the dedicated output-cap suite
  // applies a test-only 4/8-byte profile overlay and exercises real
  // wsl_bash/git_bash registrations in the rc.2 Host context. Its aggregate
  // may retain the ordinary old-cache SKIP, so gate the dedicated PASS IDs and
  // strict identity/cleanup instead of treating the aggregate as PASS.
  if (securityTgz === undefined || !existsSync(securityTgz)) {
    skip("real Desktop registered malformed UTF-8 output-cap probe", "security pre-pack did not produce the target TGZ");
  } else if (process.platform !== "win32" || !existsSync(desktopProbe)) {
    skip("real Desktop registered malformed UTF-8 output-cap probe", "requires the Windows Desktop probe host");
  } else {
    const desktopCapProbe = spawnSync(process.execPath, [
      desktopProbe,
      "--tgz",
      securityTgz,
      "--phase",
      "present",
      "--suite",
      "output-cap",
    ], {
      cwd: root,
      encoding: "utf8",
      timeout: 900_000,
      windowsHide: true,
      env: {
        ...isolatedEnvironment(),
        DSH_TELEMETRY_DISABLED: "1",
        DSH_TELEMETRY_MODE: "DISABLED",
      },
    });
    const desktopCapCleanup = cleanupSpawnTree(desktopCapProbe);
    const desktopCapOutput = `${desktopCapProbe.stdout ?? ""}${desktopCapProbe.stderr ?? ""}`.trim();
    const desktopCapEvidencePath = /Evidence:\s*(.+)\s*$/im.exec(desktopCapOutput)?.[1]?.trim();
    let desktopCapEvidence;
    if (desktopCapEvidencePath !== undefined && existsSync(desktopCapEvidencePath)) {
      try { desktopCapEvidence = JSON.parse(readFileSync(desktopCapEvidencePath, "utf8")); } catch {}
    }
    const desktopCapChecks = Array.isArray(desktopCapEvidence?.checks) ? desktopCapEvidence.checks : [];
    const desktopCapCheck = (id) => desktopCapChecks.find((check) => check?.id === id);
      const desktopCapDedicatedCheck = desktopCapChecks.find((check) =>
        String(check?.id).startsWith("present:desktop-context:shared-output-cap:CLI-OUTPUT-CAP-01"));
    const desktopWslStderrMerged = desktopCapDedicatedCheck?.evidence?.wsl_stderr_merged;
    const desktopWslStderrMergedOk = wslMergedStderrCapEvidenceIsStrict(desktopWslStderrMerged);
    const desktopCapPhase = desktopCapEvidence?.phases?.find((phase) => phase?.label === "present");
    const desktopCapHasOnlyExpectedSkips = desktopCapPhase?.evidence?.status === "SKIP"
      && desktopCapChecks.every((check) => check?.status !== "FAIL");
    // The dedicated cap suite owns the low-cap assertions, while the ordinary
    // marker checks and old offline-cache diagnostic remain explicit SKIPs.
    // The Desktop child may therefore exit 1 for that SKIP-only aggregate; it
    // is accepted here only with the raw close/reap/error fields still clean.
    const desktopCapPhaseClean = (desktopCapPhase?.close?.code === 0
      || (desktopCapPhase?.close?.code === 1 && desktopCapHasOnlyExpectedSkips))
      && desktopCapPhase?.close?.timedOut === false
      && desktopCapPhase?.close?.error == null
      && desktopCapPhase?.close?.kill?.closeObserved === true
      && desktopCapPhase?.close?.kill?.reaped === true
      && desktopCapPhase?.close?.kill?.aliveAfter === false;
    const desktopCapHostOk = desktopCapEvidence?.target === "Desktop 0.2.1-rc.2 / plugin 0.2.2"
      && desktopCapEvidence?.package?.tgzSha256 === fileSha256(securityTgz)
      && probeIdentityIsClean({
        probeSourceIndexSha256: desktopCapEvidence?.probeIdentity?.sourceProbeIndexSha256,
        probeInstalledIndexSha256: desktopCapEvidence?.probeIdentity?.installedProbeIndexSha256,
        probeIndexHashesMatch: desktopCapEvidence?.probeIdentity?.probeIndexHashesMatch,
        probeObserverRequired: desktopCapEvidence?.probeIdentity?.probeObserverRequired,
        probeSourceObserverSha256: desktopCapEvidence?.probeIdentity?.probeSourceObserverSha256
          ?? desktopCapEvidence?.probeIdentity?.sourceProbeObserverSha256,
        probeInstalledObserverSha256: desktopCapEvidence?.probeIdentity?.probeInstalledObserverSha256
          ?? desktopCapEvidence?.probeIdentity?.installedProbeObserverSha256,
        probeObserverHashesMatch: desktopCapEvidence?.probeIdentity?.probeObserverHashesMatch,
      }, sourceProbeIndexSha256);
    const desktopCapComplete = (desktopCapProbe.status === 0
      || (desktopCapProbe.status === 1 && desktopCapHasOnlyExpectedSkips))
      && desktopCapPhaseClean
      && desktopCapHostOk
      && desktopCapCheck("desktop-profile:offline-install")?.status === "PASS"
      && desktopCapCheck("desktop-profile:probe-identity")?.status === "PASS"
      && desktopCapCheck("present:desktop-context:agent-preset-resolution")?.status === "PASS"
      && desktopCapCheck("present:desktop-context:agent-preset-mount")?.status === "PASS"
      && desktopCapCheck("present:desktop-context:tool-registration")?.status === "PASS"
      && desktopCapCheck("present:desktop-context:system-prompt")?.status === "PASS"
      && desktopCapCheck("present:desktop-context:prompt-tool-schemas")?.status === "PASS"
      && desktopCapCheck("present:desktop-context:shared-output-cap")?.status === "PASS"
        && desktopCapDedicatedCheck?.status === "PASS"
      && desktopWslStderrMergedOk
      && desktopCapCheck("present:process-cleanup")?.status === "PASS"
      && desktopCapCheck("desktop-protected-profile-integrity")?.status === "PASS"
      && desktopCapEvidence?.cleanup?.temporaryRootRemoved === true;
    if (desktopCapEvidence?.status === "SKIP" && !desktopCapComplete) {
        const dedicated = desktopCapDedicatedCheck;
      if (dedicated?.status === "SKIP") {
        skip("real Desktop registered malformed UTF-8 output-cap probe", dedicated.detail ?? "registered Desktop low-cap capability was unavailable");
      } else {
        record("real Desktop registered malformed UTF-8 output-cap probe", "FAIL", `dedicated output-cap evidence incomplete: host=${desktopCapHostOk ? "match" : "mismatch"}; phase=${desktopCapPhaseClean ? "clean" : "unclean"}; cleanup=${desktopCapEvidence?.cleanup?.temporaryRootRemoved === true ? "removed" : "unproven"}`);
      }
    } else if (desktopCapComplete) {
      record("real Desktop registered malformed UTF-8 output-cap probe", "PASS", "registered wsl_bash and git_bash passed the malformed UTF-8 low-cap probe in actual rc.2 context against the fresh candidate TGZ");
    } else {
      const failedDedicated = desktopCapChecks.filter((check) => check?.status === "FAIL").map((check) => check.id).join(",");
      record("real Desktop registered malformed UTF-8 output-cap probe", "FAIL", `Desktop output-cap evidence incomplete: failed=${failedDedicated || "none"}; host=${desktopCapHostOk ? "match" : "mismatch"}; phase=${desktopCapPhaseClean ? "clean" : "unclean"}; child=${desktopCapCleanup?.reaped === false ? "unreaped" : "reaped-or-not-timed-out"}`);
    }
  }

  // Opt-in native-mode qualification.  The detailed test-only orchestration
  // lives under dev/测试/桌面; this hook keeps release-check's legacy matrix and
  // D14/D16 behavior unchanged when --candidate-tgz is omitted.
  if (nativeModesCandidate.kind === "present") {
    const cliManifestPath = actualCliManifestPath();
    const nativeModesResults = runNativeModesReleaseGate({
      candidateInput: nativeModesCandidate,
      cliNativeInput: nativeModesCliInput,
      guiRosterInput: nativeModesGuiInput,
      tarball,
      rootTgz,
      root,
      runOutputRoot,
      expectedAsarSha256: expectedDesktopAsarSha256,
      expectedExecutableSha256: expectedDesktopExecutableSha256,
      expectedCliVersion,
      expectedCliPackageSha256: cliManifestPath === undefined
        ? undefined
        : fileSha256(cliManifestPath),
      cliProbeSourceSha256: existsSync(sourceProbeIndexPath) ? fileSha256(sourceProbeIndexPath) : undefined,
      cliProbeObserverSha256: sourceProbeObserverSha256,
      nativeModesDesktopProbePath,
      desktopPaths: installedDesktopPathsForGate(),
      securityStatus: results.find((entry) => entry.label === "real security probe (PTY geometry + interop escape)")?.status,
      cliStatus: results.find((entry) => entry.label === "real CLI integration probe")?.status,
      platform: process.platform,
      fileSha256,
      cleanupSpawnTree,
      environment: {
        ...isolatedEnvironment(),
        DSH_TELEMETRY_DISABLED: "1",
        DSH_TELEMETRY_MODE: "DISABLED",
      },
    });
    for (const result of nativeModesResults) {
      if (result.status === "SKIP") skip(result.label, result.detail);
      else record(result.label, result.status, result.detail);
    }
  }

  if (tarball && existsSync(tarball)) {
    const profileManifest = {
      name: `dsh-profile-${dshProfileName}`,
      private: true,
      dependencies: {
        ...localPeerDependencies(),
        [expectedName]: `file:${tarball}`,
      },
      dsh: {
        profile: {
          bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless", expectedName],
        },
      },
    };
    writeFileSync(join(dshProfileDir, "package.json"), JSON.stringify(profileManifest, null, 2) + "\n");
    const install = run("temporary profile install", npm, [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--offline",
      tarball,
    ], { cwd: dshProfileDir, timeout: 180_000 });
    if (install.ok) {
      const installed = existsSync(join(dshProfileDir, "node_modules", expectedName));
      if (installed) {
        profileInstalled = true;
        record("temporary profile package presence", "PASS", expectedName);
      }
      else record("temporary profile package presence", "FAIL", "package directory was not created");
      const dumpManifest = readFileSync(join(dshProfileDir, "package.json"), "utf8");
      if (!dumpManifest.includes(`"${expectedName}"`)) {
        record("temporary profile manifest", "FAIL", `${expectedName} dependency missing after install`);
      }
    }
  } else {
    skip("temporary profile install", "no tarball was created");
  }

  const dsh = process.env.DSH_BIN || (process.platform === "win32" ? "dsh.cmd" : "dsh");
  if (!profileInstalled) {
    skip("dsh --dump-config", "temporary profile install did not pass");
  } else {
    const dshProbe = run("dsh --dump-config", dsh, ["--profile", dshProfileName, "--dump-config"], {
    cwd: root,
    env: isolatedEnvironment({
      DSH_HOME: dshHome,
      DSH_PROFILE: dshProfileName,
    }),
    timeout: 60_000,
    skipIfMissing: true,
    });
    if (dshProbe.ok) {
      const dump = dshProbe.output;
    const requiredRows = [
      "# == dsh-plugin-bash-wsl",
      "name: '@deepseek-ai/dsh-terminal'",
      "name: dsh-plugin-bash-wsl",
      "name: '@deepseek-ai/dsh-tool-pwsh'",
    ];
    const missingRows = requiredRows.filter((row) => !dump.includes(row));
    // The actual CLI serializer emits this ordinary YAML scalar without quotes.
    const persistentBundleRowPattern = /^\s*(?:-\s*)?name:\s*(?:dsh-plugin-bash-wsl\/persistent|'dsh-plugin-bash-wsl\/persistent'|"dsh-plugin-bash-wsl\/persistent")\s*$/m;
    if (!persistentBundleRowPattern.test(dump)) {
      missingRows.push("name: dsh-plugin-bash-wsl/persistent");
    }
    const windowsShellGuards =
      "name: '@deepseek-ai/dsh-tool-bash'\n  disabled: !!js process.platform === 'win32'";
    const windowsPwshGuard =
      "name: '@deepseek-ai/dsh-tool-pwsh'\n  disabled: !!js process.platform !== 'win32'";
      if (missingRows.length > 0 || !dump.includes(windowsShellGuards) || !dump.includes(windowsPwshGuard)) {
        if (!dump.includes(windowsShellGuards)) missingRows.push("Windows tool-bash disabled guard");
        if (!dump.includes(windowsPwshGuard)) missingRows.push("Windows tool-pwsh guard");
        record("dsh --dump-config", "FAIL", `missing bundle rows: ${missingRows.join(", ")}`);
      }
    }
  }

  if (process.platform !== "win32") {
    skip("dsh real activation", "requires the Windows Node host; WSL process.platform=linux disables this plugin");
  } else {
  // Exercise the actual headless CLI app entry without contacting a provider:
  // an unknown session is rejected by the mounted runner before it can submit
  // a model request. Generic launcher/app help is not an activation proof.
  const activation = run("dsh real CLI tool entrance", dsh, [
    "--profile",
    dshProfileName,
    "--json",
    "--session-id",
    `release-check-missing-${process.pid}`,
    "offline release-check probe",
  ], {
    cwd: root,
    env: isolatedEnvironment({
      DSH_HOME: dshHome,
      DSH_PROFILE: dshProfileName,
    }),
    timeout: 60_000,
    acceptExitCodes: [1],
    skipIfMissing: true,
  });
    if (activation.ok) {
      const jsonError = /(?:^|\n)\s*\{\s*"type"\s*:\s*"error"/i.test(activation.output);
      const missingSession = /session ["']?release-check-missing-|does not exist|omit --session-id/i.test(activation.output);
      if (!jsonError || !missingSession) {
        record("dsh real CLI tool entrance", "FAIL", "the mounted CLI did not return the expected pre-model unknown-session error", {
          jsonError,
          missingSession,
          output: activation.output.slice(-1200),
        });
      }
    }
  }
  // D16 is opt-in because it consumes an already authorized real Desktop turn.
  // The evidence file must combine the adapter's real session ledger with an
  // independent @oai/sky observation; login/permission flags alone cannot pass.
  const d16Input = readD16EvidenceArgument();
  if (d16Input.kind === "missing") {
    skip("full release qualification (GUI D16)",
      "no --gui-evidence was supplied; authentication or model allowance alone is not GUI evidence");
  } else if (d16Input.kind === "invalid") {
    record("full release qualification (GUI D16)", "FAIL", d16Input.detail);
  } else if (d16Input.evidence?.status === "SKIP") {
    skip("full release qualification (GUI D16)",
      d16Input.evidence.qualification ?? "supplied GUI evidence reports capability unavailable");
  } else {
    const d16CandidateMode = nativeModesCandidate.kind === "present";
    const d16CandidatePath = d16CandidateMode
      ? nativeModesCandidate.path
      : tarball;
    const d16CandidateSourcePaths = {
      probe: nativeModesDesktopProbePath,
      sessionDriver: d16SessionDriverPath,
      launcher: d16GuiLauncherPath,
      wrapper: d16LauncherPath,
      candidateBinding: d16CandidateBindingPath,
    };
    const d16SourceHashes = d16CandidateMode
      ? Object.fromEntries(Object.entries(d16CandidateSourcePaths).map(([name, path]) => [
        name,
        existsSync(path) ? fileSha256(path) : undefined,
      ]))
      : undefined;
    const d16Audit = validateD16Evidence(d16Input.evidence, d16CandidatePath, {
      candidateMode: d16CandidateMode,
      expectedTgzSha256: d16CandidateMode ? fileSha256(nativeModesCandidate.path) : undefined,
      expectedDesktopAsarSha256: d16CandidateMode
        ? existsSync(installedDesktopPathsForGate()?.asar ?? "")
          ? fileSha256(installedDesktopPathsForGate().asar)
          : undefined
        : undefined,
      sourceHashes: d16SourceHashes,
      nativeProbeSourceSha256: d16CandidateMode ? d16SourceHashes?.probe : undefined,
    });
    record("full release qualification (GUI D16)", d16Audit.ok ? "PASS" : "FAIL",
      d16Audit.detail);
  }
} catch (error) {
  if (error?.code !== "RELEASE_CHECK_INPUT") throw error;
} finally {
  removeStaleDistSentinel(join(root, "dist", "stale-secret.js"));
  rmSync(temporary, { recursive: true, force: true });
}

const failed = results.filter((entry) => entry.status === "FAIL").length;
const skipped = results.filter((entry) => entry.status === "SKIP").length;
const automatedResults = results.filter((entry) => entry.label !== "full release qualification (GUI D16)");
const automatedFailed = automatedResults.filter((entry) => entry.status === "FAIL").length;
const automatedSkipped = automatedResults.filter((entry) => entry.status === "SKIP").length;
console.log(`Automated gate: ${automatedResults.length - automatedFailed - automatedSkipped} passed, ${automatedSkipped} skipped, ${automatedFailed} failed`);
const d16Result = results.find((entry) => entry.label === "full release qualification (GUI D16)");
const fullQualificationPass = d16Result?.status === "PASS"
  && automatedFailed === 0
  && automatedSkipped === 0;
console.log(fullQualificationPass
  ? "Full release qualification: PASS (D16 strict owned GUI evidence + automated gate clean)"
  : "Full release qualification: BLOCKED (D16 and automated gate must both be strict PASS)");
console.log(`\nRelease check: ${results.length - failed - skipped} passed, ${skipped} skipped, ${failed} failed`);
if (skipped > 0) console.log("Skipped checks are not passes; run the gate again on the required host capabilities before release.");
process.exitCode = failed > 0 || skipped > 0 ? 1 : 0;
