#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readDesktopRuntimeIdentity } from "./gui-candidate-binding.mjs";

assert.deepEqual(readDesktopRuntimeIdentity({}), {
  asarSha256: undefined,
  executableSha256: undefined,
});
assert.throws(() => readDesktopRuntimeIdentity({}, { required: true }), /DSH_DESKTOP_ASAR_SHA256/);
assert.throws(() => readDesktopRuntimeIdentity({ DSH_DESKTOP_ASAR_SHA256: "invalid" }), /SHA-256/);
assert.throws(() => readDesktopRuntimeIdentity({ DSH_DESKTOP_ASAR_SHA256: "a".repeat(64) }, { required: true }), /DSH_DESKTOP_EXE_SHA256/);
assert.deepEqual(readDesktopRuntimeIdentity({
  DSH_DESKTOP_ASAR_SHA256: "A".repeat(64),
  DSH_DESKTOP_EXE_SHA256: "b".repeat(64),
}, { required: true }), {
  asarSha256: "a".repeat(64),
  executableSha256: "b".repeat(64),
});

const source = readFileSync(
  new URL("./desktop-context-probe.mjs", import.meta.url),
  "utf8",
);

function extractFunction(name) {
  const start = source.indexOf(`function ${name}`);
  assert.ok(start >= 0, `${name} must remain in the probe source`);
  const signatureEnd = source.indexOf(")", start);
  const open = source.indexOf("{", signatureEnd);
  assert.ok(open >= 0, `${name} must have a body`);
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

const probeIdentityFromHashes = new Function(
  `return (${extractFunction("probeIdentityFromHashes")});`,
)();
const indexSha = "a".repeat(64);
const observerSha = "b".repeat(64);

const valid = probeIdentityFromHashes({
  sourceProbeIndexSha256: indexSha,
  installedProbeIndexSha256: indexSha,
  sourceProbeObserverSha256: observerSha,
  installedProbeObserverSha256: observerSha,
});
assert.equal(valid.probeIndexHashesMatch, true);
assert.equal(valid.probeObserverRequired, true);
assert.equal(valid.probeObserverHashesMatch, true);

const missingObserver = probeIdentityFromHashes({
  sourceProbeIndexSha256: indexSha,
  installedProbeIndexSha256: indexSha,
  sourceProbeObserverSha256: null,
  installedProbeObserverSha256: null,
});
assert.equal(missingObserver.probeObserverRequired, true);
assert.equal(missingObserver.probeObserverHashesMatch, false);

const omittedObserver = probeIdentityFromHashes({
  sourceProbeIndexSha256: indexSha,
  installedProbeIndexSha256: indexSha,
});
assert.equal(omittedObserver.probeObserverRequired, true);
assert.equal(omittedObserver.probeObserverHashesMatch, false);

const mismatchedObserver = probeIdentityFromHashes({
  sourceProbeIndexSha256: indexSha,
  installedProbeIndexSha256: indexSha,
  sourceProbeObserverSha256: observerSha,
  installedProbeObserverSha256: indexSha,
});
assert.equal(mismatchedObserver.probeObserverRequired, true);
assert.equal(mismatchedObserver.probeObserverHashesMatch, false);

const mismatchedIndex = probeIdentityFromHashes({
  sourceProbeIndexSha256: indexSha,
  installedProbeIndexSha256: observerSha,
  sourceProbeObserverSha256: observerSha,
  installedProbeObserverSha256: observerSha,
});
assert.equal(mismatchedIndex.probeIndexHashesMatch, false);
assert.equal(mismatchedIndex.probeObserverHashesMatch, true);

assert.match(source, /probeObserverRequired/);
assert.match(source, /probeSourceObserverSha256/);
assert.match(source, /probeInstalledObserverSha256/);
assert.match(source, /if \(!probeIdentityOk\)/);

console.log("desktop context probe identity offline regression: PASS");
