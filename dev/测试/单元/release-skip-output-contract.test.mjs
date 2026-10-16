#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "../../..");
const source = readFileSync(join(root, "scripts", "release-check.mjs"), "utf8");
const standaloneSkip = /^\s*SKIP(?:\s|$)/im;

assert.equal(standaloneSkip.test("PASS SKIP mandatory nested case"), false);
assert.equal(standaloneSkip.test("Native mode release-validator offline regressions: 31 passed"), false);
assert.equal(standaloneSkip.test("Output-cap gate offline regression: 9 passed, 0 failed"), false);
assert.equal(standaloneSkip.test("SKIP PTY helper failure contract: requires Windows Node"), true);
assert.equal(standaloneSkip.test("SKIP output-cap gate offline regression: requires Windows Node"), true);
assert.equal((source.match(/skipOutputPattern:\s*\/\^\\s\*SKIP/g) ?? []).length, 8);
assert.doesNotMatch(source, /skipOutputPattern:\s*\/\\bSKIP\\b\//);
assert.match(source, /outputCapGateRegressionPath/);
assert.match(source, /standalone output-cap gate offline regression/);

const packCliSkip = /^\s*(?:SKIP(?:\s|$)|PACK_CLI_CONTRACT\s+SKIP(?:\s|$))/im;
assert.equal(packCliSkip.test("PASS SKIP mandatory nested case"), false);
assert.equal(packCliSkip.test("PACK_CLI_CONTRACT SKIP requires Windows Node"), true);
assert.match(source, /PACK_CLI_CONTRACT\\s\+SKIP/);

console.log("Release-check standalone SKIP classification contract: PASS");
