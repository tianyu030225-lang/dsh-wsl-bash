const MINIMAL_FIELDS = ["ProcessId", "ParentProcessId", "CreationDate"];
const DETAIL_FIELDS = [
  ...MINIMAL_FIELDS,
  "Name",
  "ExecutablePath",
  "CommandLine",
];

export function creationDateMilliseconds(value, label = "CreationDate") {
  const text = String(value ?? "");
  const dotNet = /^\/Date\((-?\d+)(?:[+-]\d+)?\)\/$/.exec(text);
  const milliseconds = dotNet === null ? Date.parse(text) : Number(dotNet[1]);
  if (!Number.isFinite(milliseconds)) {
    throw new Error(`${label} is not a parseable CreationDate: ${JSON.stringify(value)}`);
  }
  return milliseconds;
}

export function sameCreationDate(left, right, label = "CreationDate") {
  return creationDateMilliseconds(left, `${label} left`)
    === creationDateMilliseconds(right, `${label} right`);
}

function safePid(value, label) {
  const pid = Number(value);
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error(`${label} has invalid ProcessId=${JSON.stringify(value)}`);
  }
  return pid;
}

function normalizeRow(row, index, label) {
  if (typeof row !== "object" || row === null || Array.isArray(row)) {
    throw new Error(`${label} row ${index} is not an object`);
  }
  const pid = Number(row.ProcessId);
  if (!Number.isSafeInteger(pid) || pid < 0) {
    throw new Error(`${label} row ${index} has invalid ProcessId=${JSON.stringify(row.ProcessId)}`);
  }
  const parentPid = Number(row.ParentProcessId);
  if (!Number.isSafeInteger(parentPid) || parentPid < 0) {
    throw new Error(`${label} row ${index} has invalid ParentProcessId=${JSON.stringify(row.ParentProcessId)}`);
  }
  const creationDate = String(row.CreationDate ?? "");
  if (creationDate.length === 0) {
    throw new Error(`${label} row ${index} has no CreationDate`);
  }
  return { ...row, ProcessId: pid, ParentProcessId: parentPid, CreationDate: creationDate };
}

export function processMinimalFields() {
  return [...MINIMAL_FIELDS];
}

export function processDetailFields() {
  return [...DETAIL_FIELDS];
}

export function buildProcessSnapshotScript() {
  const fields = MINIMAL_FIELDS.join(",");
  return `$p=Get-CimInstance Win32_Process -Property ${fields} | Select-Object ${fields}; if ($null -eq $p) { exit 4 }; $p | ConvertTo-Json -Compress`;
}

export function buildProcessDetailsScript(pids) {
  const ids = [...new Set((Array.isArray(pids) ? pids : []).map((value) => safePid(value, "detail PID")))];
  if (ids.length === 0) throw new Error("process detail query requires at least one PID");
  const filter = ids.map((pid) => `ProcessId=${pid}`).join(" OR ");
  const fields = DETAIL_FIELDS.join(",");
  return `$p=Get-CimInstance Win32_Process -Filter '${filter}' | Select-Object ${fields}; if ($null -eq $p) { exit 4 }; $p | ConvertTo-Json -Compress`;
}

export function parseProcessRows(value, label) {
  let parsed = value;
  if (typeof value === "string") {
    const text = value.trim();
    if (text.length === 0) throw new Error(`${label} returned empty output`);
    parsed = JSON.parse(text);
  }
  const rows = parsed === null || parsed === undefined
    ? []
    : Array.isArray(parsed) ? parsed : [parsed];
  if (rows.length === 0) throw new Error(`${label} returned an empty process snapshot`);
  return rows.map((row, index) => normalizeRow(row, index, label));
}

function processRowsByPid(rows, label) {
  const byPid = new Map();
  const creationTimes = new Map();
  for (const row of rows) {
    const creationTime = creationDateMilliseconds(row.CreationDate, `PID ${row.ProcessId}`);
    const previous = byPid.get(row.ProcessId);
    if (previous !== undefined) {
      if (creationTimes.get(row.ProcessId) !== creationTime) {
        throw new Error(`${label} reused PID ${row.ProcessId} with different CreationDate`);
      }
      throw new Error(`${label} duplicated PID ${row.ProcessId}`);
    }
    byPid.set(row.ProcessId, row);
    creationTimes.set(row.ProcessId, creationTime);
  }
  return byPid;
}

export function buildProcessTree(rows, rootPid) {
  const normalized = parseProcessRows(rows, "Win32_Process snapshot");
  const root = safePid(rootPid, "process-tree root");
  const byPid = new Map();
  const byParent = new Map();
  const creationTimes = new Map();
  for (const row of normalized) {
    const creationTime = creationDateMilliseconds(row.CreationDate, `PID ${row.ProcessId}`);
    const previous = byPid.get(row.ProcessId);
    if (previous !== undefined) {
      if (previous.CreationDate !== row.CreationDate) {
        throw new Error(`Win32_Process snapshot reused PID ${row.ProcessId} with different CreationDate`);
      }
      throw new Error(`Win32_Process snapshot duplicated PID ${row.ProcessId}`);
    }
    byPid.set(row.ProcessId, row);
    creationTimes.set(row.ProcessId, creationTime);
    const children = byParent.get(row.ParentProcessId) ?? [];
    children.push(row);
    byParent.set(row.ParentProcessId, children);
  }
  if (!byPid.has(root)) throw new Error(`Win32_Process snapshot did not contain root PID ${root}`);
  const descendants = [];
  const pending = [root];
  const seen = new Set([root]);
  while (pending.length > 0) {
    const parent = pending.shift();
    for (const child of byParent.get(parent) ?? []) {
      if (creationTimes.get(child.ProcessId) < creationTimes.get(parent)) continue;
      if (seen.has(child.ProcessId)) {
        throw new Error(`Win32_Process snapshot contained a process-tree cycle at PID ${child.ProcessId}`);
      }
      seen.add(child.ProcessId);
      descendants.push(child);
      pending.push(child.ProcessId);
    }
  }
  return descendants;
}

export function matchProcessIdentities(rows, identities, label = "Win32_Process identities") {
  const normalized = parseProcessRows(rows, label);
  const byPid = processRowsByPid(normalized, label);
  return (Array.isArray(identities) ? identities : []).map((identity) => {
    const pid = safePid(identity?.pid, `${label} PID`);
    const row = byPid.get(pid);
    if (row === undefined) return { identity, process: undefined };
    return {
      identity,
      process: sameCreationDate(row.CreationDate, identity?.creationDate, `${label} PID ${pid}`)
        ? row
        : undefined,
    };
  });
}

export function mergeProcessDetails(minimalRows, detailRows, label = "Win32_Process details") {
  const minimal = Array.isArray(minimalRows) ? minimalRows.map((row, index) => normalizeRow(row, index, `${label} minimal`)) : [];
  if (minimal.length === 0) return [];
  processRowsByPid(minimal, `${label} minimal`);
  const details = parseProcessRows(detailRows, label);
  const byPid = processRowsByPid(details, label);
  return minimal.map((row) => {
    const detail = byPid.get(row.ProcessId);
    if (detail === undefined || !sameCreationDate(detail.CreationDate, row.CreationDate, `${label} PID ${row.ProcessId}`)) {
      throw new Error(`${label} did not preserve PID ${row.ProcessId} CreationDate identity`);
    }
    return { ...row, ...detail };
  });
}
