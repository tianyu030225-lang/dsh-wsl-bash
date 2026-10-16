#!/usr/bin/env node

/**
 * Offline regression for the Desktop probe's public stdout observer seam.
 * This exercises only the extracted observer function; it never starts DSH,
 * Desktop, a shell, a GUI session, or a model request.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(
  new URL("./new-modes-desktop-artifact.mjs", import.meta.url),
  "utf8",
);

function extractFunction(name) {
  const match = source.match(new RegExp(
    `function ${name}\\([\\s\\S]*?\\n\\}`,
  ));
  assert.ok(match, `${name} must remain a local pure observer function`);
  return match[0];
}

function extractBalancedFunction(name) {
  const asyncStart = source.indexOf(`async function ${name}`);
  const start = asyncStart >= 0
    ? asyncStart
    : source.indexOf(`function ${name}`);
  assert.ok(start >= 0, `${name} must remain in the probe source`);
  const signatureEnd = source.indexOf(")", start);
  const open = source.indexOf("{", signatureEnd);
  assert.ok(open >= 0, `${name} must have a function body`);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  assert.fail(`${name} function body was not balanced`);
}

const stdoutObservationScope = new Function(
  `return (${extractBalancedFunction("stdoutObservationScope")});`,
)();
const canonicalPromptStatus = new Function(
  `return (${extractBalancedFunction("canonicalPromptStatus")});`,
)();
const parsePromptControlToken = new Function(
  "canonicalPromptStatus",
  `return (${extractBalancedFunction("parsePromptControlToken")});`,
)(canonicalPromptStatus);
const terminalFrameTrace = new Function(
  "utf8Tail",
  "sha256Bytes",
  "sanitize",
  "checkDiagnosticReplacements",
  "parsePromptControlToken",
  "parseGitDisplayCsiGap",
  "CONTROLLED_PROMPT_STEM",
  "CONTROLLED_PROMPT_CONTRACT_WSL",
  "CONTROLLED_PROMPT_CONTRACT_GIT",
  "CONTROLLED_PROMPT_CONTRACT_GIT_LEGACY",
  `return (${extractBalancedFunction("terminalFrameTrace")});`,
)(
  (value) => String(value ?? ""),
  () => "a".repeat(64),
  (value) => String(value ?? ""),
  [],
  parsePromptControlToken,
  new Function(
    `return (${extractBalancedFunction("parseGitDisplayCsiGap")});`,
  )(),
  "__DSH_PERSISTENT_BASH_PROMPT__",
  "OSC133D-BEL+__DSH_PERSISTENT_BASH_PROMPT__ ",
  "OSC133D-BEL+canonical-status;__DSH_PERSISTENT_BASH_PROMPT__+visible-__DSH_PERSISTENT_BASH_PROMPT__",
  "OSC133D-BEL+[display-CSI]*+__DSH_PERSISTENT_BASH_PROMPT__",
);
const frameContractsFromTrace = new Function(
  `return (${extractBalancedFunction("frameContractsFromTrace")});`,
)();
const terminalReadTrace = new Function(
  "terminalFrameTrace",
  "TERMINAL_ROLLING_WINDOW_BYTES",
  `return (${extractBalancedFunction("terminalReadTrace")});`,
)(terminalFrameTrace, 65_536);
const observePublicTerminalCall = new Function(
  "publicTerminalObservation",
  "thrownErrorSummary",
  `return (${extractBalancedFunction("observePublicTerminalCall")});`,
)(
  () => {
    publicObservationState.count += 1;
    return {
      body: publicObservationState.settled ? "current-body" : "seed",
      settled: publicObservationState.settled,
    };
  },
  (error) => ({ name: error?.name ?? "Error", message: String(error) }),
);
const observerErrorsFromAttempts = new Function(
  `return (${extractBalancedFunction("observerErrorsFromAttempts")});`,
)();
const naturalNoisyPrepareSucceeded = new Function(
  `return (${extractBalancedFunction("naturalNoisyPrepareSucceeded")});`,
)();
const xtermProtocolProbeSummary = new Function(
  `return (${extractBalancedFunction("xtermProtocolProbeSummary")});`,
)();
const wrapXtermProbeInSubshell = new Function(
  `return (${extractBalancedFunction("wrapXtermProbeInSubshell")});`,
)();
assert.equal(wrapXtermProbeInSubshell("exit 0"), "( exit 0 )");
assert.equal(wrapXtermProbeInSubshell("exit 91").startsWith("("), true);
assert.equal(wrapXtermProbeInSubshell("exit 91").endsWith(")"), true);
const processCreationTimeMs = new Function(
  `return (${extractBalancedFunction("processCreationTimeMs")});`,
)();

assert.deepEqual(observerErrorsFromAttempts([
  { observer: { error: null } },
  { observer: { error: "query failed" } },
  { observer: { error: "query failed" } },
  { observer: { error: "restore failed" } },
]), ["query failed", "restore failed"]);
assert.deepEqual(observerErrorsFromAttempts([{ observer: { error: null } }]), []);

assert.equal(naturalNoisyPrepareSucceeded({
  parsedExitCode: 0,
  isError: false,
  error: null,
  timedOut: false,
  aborted: false,
  output: "natural-noisy-prepared",
}), true);
assert.equal(naturalNoisyPrepareSucceeded({
  parsedExitCode: null,
  isError: false,
  error: null,
  timedOut: null,
  aborted: false,
  output: "natural-noisy-prepared [Command timed out or OOM]",
}), false);
assert.equal(processCreationTimeMs({ CreationDate: "/Date(1791908878550)/" }), 1791908878550);
assert.equal(processCreationTimeMs({ CreationDate: "not-a-wmi-date" }), null);
assert.equal(naturalNoisyPrepareSucceeded({
  parsedExitCode: 0,
  isError: false,
  error: null,
  timedOut: false,
  aborted: false,
  output: "natural-noisy-live",
}), false);
const xtermProbePass = xtermProtocolProbeSummary({
  parsedExitCode: 0,
  isError: false,
  error: null,
  timedOut: false,
  aborted: false,
  shellExited: false,
  output: [
    "xterm-probe-request-hex=1b5b366e1b5b63",
    "xterm-probe-raw-hex=1b5b32343b3830521b5b3f313b3263",
    "xterm-probe-raw-escaped=$'\\E[24;80R\\E[?1;2c'",
    "xterm-probe-dsr-hex=1b5b32343b383052",
    "xterm-probe-dsr-escaped=$'\\E[24;80R'",
    "xterm-probe-da-hex=1b5b3f313b3263",
    "xterm-probe-da-escaped=$'\\E[?1;2c'",
    "xterm-probe-stty-restored=1",
    "xterm-probe-ok",
  ].join("\n"),
});
assert.equal(xtermProbePass.dsrReplyShape, true);
assert.equal(xtermProbePass.daReplyShape, true);
assert.equal(xtermProbePass.sttyRestored, true);
assert.equal(xtermProbePass.actualExit0, true);
assert.equal(xtermProbePass.ok, true);
const xtermProbeRenderedTimeoutLine = xtermProtocolProbeSummary({
  parsedExitCode: null,
  isError: false,
  error: null,
  timedOut: null,
  aborted: null,
  shellExited: false,
  output: "Your command timed out after 10 seconds or experienced an OOM error. Below is partial output: "
    + "xterm-probe-request-hex=1b5b366e1b5b63 "
    + "xterm-probe-raw-hex=1b5b3f313b30631b5b333b3152 "
    + "xterm-probe-raw-escaped=$'\\E[?1;0c\\E[3;1R' "
    + "xterm-probe-dsr-hex=1b5b333b3152 "
    + "xterm-probe-dsr-escaped=$'\\E[3;1R' "
    + "xterm-probe-da-hex=1b5b3f313b3063 "
    + "xterm-probe-da-escaped=$'\\E[?1;0c' "
    + "xterm-probe-stty-restored=1 xterm-probe-ok [Command timed out or OOM]",
});
assert.equal(xtermProbeRenderedTimeoutLine.dsrReplyShape, true);
assert.equal(xtermProbeRenderedTimeoutLine.daReplyShape, true);
assert.equal(xtermProbeRenderedTimeoutLine.sttyRestored, true);
assert.equal(xtermProbeRenderedTimeoutLine.actualExit0, false);
assert.equal(xtermProbeRenderedTimeoutLine.ok, false);
const xtermProbeShellExited = xtermProtocolProbeSummary({
  parsedExitCode: 0,
  isError: false,
  error: null,
  timedOut: false,
  aborted: false,
  shellExited: true,
  output: [
    "xterm-probe-dsr-hex=1b5b32343b383052",
    "xterm-probe-da-hex=1b5b3f313b3263",
    "xterm-probe-stty-restored=1",
    "xterm-probe-ok",
  ].join("\n"),
});
assert.equal(xtermProbeShellExited.actualExit0, false);
assert.equal(xtermProbeShellExited.ok, false);
const xtermProbeZeroPosition = xtermProtocolProbeSummary({
  parsedExitCode: 0,
  isError: false,
  error: null,
  timedOut: false,
  aborted: false,
  shellExited: false,
  output: [
    "xterm-probe-dsr-hex=1b5b303b383052",
    "xterm-probe-da-hex=1b5b3f313b3263",
    "xterm-probe-stty-restored=1",
    "xterm-probe-ok",
  ].join("\n"),
});
assert.equal(xtermProbeZeroPosition.dsrReplyShape, false);
assert.equal(xtermProbeZeroPosition.ok, false);
const xtermProbeEmptyDa = xtermProtocolProbeSummary({
  parsedExitCode: 0,
  isError: false,
  error: null,
  timedOut: false,
  aborted: false,
  shellExited: false,
  output: [
    "xterm-probe-dsr-hex=1b5b32343b383052",
    "xterm-probe-da-hex=1b5b3f63",
    "xterm-probe-stty-restored=1",
    "xterm-probe-ok",
  ].join("\n"),
});
assert.equal(xtermProbeEmptyDa.daReplyShape, false);
assert.equal(xtermProbeEmptyDa.ok, false);
const xtermProbeFail = xtermProtocolProbeSummary({
  parsedExitCode: 91,
  isError: false,
  error: null,
  timedOut: false,
  aborted: false,
  shellExited: false,
  output: [
    "xterm-probe-raw-hex=",
    "xterm-probe-dsr-hex=",
    "xterm-probe-da-hex=",
    "xterm-probe-stty-restored=1",
    "xterm-probe-fail setup=0 restore=0 dsr=0 da=0",
  ].join("\n"),
});
assert.equal(xtermProbeFail.ok, false);
assert.equal(xtermProbeFail.dsrReplyShape, false);
assert.equal(xtermProbeFail.daReplyShape, false);

const wslTerminalArgv = [
  "C:\\Windows\\System32\\wsl.exe",
  "-d",
  "Ubuntu",
  "--exec",
  "/usr/bin/bwrap",
  "/usr/bin/script",
  "DSH_PTY_SESSION_ID",
];
assert.equal(stdoutObservationScope({ argv: wslTerminalArgv }, "wsl"), "terminal-pty");
assert.equal(stdoutObservationScope({ argv: [...wslTerminalArgv.slice(0, 5), "/usr/bin/realpath"] }, "wsl"), "discovery");
assert.equal(stdoutObservationScope({ argv: wslTerminalArgv.filter((value) => value !== "DSH_PTY_SESSION_ID") }, "wsl"), "discovery");
assert.equal(stdoutObservationScope({ argv: ["C:\\Program Files\\DeepSeek Harness\\pty-helper.js"] }, "git-bash"), "terminal-pty");
assert.equal(stdoutObservationScope({ argv: ["C:\\Program Files\\DeepSeek Harness\\node.exe"] }, "git-bash"), "discovery");

const gitDisplayCsi = "\u001b[2J\u001b[m\u001b[H";
const gitAtomicPrompt = `\u001b]133;D;0\u0007${gitDisplayCsi}__DSH_PERSISTENT_BASH_PROMPT__\u001b[1C`;
const actualGit98BStartup = "\u001b]133;D;0\u0007\u001b[2J\u001b[m\u001b[H__DSH_PERSISTENT_BASH_PROMPT__\u001b[1C\u001b]0;C:\\Program Files\\Git\\bin\\bash.exe\u0007\u001b[?25h";
assert.equal(Buffer.byteLength(actualGit98BStartup), 98);
const actualGit98BTrace = terminalFrameTrace(
  actualGit98BStartup,
  65_536,
  "public-subprocess.stdout data",
  "git-bash",
);
assert.equal(actualGit98BTrace.hasControlledPrompt, true);
assert.equal(actualGit98BTrace.promptPairs[0].completeValidControl, false);
assert.equal(actualGit98BTrace.promptPairs[0].readinessPair, null);
assert.deepEqual(
  actualGit98BTrace.promptPairs[0].displayCsi.map((entry) => entry.token),
  ["\u001b[2J", "\u001b[m", "\u001b[H"],
);
const nativePromptWithBgSpaces = actualGit98BStartup.replace(
  "\u001b[1C",
  "   \u001b[1C",
);
const nativePromptWithBgSpacesTrace = terminalFrameTrace(
  nativePromptWithBgSpaces,
  65_536,
  "public-subprocess.stdout data",
  "git-bash",
);
assert.equal(nativePromptWithBgSpacesTrace.hasControlledPrompt, true);
assert.equal(nativePromptWithBgSpacesTrace.promptPairs[0].atomic, true);
assert.equal(nativePromptWithBgSpacesTrace.promptPairs[0].readinessPair, null);
assert.equal(nativePromptWithBgSpacesTrace.promptPairs[0].promptEndAt > nativePromptWithBgSpacesTrace.promptPairs[0].promptAt, true);

const nativeFullControl = "\u001b]133;D;0;__DSH_PERSISTENT_BASH_PROMPT__\u0007";
const nativeVisiblePrompt = "__DSH_PERSISTENT_BASH_PROMPT__";
const validGitFrameTrace = terminalFrameTrace(
  `__DSH_PERSISTENT_BASH_START_abc__ ${nativeFullControl}new-mode-owner-a\u001b[48X __DSH_PERSISTENT_BASH_END_abc:0 ${nativeVisiblePrompt}   `,
  65_536,
  "public-subprocess.stdout data",
  "git-bash",
);
assert.equal(validGitFrameTrace.promptContract, "OSC133D-BEL+canonical-status;__DSH_PERSISTENT_BASH_PROMPT__+visible-__DSH_PERSISTENT_BASH_PROMPT__");
assert.equal(validGitFrameTrace.hasControlledPrompt, true);
assert.equal(validGitFrameTrace.promptPairs.length, 1);
assert.equal(validGitFrameTrace.promptPairs[0].atomic, false);
assert.equal(validGitFrameTrace.promptPairs[0].completeValidControl, true);
assert.equal(validGitFrameTrace.promptPairs[0].controlStatus, 0);
assert.equal(validGitFrameTrace.promptPairs[0].byteAdjacent, false);
assert.equal(validGitFrameTrace.promptPairs[0].readinessPair.complete, true);
assert.equal(validGitFrameTrace.promptPairs[0].readinessPair.gapText.includes("new-mode-owner-a"), true);
assert.equal(validGitFrameTrace.promptPairs[0].displayCsiWellFormed, true);
assert.deepEqual(
  validGitFrameTrace.promptPairs[0].displayCsi.map((entry) => entry.token),
  ["\u001b[48X"],
);
assert.equal(validGitFrameTrace.promptPairs[0].displayCsi[0].at > validGitFrameTrace.promptPairs[0].oscEndAt, true);
assert.equal(validGitFrameTrace.promptIndices.length, 1);
const validGitFrame = frameContractsFromTrace(validGitFrameTrace)[0];
assert.equal(validGitFrame.promptAfterEnd, true);
assert.equal(validGitFrame.oscInFrame, true);
assert.equal(validGitFrame.exitCode, 0);
assert.equal(validGitFrame.promptAt > validGitFrame.endIndex, true);
assert.equal(validGitFrame.promptEndAt > validGitFrame.promptAt, true);
assert.equal(validGitFrame.promptOscAt < validGitFrame.promptAt, true);
assert.equal(validGitFrame.promptOscEndAt < validGitFrame.promptAt, true);
assert.equal(validGitFrame.promptDisplayCsi.length, 1);
assert.equal(validGitFrame.promptDisplayCsiComplete, false);
assert.equal(validGitFrame.promptDisplayCsiWellFormed, true);
assert.equal(validGitFrame.promptControlCompleteValid, true);
assert.equal(validGitFrame.promptControlStatus, 0);
assert.equal(validGitFrame.promptControlAt >= validGitFrame.startIndex, true);
assert.equal(validGitFrame.promptControlAt < validGitFrame.endIndex, true);
assert.equal(validGitFrame.promptControlByteAdjacent, false);
assert.equal(validGitFrame.promptContract, "OSC133D-BEL+canonical-status;__DSH_PERSISTENT_BASH_PROMPT__+visible-__DSH_PERSISTENT_BASH_PROMPT__");

const oldBare691Trace = terminalFrameTrace(
  `__DSH_PERSISTENT_BASH_START_abc__ \u001b]133;D;0\u0007new-mode-owner-a\u001b[48X __DSH_PERSISTENT_BASH_END_abc:0 ${nativeVisiblePrompt}`,
  65_536,
  "public-subprocess.stdout data",
  "git-bash",
);
assert.equal(oldBare691Trace.promptPairs[0].completeValidControl, false);
assert.equal(oldBare691Trace.promptPairs[0].readinessPair, null);
assert.equal(frameContractsFromTrace(oldBare691Trace)[0].promptAfterEnd, false);
const staleNativeControlTrace = terminalFrameTrace(
  `${nativeFullControl} __DSH_PERSISTENT_BASH_START_bad__ __DSH_PERSISTENT_BASH_END_bad:0 ${nativeVisiblePrompt}`,
  65_536,
  "public-subprocess.stdout data",
  "git-bash",
);
assert.equal(staleNativeControlTrace.promptPairs[0].readinessPair.complete, true);
assert.equal(frameContractsFromTrace(staleNativeControlTrace)[0].promptAfterEnd, false);

const wslAtomicPrompt = "\u001b]133;D;0\u0007__DSH_PERSISTENT_BASH_PROMPT__ ";
const validWslFrameTrace = terminalFrameTrace(
  `__DSH_PERSISTENT_BASH_START_def__ __DSH_PERSISTENT_BASH_END_def:0 ${wslAtomicPrompt}`,
  65_536,
  "public-subprocess.stdout data",
  "wsl",
);
assert.equal(validWslFrameTrace.promptContract, "OSC133D-BEL+__DSH_PERSISTENT_BASH_PROMPT__ ");
assert.equal(validWslFrameTrace.hasControlledPrompt, true);
assert.equal(validWslFrameTrace.promptPairs[0].atomic, true);
assert.equal(validWslFrameTrace.promptPairs[0].legacyControlValid, true);
assert.equal(validWslFrameTrace.promptPairs[0].readinessPair.complete, true);
assert.equal(validWslFrameTrace.promptPairs[0].byteAdjacent, true);
assert.deepEqual(validWslFrameTrace.promptPairs[0].displayCsi, []);
const validWslFrame = frameContractsFromTrace(validWslFrameTrace)[0];
assert.equal(validWslFrame.promptAfterEnd, true);
assert.equal(validWslFrame.promptControlLegacyValid, true);
assert.equal(validWslFrame.promptControlByteAdjacent, true);

const publicVisibleWslTrace = terminalFrameTrace(
  "__DSH_PERSISTENT_BASH_START_abc123__ NOISY_BG "
    + "__DSH_PERSISTENT_BASH_END_abc123:0 "
    + "__DSH_PERSISTENT_BASH_PROMPT__ ",
  65_536,
  "official-terminals.read",
  "wsl",
  "public-visible",
);
assert.equal(publicVisibleWslTrace.observationMode, "public-visible");
assert.equal(publicVisibleWslTrace.hasOsc133D, false);
assert.equal(publicVisibleWslTrace.hasVisiblePrompt, true);
assert.equal(publicVisibleWslTrace.hasControlledPrompt, false);
assert.equal(publicVisibleWslTrace.promptPairs[0].publicVisible, true);
assert.equal(publicVisibleWslTrace.promptPairs[0].readinessPair, null);
assert.equal(publicVisibleWslTrace.promptPairs[0].oscAt, null);
assert.equal(publicVisibleWslTrace.promptIndices.length, 1);
const publicVisibleWslFrame = frameContractsFromTrace(
  publicVisibleWslTrace,
  new Set(["seed"]),
)[0];
assert.equal(publicVisibleWslFrame.promptAfterEnd, true);
assert.equal(publicVisibleWslFrame.publicVisiblePrompt, true);
assert.equal(publicVisibleWslFrame.readinessPair, null);
assert.equal(publicVisibleWslFrame.promptControlAt, null);
assert.equal(publicVisibleWslFrame.oscInFrame, false);
assert.equal(publicVisibleWslFrame.isNew, true);
assert.equal(
  frameContractsFromTrace(publicVisibleWslTrace, new Set(["abc123"]))[0].isNew,
  false,
);
const publicPromptBeforeEndTrace = terminalFrameTrace(
  "__DSH_PERSISTENT_BASH_START_abc123__ "
    + "__DSH_PERSISTENT_BASH_PROMPT__ "
    + "__DSH_PERSISTENT_BASH_END_abc123:0",
  65_536,
  "official-terminals.read",
  "wsl",
  "public-visible",
);
assert.equal(
  frameContractsFromTrace(publicPromptBeforeEndTrace)[0].promptAfterEnd,
  false,
);
const publicRead = terminalReadTrace({
  text: "__DSH_PERSISTENT_BASH_START_a11ce__ "
    + "__DSH_PERSISTENT_BASH_END_a11ce:0 __DSH_PERSISTENT_BASH_PROMPT__ ",
}, "wsl", "public-visible");
assert.equal(publicRead.observationMode, "public-visible");
assert.equal(publicRead.hasVisiblePrompt, true);
assert.equal(publicRead.hasControlledPrompt, false);
assert.equal(frameContractsFromTrace(publicRead)[0].publicVisiblePrompt, true);

const publicObservationState = { count: 0, settled: false };
const settledReadObservation = await observePublicTerminalCall(
  new Promise((resolve) => setTimeout(() => {
    publicObservationState.settled = true;
    resolve("settled");
  }, 5)),
  {},
  {},
  { intervalMs: 1, maxMs: 100, backendType: "wsl" },
);
assert.equal(settledReadObservation.outcome.status, "fulfilled");
assert.equal(settledReadObservation.observations.at(-1).phase, "settled-final");
assert.equal(settledReadObservation.observations[0].observation.body, "seed");
assert.equal(
  settledReadObservation.observations.at(-1).observation.body,
  "current-body",
);
assert.equal(settledReadObservation.observations.at(-1).observation.settled, true);
assert.equal(publicObservationState.settled, true);
assert.ok(publicObservationState.count >= 2);

for (const [backendType, invalidPrompt] of [
  ["git-bash", "ordinary __DSH_PERSISTENT_BASH_PROMPT__"],
  ["git-bash", "__DSH_PERSISTENT_BASH_PROMPT__"],
  ["git-bash", "\u001b]133;D;0;__DSH_PERSISTENT_BASH_PROMPT__\u0007"],
  ["git-bash", "\u001b]133;D;0;__DSH_PERSISTENT_BASH_PROMPT__\u0007\u001b[6n__DSH_PERSISTENT_BASH_PROMPT__"],
  ["git-bash", "\u001b]133;D;0;__DSH_PERSISTENT_BASH_PROMPT__\u0007\u001b[2__DSH_PERSISTENT_BASH_PROMPT__"],
  ["git-bash", "\u001b]133;D;01;__DSH_PERSISTENT_BASH_PROMPT__\u0007__DSH_PERSISTENT_BASH_PROMPT__"],
  ["git-bash", "\u001b]133;D;256;__DSH_PERSISTENT_BASH_PROMPT__\u0007__DSH_PERSISTENT_BASH_PROMPT__"],
  ["git-bash", "\u001b]133;D;-1;__DSH_PERSISTENT_BASH_PROMPT__\u0007__DSH_PERSISTENT_BASH_PROMPT__"],
  ["git-bash", "\u001b]133;D;0;__DSH_PERSISTENT_BASH_PROMPT__;extra\u0007__DSH_PERSISTENT_BASH_PROMPT__"],
  ["git-bash", "\u001b]133;D;0;__DSH_PERSISTENT_BASH_PROMPT__\u001b\\__DSH_PERSISTENT_BASH_PROMPT__"],
  ["git-bash", "\u001b]133;A;0;__DSH_PERSISTENT_BASH_PROMPT__\u0007__DSH_PERSISTENT_BASH_PROMPT__"],
  ["git-bash", "\u001b]133;D;0;__DSH_PERSISTENT_BASH_PROMPT__"],
  ["git-bash", "__DSH_PERSISTENT_BASH_PROMPT__\u001b]133;D;0;__DSH_PERSISTENT_BASH_PROMPT__\u0007"],
  ["wsl", "\u001b]133;D;0\u0007\u001b[2J__DSH_PERSISTENT_BASH_PROMPT__ "],
  ["wsl", "\u001b]133;D;01\u0007__DSH_PERSISTENT_BASH_PROMPT__ "],      
  ["wsl", "\u001b]133;D;0\u0007x__DSH_PERSISTENT_BASH_PROMPT__ "],
  ["wsl", "\u001b]133;D;0\u0007ordinary-body__DSH_PERSISTENT_BASH_PROMPT__ "],
]) {
  const invalidTrace = terminalFrameTrace(
    `__DSH_PERSISTENT_BASH_START_bad__ __DSH_PERSISTENT_BASH_END_bad:0 ${invalidPrompt}`,
    65_536,
    "public-subprocess.stdout data",
    backendType,
  );
  assert.equal(invalidTrace.promptPairs.every((entry) => entry.readinessPair === null), true, `${backendType} invalid readiness accepted`);
  assert.equal(invalidTrace.promptIndices.length, 0);
  assert.equal(frameContractsFromTrace(invalidTrace)[0].promptAfterEnd, false);
  assert.equal(frameContractsFromTrace(invalidTrace)[0].oscInFrame, false);
}

const instrumentPublicStdout = new Function(
  "sanitize",
  "checkDiagnosticReplacements",
  "terminalFrameTrace",
  "utf8Tail",
  "TERMINAL_ROLLING_WINDOW_BYTES",
  `let nextPublicStdoutStreamId = 0;\n${extractFunction("instrumentPublicStdout")}\nreturn instrumentPublicStdout;`,
)(
  (value) => String(value ?? ""),
  [],
  (text, _windowBytes, sourceName, backendType) => ({
    source: sourceName,
    backendType,
    rawBytes: Buffer.byteLength(text),
    rollingWindowBytes: Buffer.byteLength(text),
    rollingWindowSha256: "a".repeat(64),
    tokens: [],
    frameStarts: text.includes("START") ? [{ nonce: "fresh" }] : [],
    frameEnds: text.includes("END") ? [{ nonce: "fresh", exitCode: 0 }] : [],
    framePairs: [],
    promptContract: "prompt",
    promptIndices: [],
    noisyIndices: [],
    hasOsc133D: true,
    hasControlledPrompt: true,
    hasStartFrame: text.includes("START"),
    hasEndFrame: text.includes("END"),
    compactHead: text,
    compactTail: text,
  }),
  (value) => value,
  65_536,
);

assert.match(source, /const observedStdoutStreams = new WeakMap\(\)/);
assert.match(source, /nativeStdoutObserverAttempts/);
assert.match(source, /stdoutObservationScope\(request, expectedBackendName\)/);
assert.match(source, /recordStdoutObserverAttempt/);
assert.match(source, /observerErrorsFromAttempts/);
assert.match(source, /rawStdoutObserverErrors\.length === 0/);
assert.match(source, /observerErrorsAfterRestore/);
assert.match(source, /naturalNoisyPrepareSucceeded/);
assert.match(source, /actual parsed exit-0 frame/);
assert.match(source, /naturalExit: null/);
assert.match(source, /post-reset PID snapshot was used/);
assert.match(source, /processCreationTimeMs/);
assert.match(source, /nativeHandleBatch/);
assert.match(source, /xtermProtocolProbeSummary/);
assert.match(source, /stty -icanon -echo min 0 time 1/);
assert.match(source, /xterm-probe-request-hex/);
assert.match(source, /xterm-probe-raw-hex/);
assert.match(source, /xterm-probe-stty-restored/);
assert.match(source, /DSR\/DA protocol prerequisite failed/);
assert.match(source, /wrapXtermProbeInSubshell/);
assert.match(source, /const xtermProbeCommand = wrapXtermProbeInSubshell\(\[/);
assert.match(source, /CONTROLLED_PROMPT_CONTRACT_WSL/);
assert.match(source, /CONTROLLED_PROMPT_CONTRACT_GIT/);
assert.match(source, /CONTROLLED_PROMPT_CONTRACT_GIT_LEGACY/);
assert.match(source, /parsePromptControlToken/);
assert.match(source, /canonicalPromptStatus/);
assert.match(source, /completeValidControl/);
assert.match(source, /readinessPair/);
assert.match(source, /parseGitDisplayCsiGap/);
assert.match(source, /displayCsi/);
assert.doesNotMatch(source, /ansi-stripped-literal-dsh>/);
assert.doesNotMatch(source, /promptRegex = backendType === "git-bash"/);
assert.match(source, /observerAttemptCount/);
assert.match(source, /discoverySnapshots:/);
assert.match(source, /observerAttempts:/);
assert.doesNotMatch(source, /seenStreams\.has\(stream\)/);

const registry = new WeakMap();
const stream = {
  emit() { return true; },
  pause() {},
  resume() {},
};

const pending = instrumentPublicStdout({}, registry, "wsl");
assert.equal(pending.available, false);
assert.equal(pending.installed, false);
assert.equal(pending.registration, "pending");
assert.equal(pending.reason, "public-handle-not-ready");
assert.equal(pending.streamId, null);

const first = instrumentPublicStdout({ stdout: stream }, registry, "wsl");
assert.equal(first.available, true);
assert.equal(first.installed, true);
assert.equal(first.isUniqueObserver, true);
assert.equal(first.reused, false);
assert.match(first.streamId, /^public-stdout-\d+$/);

stream.emit("data", Buffer.from("START prompt END"));
const firstSnapshot = first.snapshot();
assert.equal(firstSnapshot.totalBytes, Buffer.byteLength("START prompt END"));
assert.equal(firstSnapshot.streamTrace.hasStartFrame, true);
assert.equal(firstSnapshot.streamTrace.hasEndFrame, true);

const reused = instrumentPublicStdout({ stdout: stream }, registry, "wsl");
assert.equal(reused, first);
assert.equal(reused.available, true);
assert.equal(reused.installed, true);
assert.equal(reused.isUniqueObserver, true);
assert.equal(reused.reused, false);
assert.equal(reused.registration, "installed");
assert.equal(reused.lastAttempt.reused, true);
assert.equal(reused.lastAttempt.registration, "reused");
assert.equal(reused.streamId, first.streamId);
assert.equal(reused.snapshot().totalBytes, firstSnapshot.totalBytes);

const discoveryStream = {
  emit() { return true; },
  pause() {},
  resume() {},
};
const discovery = instrumentPublicStdout({ stdout: discoveryStream }, registry, "wsl", "discovery");
assert.equal(discovery.available, true);
assert.equal(discovery.installed, true);
assert.equal(discovery.snapshot().observationScope, "discovery");
assert.equal(discovery.lastAttempt.observationScope, "discovery");
discoveryStream.emit("data", Buffer.from("realpath-discovery"));
assert.equal(discovery.snapshot().totalBytes, Buffer.byteLength("realpath-discovery"));

const throwing = instrumentPublicStdout({
  get stdout() { throw new Error("stdout query failed"); },
}, registry, "wsl");
assert.equal(throwing.available, false);
assert.equal(throwing.installed, false);
assert.equal(throwing.registration, "query-error");
assert.match(throwing.error, /stdout query failed/);

console.log("new-modes Desktop raw observer offline regression: PASS");
