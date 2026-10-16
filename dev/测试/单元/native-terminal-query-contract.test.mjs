import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  inspectPersistentReapEvidence,
  nativeTerminalQueryCommand,
  nativeTerminalQueryResultSummary,
  parseNativeTerminalQueryOutput,
} from "../CLI/probe-package/index.mjs";

const probePath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../CLI/probe-package/index.mjs",
);
const source = readFileSync(probePath, "utf8");
const commandStart = source.indexOf("export function nativeTerminalQueryCommand() {");
const commandEnd = source.indexOf(
  "export function nativeTerminalQueryResultSummary",
  commandStart,
);
const summaryStart = commandEnd;
const summaryEnd = source.indexOf(
  "function nativeTerminalHex",
  summaryStart,
);

assert.ok(commandStart >= 0 && commandEnd > commandStart);
assert.ok(summaryStart >= 0 && summaryEnd > summaryStart);
assert.ok(source.includes("export function parseNativeTerminalQueryOutput"));
assert.ok(!source.includes("nativeTerminalQueryCommandLegacy"));

const commandSource = source.slice(commandStart, commandEnd);
const summarySource = source.slice(summaryStart, summaryEnd);
const builtCommand = nativeTerminalQueryCommand();

assert.ok(commandSource.includes("stty -icanon -echo min 0 time 0"));
assert.ok(commandSource.includes("printf") && commandSource.includes("6n")
  && commandSource.includes("033[c"));
assert.ok(commandSource.includes("read -r -N 1 -t 0.1 ch"));
assert.ok(commandSource.includes("raw+="));
assert.ok(!commandSource.includes("read -r -t 2 -d R"));
assert.ok(!commandSource.includes("read -r -t 2 -d c"));
assert.ok(commandSource.includes("trap restore_native_query_stty EXIT HUP INT TERM"));
assert.ok(commandSource.includes("trap - EXIT HUP INT TERM"));
assert.ok(commandSource.includes("DSH_NATIVE_DSR_DA"));
assert.ok(builtCommand.includes("read -r -N 1 -t 0.1 ch"));
assert.ok(builtCommand.includes('raw+="$ch"'));
assert.ok(builtCommand.includes("printf '\\033[6n\\033[c' > /dev/tty"));

const waitIndex = source.indexOf("nativeTree = await waitForNativeTree(");
const queryIndex = source.indexOf(
  "terminalQuery = noisy ? await runNativeTerminalQuery",
);
const prepareIndex = source.indexOf("const prepared = await executeOfficialRaw");
assert.ok(waitIndex >= 0 && waitIndex < queryIndex && queryIndex < prepareIndex);
assert.ok(source.includes("nativeTerminalQueryResultSummary(query)"));
assert.ok(source.includes("processAtIdentity(ownerCreationBeforePrepare.top)"));
assert.ok(source.includes(
  "ownerAfterPrepare = processAtIdentity(terminalQuery.ownerCreationBeforePrepare.shell)",
));
assert.match(summarySource, /typeof result\.value === "string"/);
assert.match(summarySource, /\(\?:\^\|\\r\?\\n\)/);
assert.ok(summarySource.includes("exit code\\s+(-?\\d+)"));
assert.ok(source.includes("export function inspectPersistentReapEvidence"));

const queryFields = Object.freeze({
  stty_restored: "1",
  dsr_status: "0",
  da_status: "0",
  raw_hex: "1b5b31323b3334521b5b3f313b3263",
  dsr_hex: "1b5b31323b333452",
  da_hex: "1b5b3f313b3263",
});

function queryEvidence(overrides = {}) {
  const fields = { ...queryFields, ...overrides };
  return "DSH_NATIVE_DSR_DA "
    + Object.entries(fields)
      .map(([key, value]) => `${key}=${value}`)
      .join(" ");
}

const parsed = parseNativeTerminalQueryOutput(queryEvidence());
assert.equal(parsed.sttyRestored, true);
assert.equal(parsed.dsrStatus, 0);
assert.equal(parsed.daStatus, 0);
assert.deepEqual(parsed.dsr, { row: 12, column: 34 });
assert.deepEqual(parsed.da, { parameters: [1, 2] });
assert.equal(parsed.dsrHex, queryFields.dsr_hex);
assert.equal(parsed.daHex, queryFields.da_hex);

const failedStatus = parseNativeTerminalQueryOutput(queryEvidence({
  stty_restored: "0",
  dsr_status: "1",
  da_status: "1",
}));
assert.equal(failedStatus.sttyRestored, false);
assert.equal(failedStatus.dsrStatus, 1);
assert.equal(failedStatus.daStatus, 1);

assert.throws(
  () => parseNativeTerminalQueryOutput(queryEvidence({
    dsr_hex: "1b5b31323b3334",
  })),
  /DSR reply/,
);
assert.throws(
  () => parseNativeTerminalQueryOutput(queryEvidence({
    da_hex: "1b5b3f313b32",
  })),
  /DA reply/,
);
assert.throws(
  () => parseNativeTerminalQueryOutput(queryEvidence({
    da_hex: "1b5b3f63",
  })),
  /DA reply/,
);
assert.throws(
  () => parseNativeTerminalQueryOutput(queryEvidence({
    da_hex: "1b5b3f313b3b3263",
  })),
  /DA reply/,
);
assert.throws(
  () => parseNativeTerminalQueryOutput(
    `${queryEvidence()} dsr_hex=${queryFields.dsr_hex}`,
  ),
  /repeated field dsr_hex/,
);
assert.throws(
  () => parseNativeTerminalQueryOutput(queryEvidence({ dsr_hex: "" })),
  /DSR reply/,
);

const completionText = `${queryEvidence()}\n[Command finished with exit code 0]`;
const completion = nativeTerminalQueryResultSummary({
  result: { value: completionText },
  text: completionText,
});
assert.equal(completion.parsedExitCode, 0);
assert.equal(completion.actualExit0, true);
assert.equal(completion.shellExited, false);
assert.equal(completion.valueIsString, true);
assert.equal(completion.renderMatchesValue, true);

for (const exitStatus of ["00", "-0"]) {
  const nonCanonicalCompletionText = completionText.replace(
    "exit code 0",
    `exit code ${exitStatus}`,
  );
  const nonCanonicalCompletion = nativeTerminalQueryResultSummary({
    result: { value: nonCanonicalCompletionText },
    text: nonCanonicalCompletionText,
  });
  assert.equal(nonCanonicalCompletion.actualExit0, false);
}

const shellExit = nativeTerminalQueryResultSummary({
  result: { value: "[shell exited: code 0]" },
  text: "[shell exited: code 0]",
});
assert.equal(shellExit.shellExited, true);
assert.equal(shellExit.actualExit0, false);

const sameLineMarker = nativeTerminalQueryResultSummary({
  result: { value: "body [Command finished with exit code 0]" },
  text: "body [Command finished with exit code 0]",
});
assert.equal(sameLineMarker.completionLine, null);
assert.equal(sameLineMarker.actualExit0, false);

const bodyFakeThenExit1 = "body [Command finished with exit code 0]\n"
  + "[Command finished with exit code 1]";
const bodyFakeThenExit1Summary = nativeTerminalQueryResultSummary({
  result: { value: bodyFakeThenExit1 },
  text: bodyFakeThenExit1,
});
assert.equal(bodyFakeThenExit1Summary.parsedExitCode, 1);
assert.equal(bodyFakeThenExit1Summary.actualExit0, false);

const dtoForge = nativeTerminalQueryResultSummary({
  result: { value: { exitCode: 0 } },
  text: completionText,
});
assert.equal(dtoForge.valueIsString, false);
assert.equal(dtoForge.actualExit0, false);

const renderDrift = nativeTerminalQueryResultSummary({
  result: { value: completionText },
  text: `${completionText}\nrender drift`,
});
assert.equal(renderDrift.renderMatchesValue, false);
assert.equal(renderDrift.actualExit0, false);

const timeout = nativeTerminalQueryResultSummary({
  result: {
    value: "Your command timed out after 10 seconds or experienced an OOM error. "
      + "[Command timed out or OOM]",
  },
  text: "Your command timed out after 10 seconds or experienced an OOM error. "
    + "[Command timed out or OOM]",
});
assert.equal(timeout.timedOut, true);
assert.equal(timeout.actualExit0, false);

const aborted = nativeTerminalQueryResultSummary({
  result: { value: "tool call aborted", aborted: true },
  text: "tool call aborted",
});
assert.equal(aborted.aborted, true);
assert.equal(aborted.actualExit0, false);

const errorDto = nativeTerminalQueryResultSummary({
  result: { isError: true, error: { code: "FAILED" }, value: completionText },
  text: completionText,
});
assert.equal(errorDto.isError, true);
assert.equal(errorDto.actualExit0, false);

const reapNonce = "11111111-2222-4333-8444-555555555555";
function reapFixture(overrides = {}) {
  const marker = overrides.marker ?? "noisy-reaped";
  const nonce = overrides.nonce ?? reapNonce;
  const sampleNonce = overrides.sampleNonce ?? nonce;
  const sampleEndStatus = overrides.sampleEndStatus ?? "0";
  const sampleEnd = overrides.sampleEnd ?? sampleEndStatus;
  const sample = overrides.sample
    ?? `${marker} __DSH_PERSISTENT_BASH_END_${sampleNonce}:${sampleEnd}`;
  const commandText = [
    `printf '%s\\n' $'__DSH_PERSISTENT_BASH_START_${nonce}__'`,
    `eval -- $'printf \\'${marker}\\\\n\\''`,
    "__dsh_persistent_bash_status=$?",
    `printf '%s%s\\n' $'__DSH_PERSISTENT_BASH_END_${nonce}:' "$__dsh_persistent_bash_status"`,
  ].join("; ");
  const rendered = overrides.rendered
    ?? (overrides.clipped
      ? `N N N <response clipped>\n[Command finished with exit code 0]`
      : `${marker}\n[Command finished with exit code 0]`);
  const sampleRecord = {
    bytes: Buffer.byteLength(sample),
    head: sample,
    tail: sample,
  };
  const call = {
    index: overrides.operationIndex ?? 4,
    sessionId: overrides.operationSessionId ?? "pty-1",
    text: overrides.commandText ?? commandText,
    submit: true,
    ...(overrides.omitOwnerMatches === true
      ? {}
      : { ownerMatches: overrides.ownerMatches ?? true }),
    doneError: overrides.doneError ?? null,
    done: {
      elapsedMs: 100,
      waitReason: overrides.doneWaitReason ?? "stdin_read",
      sessionStatus: overrides.omitDoneSessionStatus === true
        ? undefined
        : overrides.doneSessionStatus ?? "running",
      truncated: overrides.doneTruncated === true,
      viewport: overrides.doneSample === false ? {} : sampleRecord,
    },
    readOutputs: overrides.readSample === false
      ? []
      : [{
        truncated: overrides.readTruncated === true,
        delta: sampleRecord,
      }],
  };
  const value = overrides.resultValue ?? rendered;
  return {
    outcome: {
      result: {
        value,
        isError: overrides.isError === true,
        ...(overrides.resultFlags ?? {}),
      },
      text: rendered,
    },
    expectedMarker: marker,
    expectedSessionId: overrides.expectedSessionId ?? "pty-1",
    operationCalls: overrides.operationCalls ?? [call],
    publicReads: overrides.publicReads ?? [{
      sessionId: overrides.publicSessionId ?? "pty-1",
      read: {
        truncated: overrides.publicReadTruncated === true,
        text: sampleRecord,
      },
    }],
  };
}

const reapPositive = reapFixture();
const reapPositiveEvidence = inspectPersistentReapEvidence(reapPositive);
assert.equal(reapPositiveEvidence.ok, true);
assert.equal(reapPositiveEvidence.operationIndex, 4);
assert.ok(reapPositiveEvidence.evidenceSources.length > 0);

const reapClipped = reapFixture({ clipped: true });
assert.equal(inspectPersistentReapEvidence(reapClipped).ok, true);

const reapDto = reapFixture({ resultValue: { exitCode: 0 } });
assert.equal(inspectPersistentReapEvidence(reapDto).ok, false);

const reapRenderDrift = reapFixture({
  resultValue: "different rendered value",
});
assert.equal(inspectPersistentReapEvidence(reapRenderDrift).ok, false);

const reapRenderedMarkerMissing = reapFixture({
  rendered: "[Command finished with exit code 0]",
});
assert.equal(inspectPersistentReapEvidence(reapRenderedMarkerMissing).ok, false);

const reapEscBoundary = reapFixture({
  sample: `noisy-reaped __DSH_PERSISTENT_BASH_END_${reapNonce}:0\u001b[37C`,
});
assert.equal(inspectPersistentReapEvidence(reapEscBoundary).ok, true);

const reapWrongNonce = reapFixture({
  sampleNonce: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
});
assert.equal(inspectPersistentReapEvidence(reapWrongNonce).ok, false);

const reapWrongSession = reapFixture({ operationSessionId: "pty-2" });
assert.equal(inspectPersistentReapEvidence(reapWrongSession).ok, false);

const reapWrongOwner = reapFixture({ ownerMatches: false });
assert.equal(inspectPersistentReapEvidence(reapWrongOwner).ok, false);

const reapMissingOwner = reapFixture({ omitOwnerMatches: true });
assert.equal(inspectPersistentReapEvidence(reapMissingOwner).ok, false);

const reapMissingEnd = reapFixture({
  sampleNonce: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  sampleEndStatus: "1",
});
assert.equal(inspectPersistentReapEvidence(reapMissingEnd).ok, false);

const reapPartialEnd = reapFixture({
  sample: `noisy-reaped __DSH_PERSISTENT_BASH_END_${reapNonce}:`,
});
assert.equal(inspectPersistentReapEvidence(reapPartialEnd).ok, false);

for (const sampleEnd of ["00", "01", "0junk"]) {
  const reapNonCanonicalEnd = reapFixture({ sampleEnd });
  assert.equal(inspectPersistentReapEvidence(reapNonCanonicalEnd).ok, false);
}

const reapTimeout = reapFixture({ doneWaitReason: "timeout" });
assert.equal(inspectPersistentReapEvidence(reapTimeout).ok, false);

for (const doneSessionStatus of ["exited", "unknown", "timeout"]) {
  const reapBadSessionStatus = reapFixture({ doneSessionStatus });
  assert.equal(inspectPersistentReapEvidence(reapBadSessionStatus).ok, false);
}
const reapMissingSessionStatus = reapFixture({ omitDoneSessionStatus: true });
assert.equal(inspectPersistentReapEvidence(reapMissingSessionStatus).ok, false);

const reapInheritedScrollbackTruncated = reapFixture({
  doneTruncated: true,
  publicReadTruncated: true,
});
assert.equal(inspectPersistentReapEvidence(reapInheritedScrollbackTruncated).ok, true);

const reapReadTruncated = reapFixture({ readTruncated: true });
assert.equal(inspectPersistentReapEvidence(reapReadTruncated).ok, false);

for (const exitStatus of ["00", "-0"]) {
  const reapNonCanonicalExit = reapFixture({
    rendered: `noisy-reaped\n[Command finished with exit code ${exitStatus}]`,
  });
  assert.equal(inspectPersistentReapEvidence(reapNonCanonicalExit).ok, false);
}

const reapWithEmptyPoll = reapFixture();
reapWithEmptyPoll.operationCalls = [
  ...reapWithEmptyPoll.operationCalls,
  {
    ...reapWithEmptyPoll.operationCalls[0],
    index: 5,
    text: "",
    submit: false,
  },
];
assert.equal(inspectPersistentReapEvidence(reapWithEmptyPoll).ok, true);

const reapWithExtraCommand = reapFixture();
reapWithExtraCommand.operationCalls = [
  ...reapWithExtraCommand.operationCalls,
  {
    ...reapWithExtraCommand.operationCalls[0],
    index: 5,
    text: "printf extra",
    submit: false,
  },
];
assert.equal(inspectPersistentReapEvidence(reapWithExtraCommand).ok, false);

const reapWithDuplicateWrapper = reapFixture();
reapWithDuplicateWrapper.operationCalls = [
  ...reapWithDuplicateWrapper.operationCalls,
  {
    ...reapWithDuplicateWrapper.operationCalls[0],
    index: 5,
  },
];
assert.equal(inspectPersistentReapEvidence(reapWithDuplicateWrapper).ok, false);

const reapExit1 = reapFixture({
  rendered: `${reapFixture().outcome.text.replace(
    "exit code 0",
    "exit code 1",
  )}`,
});
assert.equal(inspectPersistentReapEvidence(reapExit1).ok, false);

const reapShellExit = reapFixture({
  rendered: `${reapFixture().outcome.text}\n[shell exited: code 0]`,
});
assert.equal(inspectPersistentReapEvidence(reapShellExit).ok, false);

const reapBodyOnly = reapFixture({
  clipped: true,
  operationCalls: [],
  publicReads: [],
});
assert.equal(inspectPersistentReapEvidence(reapBodyOnly).ok, false);

console.log("native-terminal-query contract offline assertions: PASS");
