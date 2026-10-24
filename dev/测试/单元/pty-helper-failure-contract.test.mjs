#!/usr/bin/env node

/**
 * Executes the frozen Windows helper artifact with small host-contract stubs.
 * This is not an OS Job/ConPTY implementation: it injects failures at the
 * public Win32/host seams and records the exact seam calls before fail-closed
 * exit. The positive control proves that the same fixture reaches pty.spawn.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const RUN_ROOT = join(ROOT, "测试", "运行产物");
const HELPER = join(ROOT, "dist", "git", "pty-helper.js");
const SOURCE = join(ROOT, "src", "git", "pty-helper.ts");
const DIST = HELPER;
const NODE = process.execPath;

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

const CONTROL_MODULE = `
const { Duplex } = require("node:stream");
const start = {
  kind: "start",
  argv: ["C:\\\\Program Files\\\\Git\\\\bin\\\\bash.exe", "--noprofile", "--norc", "-i"],
  cwd: "C:\\\\helper-fixture",
  env: { DSH_HELPER_TEST: "1" },
  rows: 30,
  cols: 120,
  terminalType: "dumb",
};
exports.openInheritedControlChannel = function openInheritedControlChannel() {
  const channel = new Duplex({
    read() {},
    write(_chunk, _encoding, callback) { callback(); },
  });
  setImmediate(() => {
    const fault = process.env.PTY_HELPER_CONTROL_FAULT;
    if (fault === "malformed") channel.push("{not-json}\\n");
    else if (fault === "unknown") channel.push('{"kind":"unknown"}\\n');
    else if (fault === "bad-start") channel.push(JSON.stringify({ ...start, rows: 0 }) + "\\n");
    else channel.push(JSON.stringify(start) + "\\n");
  });
  return channel;
};
`;

const SUBPROCESS_MODULE = `
exports.scrubbedParentEnv = function scrubbedParentEnv() { return {}; };
`;

// These are the actual public-module seams used by pty-helper.ts. The helper
// calls isNullPtr/closeHandleChecked/allocUint32/decodeUint32 on the imported
// module, not on the object returned by extendWin32ProcessBindings.
const WIN32_MODULE = `
const { appendFileSync } = require("node:fs");
function trace(event, detail = {}) {
  const path = process.env.PTY_HELPER_TRACE;
  if (path) appendFileSync(path, JSON.stringify({ event, ...detail }) + "\\n", "utf8");
}
function ptr(kind, pid) { return { kind, pid }; }
function openProcess(_rights, _inherit, pid) {
  const fault = process.env.PTY_HELPER_FAULT;
  const scope = pid === process.pid ? "self" : "root";
  trace("openProcess", { fault, scope });
  if (fault === "open-self" && scope === "self") return null;
  if (fault === "open-root" && scope === "root") return null;
  return ptr("process", pid);
}
exports.isNullPtr = function isNullPtr(value) {
  const nullValue = value === null || value === undefined;
  trace("isNullPtr", { kind: value?.kind ?? null, nullValue });
  return nullValue;
};
exports.closeHandleChecked = function closeHandleChecked(_api, handle, detail) {
  trace("closeHandleChecked", { kind: handle?.kind ?? null, detail });
};
exports.allocUint32 = function allocUint32() {
  trace("allocUint32");
  return { kind: "uint32", value: 0 };
};
exports.decodeUint32 = function decodeUint32(slot) {
  trace("decodeUint32");
  return slot?.value ?? 0;
};
exports.extendWin32ProcessBindings = function extendWin32ProcessBindings(factory) {
  trace("extendWin32ProcessBindings");
  const kernel32 = {};
  const bind = function bind() { return openProcess; };
  const bound = factory({ kernel32, bind });
  const fault = process.env.PTY_HELPER_FAULT;
  return {
    ...bound,
    createJobObjectW: () => {
      trace("createJobObjectW", { fault });
      return fault === "create" ? null : ptr("job");
    },
    setInformationJobObject: () => {
      trace("setInformationJobObject", { fault });
      return fault === "set" ? 0 : 1;
    },
    assignProcessToJobObject: () => {
      trace("assignProcessToJobObject", { fault });
      return fault === "assign" ? 0 : 1;
    },
    waitForSingleObject: () => {
      trace("waitForSingleObject", { fault });
      return 258;
    },
    getExitCodeProcess: () => {
      trace("getExitCodeProcess", { fault });
      return 1;
    },
  };
};
`;

const NODE_PTY_MODULE = `
const { appendFileSync, writeFileSync } = require("node:fs");
function trace(event, detail = {}) {
  const path = process.env.PTY_HELPER_TRACE;
  if (path) appendFileSync(path, JSON.stringify({ event, ...detail }) + "\\n", "utf8");
}
exports.spawn = function spawn() {
  const marker = process.env.PTY_SPAWN_MARKER;
  if (marker) writeFileSync(marker, "spawn-attempted\\n", "utf8");
  const fault = process.env.PTY_HELPER_FAULT;
  trace("pty.spawn", { fault });
  if (fault === "pty-throw") throw new Error("synthetic node-pty spawn failure");
  return {
    pid: 4242,
    onData() {},
    onExit() {},
    pause() {},
    resume() {},
    resize() {},
    write() {},
  };
};
`;

function writeModule(root, packageName, source, fileName = "index.cjs") {
  const packageRoot = join(root, "host", "node_modules", ...packageName.split("/"));
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(join(packageRoot, "package.json"), JSON.stringify({
    name: packageName,
    version: "0.2.1-rc.3",
    main: fileName,
  }), "utf8");
  writeFileSync(join(packageRoot, fileName), source, "utf8");
}

function makeFixture({ fault, controlFault, missingControl = false, missingNodePty = false }) {
  const root = mkdtempSync(join(RUN_ROOT, "pty-helper-failure-"));
  const hostRoot = join(root, "host");
  mkdirSync(hostRoot, { recursive: true });
  const anchor = join(hostRoot, "package.json");
  writeFileSync(anchor, JSON.stringify({
    name: "@deepseek-ai/dsh",
    version: "0.2.1-rc.3",
  }), "utf8");
  writeModule(root, "@deepseek-ai/dsh-subprocess", SUBPROCESS_MODULE);
  const controlRoot = join(hostRoot, "node_modules", "@deepseek-ai", "dsh-subprocess");
  if (!missingControl) {
    writeFileSync(join(controlRoot, "control.cjs"), CONTROL_MODULE, "utf8");
  }
  const controlPackagePath = join(controlRoot, "package.json");
  const controlPackageJson = JSON.parse(readFileSync(controlPackagePath, "utf8"));
  controlPackageJson.exports = {
    ".": "./index.cjs",
    "./control": missingControl ? "./missing-control.cjs" : "./control.cjs",
  };
  writeFileSync(controlPackagePath, JSON.stringify(controlPackageJson), "utf8");
  writeModule(root, "@deepseek-ai/dsh-win32-process", WIN32_MODULE);
  if (!missingNodePty) {
    writeModule(root, "node-pty", NODE_PTY_MODULE);
  } else {
    const missingNodePtyRoot = join(root, "host", "node_modules", "node-pty");
    mkdirSync(missingNodePtyRoot, { recursive: true });
    writeFileSync(join(missingNodePtyRoot, "package.json"), JSON.stringify({
      name: "node-pty",
      version: "0.0.0-missing-fixture",
      main: "missing-entry.cjs",
    }), "utf8");
  }
  return {
    root,
    anchor,
    marker: join(root, "pty-spawn.marker"),
    trace: join(root, "win32-seam.trace"),
    fault,
    controlFault,
  };
}

function runHelper(fixture) {
  return new Promise((resolveRun) => {
    let child;
    try {
      child = spawn(NODE, [HELPER, fixture.anchor], {
        cwd: fixture.root,
        env: {
          ...process.env,
          PTY_HELPER_FAULT: fixture.fault ?? "",
          PTY_HELPER_CONTROL_FAULT: fixture.controlFault ?? "",
          PTY_SPAWN_MARKER: fixture.marker,
          PTY_HELPER_TRACE: fixture.trace,
        },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      resolveRun({ code: null, signal: null, stdout: "", stderr: "", reaped: true, spawnError: error });
      return;
    }
    let stdout = "";
    let stderr = "";
    let spawnError;
    let timedOut = false;
    let killResult;
    let killError;
    let settled = false;
    let reapTimer;
    const timeout = setTimeout(() => {
      timedOut = true;
      try {
        killResult = child.kill();
      } catch (error) {
        killError = error;
      }
      // Do not reject/remove the fixture immediately after kill. The close
      // event is the child process reaping point; retain evidence if it never
      // arrives within the bounded post-kill grace window.
      reapTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolveRun({
          code: null,
          signal: null,
          stdout,
          stderr,
          reaped: false,
          timedOut,
          killResult,
          killError,
          spawnError,
        });
      }, 1_500);
    }, 4_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => { spawnError = error; });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (reapTimer !== undefined) clearTimeout(reapTimer);
      resolveRun({ code, signal, stdout, stderr, reaped: true, timedOut, killResult, killError, spawnError });
    });
  });
}

function readTrace(path) {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8").trim();
  return text === "" ? [] : text.split(/\r?\n/u).map((line) => JSON.parse(line));
}

function assertTraceContract(testCase, fixture) {
  const records = readTrace(fixture.trace);
  const events = records.map(({ event }) => event);
  assert.deepEqual(events, testCase.events, `${testCase.name}: unexpected Win32 seam trace ${JSON.stringify(records)}`);
  if (testCase.target !== undefined) {
    assert.ok(records.some((record) => record.event === testCase.target.event &&
      Object.entries(testCase.target.detail).every(([key, value]) => record[key] === value)),
    `${testCase.name}: target fault was not reached: ${JSON.stringify(records)}`);
  }
  assert.deepEqual(records.filter(({ event }) => event === "closeHandleChecked").map(({ detail }) => detail),
    testCase.closeDetails ?? [], `${testCase.name}: unexpected handle close contract`);
  return records;
}

const cases = [
  {
    name: "Job Create failure reaches create seam and has zero PTY spawn",
    fault: "create",
    noSpawn: true,
    events: ["extendWin32ProcessBindings", "createJobObjectW", "isNullPtr"],
    target: { event: "createJobObjectW", detail: { fault: "create" } },
  },
  {
    name: "Job SetInformation failure closes Job before zero PTY spawn",
    fault: "set",
    noSpawn: true,
    events: ["extendWin32ProcessBindings", "createJobObjectW", "isNullPtr", "setInformationJobObject", "closeHandleChecked"],
    target: { event: "setInformationJobObject", detail: { fault: "set" } },
    closeDetails: ["Git Bash PTY unconfigured Job"],
  },
  {
    name: "Job Assign failure closes self and Job before zero PTY spawn",
    fault: "assign",
    noSpawn: true,
    events: ["extendWin32ProcessBindings", "createJobObjectW", "isNullPtr", "setInformationJobObject", "openProcess", "isNullPtr", "assignProcessToJobObject", "closeHandleChecked", "closeHandleChecked"],
    target: { event: "assignProcessToJobObject", detail: { fault: "assign" } },
    closeDetails: ["Git Bash PTY helper process", "Git Bash PTY unassigned Job"],
  },
  {
    name: "missing control dependency fails closed",
    missingControl: true,
    noSpawn: true,
    events: [],
  },
  {
    name: "missing node-pty dependency fails closed after Job setup",
    missingNodePty: true,
    noSpawn: true,
    events: ["extendWin32ProcessBindings", "createJobObjectW", "isNullPtr", "setInformationJobObject", "openProcess", "isNullPtr", "assignProcessToJobObject", "closeHandleChecked"],
    closeDetails: ["Git Bash PTY helper process"],
  },
  {
    name: "malformed control protocol fails closed before start",
    controlFault: "malformed",
    noSpawn: true,
    events: ["extendWin32ProcessBindings"],
  },
  {
    name: "unknown control protocol fails closed before start",
    controlFault: "unknown",
    noSpawn: true,
    events: ["extendWin32ProcessBindings"],
  },
  {
    name: "invalid start request fails closed before Job setup",
    controlFault: "bad-start",
    noSpawn: true,
    events: ["extendWin32ProcessBindings"],
  },
  {
    name: "positive control reaches node-pty spawn before known stub error",
    fault: "pty-throw",
    noSpawn: false,
    events: ["extendWin32ProcessBindings", "createJobObjectW", "isNullPtr", "setInformationJobObject", "openProcess", "isNullPtr", "assignProcessToJobObject", "closeHandleChecked", "pty.spawn"],
    target: { event: "pty.spawn", detail: { fault: "pty-throw" } },
    closeDetails: ["Git Bash PTY helper process"],
  },
];

async function main() {
  assert.equal(process.platform, "win32", "this contract must execute with the Windows Node runtime");
  assert.equal(existsSync(HELPER), true, `missing frozen helper artifact: ${HELPER}`);
  console.log(`SOURCE_PTY_HELPER_SHA256=${sha256(SOURCE)}`);
  console.log(`DIST_PTY_HELPER_SHA256=${sha256(DIST)}`);
  console.log(`HELPER_CASE_COUNT=${cases.length}`);
  let passed = 0;
  for (const testCase of cases) {
    const fixture = makeFixture(testCase);
    let result;
    try {
      result = await runHelper(fixture);
      assert.equal(result.reaped, true, `${testCase.name}: child was not reaped after watchdog cleanup`);
      assert.equal(result.timedOut, false, `${testCase.name}: helper timed out; kill=${String(result.killResult)} error=${String(result.killError)}`);
      assert.equal(result.spawnError, undefined, `${testCase.name}: child spawn error ${String(result.spawnError)}`);
      assert.equal(result.code, 1, `${testCase.name}: expected exit code 1, got ${result.code}/${result.signal}`);
      assert.match(result.stderr, /Git Bash PTY (?:helper initialization failed|helper transport or startup failed)/i);
      assert.equal(existsSync(fixture.marker), !testCase.noSpawn,
        `${testCase.name}: unexpected PTY spawn marker state; stderr=${result.stderr}`);
      const trace = assertTraceContract(testCase, fixture);
      console.log(`TRACE ${testCase.name}: ${JSON.stringify(trace)}`);
      console.log(`PASS ${testCase.name}`);
      passed += 1;
    } finally {
      // Never remove a fixture while an unreaped child could still reference it.
      if (result?.reaped !== false) rmSync(fixture.root, { recursive: true, force: true });
      else console.error(`RETAINED_UNREAPED_FIXTURE=${fixture.root}`);
    }
  }
  console.log(`PTY helper failure contract: ${passed}/${cases.length} passed, 0 failed`);
}

if (process.platform !== "win32") {
  console.log("SKIP PTY helper failure contract: requires Windows Node (process.platform=win32)");
} else {
  await main();
}
