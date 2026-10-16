#!/usr/bin/env node

/**
 * Offline regression checks for the release gate's strict WSL stderr-merge cap
 * evidence. This never starts CLI/Desktop or qualifies a runtime report.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

const ROOT = new URL("../../..", import.meta.url);
const RELEASE_CHECK_PATH = new URL("scripts/release-check.mjs", ROOT);
const source = readFileSync(RELEASE_CHECK_PATH, "utf8");
const ast = ts.createSourceFile(
  RELEASE_CHECK_PATH.pathname,
  source,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.JS,
);

let functionNode;
let desktopCapVariableNode;
let cliCapProbeChecksVariableNode;
let cliCapDedicatedChecksVariableNode;
let cliCapDedicatedCheckVariableNode;
let cliWslStderrMergedVariableNode;
let cliWslStderrMergedOkVariableNode;
const visit = (node) => {
  if (ts.isFunctionDeclaration(node)
    && node.name?.text === "wslMergedStderrCapEvidenceIsStrict") {
    functionNode = node;
  }
  if (ts.isVariableDeclaration(node)
    && ts.isIdentifier(node.name)
    && node.name.text === "desktopWslStderrMerged") {
    desktopCapVariableNode = node;
  }
  if (ts.isVariableDeclaration(node)
    && ts.isIdentifier(node.name)
    && node.name.text === "capProbeChecks") {
    cliCapProbeChecksVariableNode = node;
  }
  if (ts.isVariableDeclaration(node)
    && ts.isIdentifier(node.name)
    && node.name.text === "capDedicatedChecks") {
    cliCapDedicatedChecksVariableNode = node;
  }
  if (ts.isVariableDeclaration(node)
    && ts.isIdentifier(node.name)
    && node.name.text === "capDedicatedCheck") {
    cliCapDedicatedCheckVariableNode = node;
  }
  if (ts.isVariableDeclaration(node)
    && ts.isIdentifier(node.name)
    && node.name.text === "wslStderrMerged") {
    cliWslStderrMergedVariableNode = node;
  }
  if (ts.isVariableDeclaration(node)
    && ts.isIdentifier(node.name)
    && node.name.text === "wslStderrMergedOk") {
    cliWslStderrMergedOkVariableNode = node;
  }
  ts.forEachChild(node, visit);
};
visit(ast);
assert.ok(functionNode, "strict WSL stderr cap helper must remain in release-check.mjs");
assert.ok(desktopCapVariableNode?.initializer,
  "Desktop cap DTO extraction must remain in release-check.mjs");
for (const [name, node] of [
  ["capProbeChecks", cliCapProbeChecksVariableNode],
  ["capDedicatedChecks", cliCapDedicatedChecksVariableNode],
  ["capDedicatedCheck", cliCapDedicatedCheckVariableNode],
  ["wslStderrMerged", cliWslStderrMergedVariableNode],
  ["wslStderrMergedOk", cliWslStderrMergedOkVariableNode],
]) {
  assert.ok(node?.initializer,
    `CLI cap DTO initializer ${name} must remain in release-check.mjs`);
}
const helperSource = source.slice(functionNode.getStart(ast), functionNode.end);
const strictEvidence = new Function(
  "isRecord",
  `return (${helperSource});`,
)((value) => typeof value === "object" && value !== null && !Array.isArray(value));
const desktopCapInitializerSource = source.slice(
  desktopCapVariableNode.initializer.getStart(ast),
  desktopCapVariableNode.initializer.end,
);
const extractDesktopCapEvidence = new Function(
  "desktopCapDedicatedCheck",
  `return (${desktopCapInitializerSource});`,
);

const initializerSource = (node) => source.slice(
  node.initializer.getStart(ast),
  node.initializer.end,
);
const extractCliCapProbeChecks = new Function(
  "capCheck",
  `return (${initializerSource(cliCapProbeChecksVariableNode)});`,
);
const extractCliCapDedicatedChecks = new Function(
  "capProbeChecks",
  `return (${initializerSource(cliCapDedicatedChecksVariableNode)});`,
);
const extractCliCapDedicatedCheck = new Function(
  "capDedicatedChecks",
  `return (${initializerSource(cliCapDedicatedCheckVariableNode)});`,
);
const extractCliWslStderrMerged = new Function(
  "capDedicatedCheck",
  `return (${initializerSource(cliWslStderrMergedVariableNode)});`,
);
const extractCliWslStderrMergedOk = new Function(
  "capDedicatedCheck",
  "wslStderrMerged",
  "wslMergedStderrCapEvidenceIsStrict",
  `return (${initializerSource(cliWslStderrMergedOkVariableNode)});`,
);

const extractCliCapEvidence = (capCheck) => {
  const capProbeChecks = extractCliCapProbeChecks(capCheck);
  const capDedicatedChecks = extractCliCapDedicatedChecks(capProbeChecks);
  const capDedicatedCheck = extractCliCapDedicatedCheck(capDedicatedChecks);
  const wslStderrMerged = extractCliWslStderrMerged(capDedicatedCheck);
  const wslStderrMergedOk = extractCliWslStderrMergedOk(
    capDedicatedCheck,
    wslStderrMerged,
    strictEvidence,
  );
  return {
    capProbeChecks,
    capDedicatedChecks,
    capDedicatedCheck,
    wslStderrMerged,
    wslStderrMergedOk,
  };
};

const valid = {
  tool: "wsl_bash",
  mode: "workspace-write",
  stream: "stderr",
  sentStream: "stderr",
  capturedStream: "stdout",
  ptyMergingObserved: true,
  command: "printf '\\377\\377\\377\\377' >&2",
  requestedRawBytes: 4,
  sentRawBytes: 4,
  configuredVisibleCapBytes: 4,
  exitCode: 0,
  truncated: true,
  visibleBytes: 3,
  replacementCount: 1,
  output: "�",
  officialToolRuntime: true,
};

assert.equal(strictEvidence(valid), true);
console.log("PASS valid wsl_stderr_merged evidence");

const directDesktopCheck = {
  evidence: { wsl_stderr_merged: structuredClone(valid) },
};
assert.equal(strictEvidence(extractDesktopCapEvidence(directDesktopCheck)), true);
console.log("PASS Desktop shared-output-cap direct evidence DTO is extracted and strictly accepted");
assert.equal(strictEvidence(extractDesktopCapEvidence({
  evidence: { probe: { wsl_stderr_merged: structuredClone(valid) } },
})), false);
console.log("PASS Desktop shared-output-cap legacy nested probe DTO is rejected");
assert.equal(strictEvidence(extractDesktopCapEvidence({ evidence: {} })), false);
console.log("PASS Desktop shared-output-cap missing direct DTO is rejected");
const directMetadataMismatch = {
  evidence: { wsl_stderr_merged: structuredClone(valid) },
};
directMetadataMismatch.evidence.wsl_stderr_merged.visibleBytes = 4;
assert.equal(strictEvidence(extractDesktopCapEvidence(directMetadataMismatch)), false);
console.log("PASS Desktop shared-output-cap direct DTO metadata mismatch is rejected");

for (const [name, mutate] of [
  ["missing evidence", () => {}],
  ["fake source", (value) => { value.officialToolRuntime = false; }],
  ["non-merged stream", (value) => { value.capturedStream = "stderr"; value.ptyMergingObserved = false; }],
  ["over-cap visible bytes", (value) => { value.visibleBytes = 5; }],
  ["visible-byte metadata mismatch", (value) => { value.output = "ASCII"; }],
  ["not truncated", (value) => { value.truncated = false; }],
  ["replacement-count metadata mismatch", (value) => { value.replacementCount = 2; }],
  ["nonzero exit", (value) => { value.exitCode = 1; }],
]) {
  if (name === "missing evidence") {
    assert.equal(strictEvidence(undefined), false);
  } else {
    const candidate = structuredClone(valid);
    mutate(candidate);
    assert.equal(strictEvidence(candidate), false);
  }
  console.log(`PASS ${name} rejected`);
}

const CLI_DEDICATED_ID =
  "CLI-OUTPUT-CAP-01 registered wsl_bash and git_bash cap malformed UTF-8";
const makeCliDedicatedCheck = ({
  id = CLI_DEDICATED_ID,
  status = "PASS",
  evidence = valid,
} = {}) => ({
  id,
  status,
  evidence: { wsl_stderr_merged: structuredClone(evidence) },
});
const makeCliCapCheck = ({
  probeChecks = [makeCliDedicatedCheck()],
  probeExtras = {},
} = {}) => ({
  id: "CLI-OUTPUT-CAP-01",
  status: "PASS",
  evidence: {
    process: { exitCode: 0, closeObserved: true, reaped: true },
    probe: {
      schemaVersion: 1,
      suite: "output-cap",
      mode: "workspace-write",
      status: "PASS",
      checks: probeChecks,
      ...probeExtras,
    },
  },
});

const currentCliDto = extractCliCapEvidence(makeCliCapCheck());
assert.equal(currentCliDto.capDedicatedChecks.length, 1);
assert.equal(currentCliDto.capDedicatedCheck.id, CLI_DEDICATED_ID);
assert.equal(currentCliDto.capDedicatedCheck.status, "PASS");
assert.equal(currentCliDto.wslStderrMerged.tool, "wsl_bash");
assert.equal(currentCliDto.wslStderrMergedOk, true);
console.log("PASS current CLI probe/check/evidence.wsl_stderr_merged DTO is accepted");

const duplicateCliDto = extractCliCapEvidence(makeCliCapCheck({
  probeChecks: [makeCliDedicatedCheck(), makeCliDedicatedCheck()],
}));
assert.equal(duplicateCliDto.capDedicatedChecks.length, 2);
assert.equal(duplicateCliDto.capDedicatedCheck, undefined);
assert.equal(duplicateCliDto.wslStderrMerged, undefined);
assert.equal(duplicateCliDto.wslStderrMergedOk, false);
console.log("PASS duplicate dedicated CLI cap checks are rejected");

const missingCliDto = extractCliCapEvidence(makeCliCapCheck({
  probeExtras: { checks: undefined },
}));
assert.equal(missingCliDto.capDedicatedChecks.length, 0);
assert.equal(missingCliDto.capDedicatedCheck, undefined);
assert.equal(missingCliDto.wslStderrMergedOk, false);
console.log("PASS missing nested CLI probe checks are rejected");

const wrongIdCliDto = extractCliCapEvidence(makeCliCapCheck({
  probeChecks: [makeCliDedicatedCheck({ id: "CLI-OUTPUT-CAP-01" })],
}));
assert.equal(wrongIdCliDto.capDedicatedChecks.length, 0);
assert.equal(wrongIdCliDto.wslStderrMerged, undefined);
assert.equal(wrongIdCliDto.wslStderrMergedOk, false);
console.log("PASS wrong dedicated CLI cap check id is rejected");

const legacyDirectCliDto = extractCliCapEvidence(makeCliCapCheck({
  probeChecks: [],
  probeExtras: { wsl_stderr_merged: structuredClone(valid) },
}));
assert.equal(legacyDirectCliDto.capDedicatedChecks.length, 0);
assert.equal(legacyDirectCliDto.wslStderrMerged, undefined);
assert.equal(legacyDirectCliDto.wslStderrMergedOk, false);
console.log("PASS legacy direct probe wsl_stderr_merged placement is rejected");

for (const [name, mutate] of [
  ["inner SKIP status", (check) => { check.status = "SKIP"; }],
  ["inner FAIL status", (check) => { check.status = "FAIL"; }],
]) {
  const check = makeCliDedicatedCheck();
  mutate(check);
  const extracted = extractCliCapEvidence(makeCliCapCheck({
    probeChecks: [check],
  }));
  assert.equal(extracted.capDedicatedChecks.length, 1);
  assert.equal(extracted.wslStderrMergedOk, false);
  console.log(`PASS ${name} is not accepted as CLI cap PASS`);
}

for (const [name, mutate] of [
  ["empty output", (value) => { value.output = ""; }],
  ["raw-byte metadata mismatch", (value) => { value.sentRawBytes = 3; }],
  ["configured cap mismatch", (value) => { value.configuredVisibleCapBytes = 8; }],
  ["output byte mismatch", (value) => { value.output = "AB"; value.visibleBytes = 3; }],
  ["replacement-byte mismatch", (value) => { value.output = "A�"; value.visibleBytes = 3; }],
]) {
  const malformed = structuredClone(valid);
  mutate(malformed);
  const extracted = extractCliCapEvidence(makeCliCapCheck({
    probeChecks: [makeCliDedicatedCheck({ evidence: malformed })],
  }));
  assert.equal(strictEvidence(extracted.wslStderrMerged), false);
  assert.equal(extracted.wslStderrMergedOk, false);
  console.log(`PASS malformed nested CLI cap ${name} is rejected`);
}

console.log("Output-cap gate offline regression: 13 original cases retained; CLI nested DTO/cardinality/status/byte cases passed");
