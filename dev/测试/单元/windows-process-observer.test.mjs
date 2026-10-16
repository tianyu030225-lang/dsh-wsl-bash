import assert from "node:assert/strict";
import {
  buildProcessDetailsScript,
  buildProcessSnapshotScript,
  buildProcessTree,
  matchProcessIdentities,
  mergeProcessDetails,
  parseProcessRows,
} from "../CLI/probe-package/windows-process-observer.mjs";
import { nativeTreeCandidateProjection } from "../CLI/probe-package/index.mjs";

const row = (ProcessId, ParentProcessId, CreationDate) => ({
  ProcessId,
  ParentProcessId,
  CreationDate,
});

assert.match(
  buildProcessSnapshotScript(),
  /Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate/,
);
assert.doesNotMatch(buildProcessSnapshotScript(), /-Filter 'ParentProcessId=/);
assert.doesNotMatch(buildProcessSnapshotScript(), /ExecutablePath/);
assert.match(buildProcessDetailsScript([11, 12, 11]), /ProcessId=11 OR ProcessId=12/);
assert.match(buildProcessDetailsScript([11, 12]), /ExecutablePath/);
assert.match(buildProcessDetailsScript([11, 12]), /CommandLine/);

assert.throws(() => parseProcessRows("", "snapshot"), /empty output/);
assert.throws(() => parseProcessRows("{not-json}", "snapshot"));
assert.throws(() => buildProcessTree([row(2, 1, "/Date(1700000001000)/")], 1), /did not contain root PID/);
assert.throws(() => buildProcessTree([row(1, 0, "/Date(1700000000000)/"), row(1, 0, "2023-11-14T22:13:21.000Z")], 1), /different CreationDate/);
assert.throws(() => buildProcessTree([row(1, 0, "not-a-date")], 1), /not a parseable CreationDate/);
assert.throws(
  () => mergeProcessDetails([row(2, 1, "/Date(1700000000000)/")], [row(2, 1, "2023-11-14T22:13:21.000Z")], "details"),
  /CreationDate identity/,
);
assert.throws(
  () => matchProcessIdentities([
    row(21, 20, "/Date(1700000000000)/"),
    row(21, 20, "2023-11-14T22:13:21.000Z"),
  ], [{ pid: 21, creationDate: "/Date(1700000000000)/" }], "duplicate identities"),
  /reused PID 21 with different CreationDate/,
);
assert.throws(
  () => mergeProcessDetails(
    [row(21, 20, "/Date(1700000000000)/")],
    [
      row(21, 20, "/Date(1700000000000)/"),
      row(21, 20, "2023-11-14T22:13:21.000Z"),
    ],
    "duplicate details",
  ),
  /reused PID 21 with different CreationDate/,
);

const tree = buildProcessTree([
  row(0, 0, "/Date(1699999999000)/"),
  row(10, 1, "/Date(1700000000000)/"),
  row(11, 10, "2023-11-14T22:13:21.000Z"),
  row(12, 11, "/Date(1700000002000)/"),
  row(99, 1, "2023-11-14T22:13:21.000Z"),
], 10);
assert.deepEqual(tree.map((item) => item.ProcessId), [11, 12]);
assert.ok(tree.every((item) => item.CreationDate.length > 0));

const pidReusedTree = buildProcessTree([
  row(100, 1, "/Date(1700000000000)/"),
  row(200, 100, "2023-11-14T22:13:19.000Z"),
  row(201, 100, "2023-11-14T22:13:21.000Z"),
], 100);
assert.deepEqual(pidReusedTree.map((item) => item.ProcessId), [201]);

const nestedSnapshot = [
  row(100, 1, "/Date(1700000000000)/"),
  row(200, 100, "/Date(1700000001000)/"),
  row(300, 200, "/Date(1700000002000)/"),
  row(400, 300, "/Date(1700000003000)/"),
];
const helperChildren = buildProcessTree(nestedSnapshot, 100);
const topDescendants = buildProcessTree(nestedSnapshot, 200);
const projectedCandidates = nativeTreeCandidateProjection(
  nestedSnapshot,
  helperChildren,
  topDescendants,
);
assert.deepEqual(projectedCandidates.map((item) => item.ProcessId), [200, 300, 400]);
assert.equal(new Set(projectedCandidates.map((item) => item.ProcessId)).size, 3);
assert.throws(
  () => buildProcessTree([
    row(100, 1, "/Date(1700000000000)/"),
    row(200, 100, "/Date(1700000001000)/"),
    row(200, 100, "/Date(1700000002001)/"),
  ], 100),
  /different CreationDate/,
);

const matched = matchProcessIdentities([
  row(21, 20, "/Date(1700000000000)/"),
], [
  { pid: 21, creationDate: "2023-11-14T22:13:20.000Z" },
  { pid: 22, creationDate: "/Date(1700000000000)/" },
], "cleanup");
assert.equal(matched[0].process.ProcessId, 21);
assert.equal(matched[1].process, undefined);

const minimal = [row(21, 20, "/Date(1700000000000)/")];
const merged = mergeProcessDetails(minimal, [{
  ...minimal[0],
  Name: "bash.exe",
  ExecutablePath: "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
  CommandLine: "bash --noprofile --norc -i",
}], "candidate");
assert.deepEqual(merged[0], {
  ...minimal[0],
  Name: "bash.exe",
  ExecutablePath: "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
  CommandLine: "bash --noprofile --norc -i",
});

console.log("windows-process-observer offline assertions: PASS");
