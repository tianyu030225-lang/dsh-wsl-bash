import {
  resolveWslDistro,
  resolveWslExecutable,
  resolveWslWorkspacePaths,
} from "../discovery/wsl.js";
import { resolveHostBoundary } from "../wsl/launcher.js";
import { buildBwrapArgs } from "../wsl/sandbox.js";
import { spawn } from "node:child_process";
import type { SubprocessRuntime } from "@deepseek-ai/dsh-subprocess";
import {
  approveOneShotEscalation,
  type ApprovalContext,
  type ApproveEscalation,
  approveEscalation,
  type SandboxMode,
} from "./approval.js";
import {
  DEFAULT_MEMORY_LIMIT,
  DEFAULT_SPILL_LIMIT,
  renderCapturedOutput,
  type CapturedOutput,
} from "./output.js";
import {
  runForeground,
  runSubprocessForeground,
  validateTimeout,
  type ForegroundProcessResult,
} from "./process.js";

export const WSL_BASH_TOOL_NAME = "wsl_bash";

/** This script is constant; model command text is supplied only as base64 argv. */
export const WSL_RUNNER_SCRIPT =
  'set -eu; command -v /usr/bin/script >/dev/null 2>&1; export DSH_COMMAND_B64="$1"; exec /usr/bin/script -qefc \'/bin/bash --noprofile --norc -c "$(printf %s "$DSH_COMMAND_B64" | /usr/bin/base64 -d)"\' /dev/null';

export interface WslBashArgs {
  command: string;
  description: string;
  workdir?: string | undefined;
  timeoutMs?: number | undefined;
  sandbox_permissions?: SandboxMode | undefined;
  justification?: string | undefined;
}

export interface WslSandboxPolicy {
  /** Must be supplied by the immutable DSH sandbox policy for every mode. */
  mode: SandboxMode;
  workspaceRoot?: string | undefined;
}

interface CanonicalWslPaths {
  workspaceRoot: string;
  cwd: string;
}

export interface WslArgvPlan {
  executable: string;
  argv: readonly string[];
  cwd?: string;
  mode: SandboxMode;
  workspaceRoot?: string;
}

export interface WslRuntimeProbeResult {
  ok: boolean;
  message?: string;
}

export interface WslBashExecutionOptions {
  policy: WslSandboxPolicy;
  executable?: string | undefined;
  distro?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  platform?: NodeJS.Platform | undefined;
  signal?: AbortSignal | undefined;
  approvalContext?: ApprovalContext | undefined;
  approve?: ApproveEscalation | undefined;
  /** Inject a preflight in tests or when the host already ran doctor. */
  probeRuntime?: ((options: {
    executable: string;
    distro: string;
    signal?: AbortSignal | undefined;
    subprocess?: SubprocessRuntime | undefined;
  }) => Promise<WslRuntimeProbeResult>) | undefined;
  /** The host may use a different spill directory, but limits are fixed by default. */
  spillDirectory?: string | undefined;
  memoryLimit?: number | undefined;
  spillLimit?: number | undefined;
  /** Set only for deterministic unit tests; production should retain preflight. */
  skipPreflight?: boolean | undefined;
  spawnImpl?: typeof spawn | undefined;
  /** Official rc.6 subprocess service used by mounted DSH tools. */
  subprocess?: SubprocessRuntime | undefined;
}

export interface WslBashResult extends ForegroundProcessResult {
  sandbox: {
    mode: SandboxMode;
    enforcement: "bwrap";
    denied: boolean;
    runnerFailed?: boolean;
  };
}

/** Build the exact direct-argv call to wsl.exe. */
export function buildWslArgv(
  args: WslBashArgs,
  policy: WslSandboxPolicy,
  options: Pick<WslBashExecutionOptions, "executable" | "distro" | "env" | "platform"> & {
    canonicalPaths?: CanonicalWslPaths | undefined;
  } = {},
): WslArgvPlan {
  validateWslArgs(args);
  const mode = policy.mode;
  const executable = resolveWslExecutable({
    executable: options.executable,
    env: options.env,
    platform: options.platform,
  });
  const distro = resolveWslDistro({ distro: options.distro, env: options.env });
  const encodedCommand = Buffer.from(args.command, "utf8").toString("base64");

  if (!policy.workspaceRoot) {
    throw new Error("wsl_bash: execution requires immutable sandboxPolicy.workspaceRoot");
  }
  const paths = options.canonicalPaths ??
    resolveWslWorkspacePaths(policy.workspaceRoot, args.workdir);
  const cwd = paths.cwd;
  const workspaceRoot = paths.workspaceRoot;

  const argv: string[] = ["-d", distro];
  argv.push("--cd", cwd);
  argv.push("--");

  // No --unshare-net: network isolation is intentionally not claimed by this
  // WSL backend. Every mode still gets bwrap's parent-tied PID namespace;
  // danger-full-access changes only filesystem access from ro-bind to bind.
  argv.push(
    "/usr/bin/bwrap",
    ...buildBwrapArgs({
      mode,
      workspaceRootLinux: workspaceRoot,
      workdirLinux: cwd,
      command: "/bin/bash",
      args: [
        "--noprofile",
        "--norc",
        "-c",
        WSL_RUNNER_SCRIPT,
        "dsh-wsl-runner",
        encodedCommand,
      ],
    }),
  );
  return { executable, argv, cwd, mode, workspaceRoot };
}

export async function executeWslBash(
  args: WslBashArgs,
  options: WslBashExecutionOptions,
): Promise<WslBashResult> {
  validateWslArgs(args);
  const signal = options.signal ?? new AbortController().signal;
  let effectiveMode = options.policy.mode;

  if (args.sandbox_permissions !== undefined || args.justification !== undefined) {
    if (!options.approvalContext) {
      return unavailableResult(
        validateTimeout(args.timeoutMs),
        effectiveMode,
        "sandbox escalation requires the rc.6 approval context",
        "sandbox-denied",
      );
    }
    if (args.sandbox_permissions === undefined || args.justification === undefined) {
      return unavailableResult(
        validateTimeout(args.timeoutMs),
        effectiveMode,
        "sandbox_permissions and justification must be supplied together",
        "sandbox-denied",
      );
    }
    try {
      effectiveMode = await approveOneShotEscalation({
        requestedMode: args.sandbox_permissions,
        justification: args.justification,
        effectiveMode,
        subject: "command",
      }, options.approvalContext, options.approve ?? approveEscalation);
      if (effectiveMode !== args.sandbox_permissions) {
        return unavailableResult(
          validateTimeout(args.timeoutMs),
          options.policy.mode,
          "sandbox approval did not grant the exact requested mode",
          "sandbox-denied",
        );
      }
    } catch (error) {
      return unavailableResult(
        validateTimeout(args.timeoutMs),
        options.policy.mode,
        `sandbox escalation rejected: ${error instanceof Error ? error.message : String(error)}`,
        "sandbox-denied",
      );
    }
  }

  const policy = { ...options.policy, mode: effectiveMode };
  let plan: WslArgvPlan;
  try {
    const canonicalPaths = await canonicalizeWslPaths(args, policy, options);
    plan = buildWslArgv(args, policy, { ...options, canonicalPaths });
  } catch (error) {
    return unavailableResult(
      validateTimeout(args.timeoutMs),
      effectiveMode,
      error instanceof Error ? error.message : String(error),
    );
  }

  const distro = resolveWslDistro({ distro: options.distro, env: options.env });
  if (!options.skipPreflight) {
    const probe = options.probeRuntime ?? probeWslRuntime;
    const checked = await probe({
      executable: plan.executable,
      distro,
      signal,
      ...(options.subprocess === undefined ? {} : { subprocess: options.subprocess }),
    });
    if (!checked.ok) {
      return unavailableResult(
        validateTimeout(args.timeoutMs),
        effectiveMode,
        checked.message ?? "WSL/Ubuntu runtime dependencies are unavailable",
      );
    }
  }

  const processRequest = {
    executable: plan.executable,
    argv: plan.argv,
    timeoutMs: args.timeoutMs,
    signal,
    memoryLimit: options.memoryLimit ?? DEFAULT_MEMORY_LIMIT,
    spillLimit: options.spillLimit ?? DEFAULT_SPILL_LIMIT,
    spillDirectory: options.spillDirectory,
  };
  const result = options.subprocess === undefined
    ? await runForeground({
        ...processRequest,
        ...(options.spawnImpl === undefined ? {} : { spawnImpl: options.spawnImpl }),
      })
    : await runSubprocessForeground({ ...processRequest, subprocess: options.subprocess });
  const restricted = effectiveMode !== "danger-full-access";
  const stderrText = result.stderr.text;
  const runnerFailed = restricted &&
    /(?:^|\n)\s*(?:bwrap|script):|creating new namespace|failed to setup|no such file or directory.*(?:bwrap|script)/i.test(stderrText);
  const denied = restricted && result.exitCode !== 0 &&
    /(?:read-only file system|permission denied|operation not permitted|\bEROFS\b|\bEACCES\b)/i.test(stderrText);
  const failure = runnerFailed
    ? { kind: "runner-failure" as const, message: "WSL sandbox runner failed before or while starting the command" }
    : result.failure;
  return {
    ...result,
    ...(failure === undefined ? {} : { failure }),
    sandbox: {
      mode: effectiveMode,
      enforcement: "bwrap",
      denied,
      ...(runnerFailed ? { runnerFailed: true } : {}),
    },
  };
}

export async function probeWslRuntime(options: {
  executable: string;
  distro: string;
  signal?: AbortSignal;
  subprocess?: SubprocessRuntime | undefined;
}): Promise<WslRuntimeProbeResult> {
  // Static probe only; it does not include model data and makes no writes.
  const request = {
    executable: options.executable,
    argv: [
      "-d", options.distro, "--", "/bin/bash", "--noprofile", "--norc", "-c",
      "command -v /bin/bash >/dev/null && command -v /usr/bin/script >/dev/null && command -v /usr/bin/bwrap >/dev/null && /usr/bin/bwrap --die-with-parent --new-session --unshare-pid --unshare-user --ro-bind / / --tmpfs /run --tmpfs /tmp --unsetenv WSL_INTEROP --unsetenv WSLENV --cap-drop ALL --disable-userns -- /bin/sh -c 'test -z \"${WSL_INTEROP-}\" && test -z \"${WSLENV-}\" && ! /mnt/c/Windows/System32/cmd.exe /d /c exit 0' && /usr/bin/script -qefc 'exit 0' /dev/null",
    ],
    timeoutMs: 20_000,
    signal: options.signal,
    memoryLimit: DEFAULT_MEMORY_LIMIT,
    spillLimit: DEFAULT_SPILL_LIMIT,
  };
  const probe = options.subprocess === undefined
    ? await runForeground(request)
    : await runSubprocessForeground({ ...request, subprocess: options.subprocess });
  if (probe.failure) return { ok: false, message: `WSL runtime probe failed: ${probe.failure.message}` };
  if (probe.exitCode !== 0) {
    const detail = renderCapturedOutput(probe.stderr);
    return { ok: false, message: `WSL runtime is missing or cannot function with bash/script/bwrap${detail === "" ? "" : `: ${detail}`}` };
  }
  return { ok: true };
}

const WSL_CANONICALIZE_SCRIPT = [
  "set -eu",
  'root=$(/usr/bin/wslpath -a -u "$1")',
  'cwd=$(/usr/bin/wslpath -a -u "$2")',
  'root=$(/usr/bin/realpath -e -- "$root")',
  'cwd=$(/usr/bin/realpath -e -- "$cwd")',
  'case "$cwd" in "$root"|"$root"/*) ;; *) exit 23 ;; esac',
  'printf "%s\\n%s\\n" "$root" "$cwd"',
].join("; ");

/** Resolve host paths in WSL before using either one as a bwrap mount point. */
async function canonicalizeWslPaths(
  args: WslBashArgs,
  policy: WslSandboxPolicy,
  options: WslBashExecutionOptions,
): Promise<CanonicalWslPaths | undefined> {
  if (options.subprocess === undefined) return undefined;
  if (!policy.workspaceRoot) {
    throw new Error("wsl_bash: execution requires immutable sandboxPolicy.workspaceRoot");
  }
  const executable = resolveWslExecutable({
    executable: options.executable,
    env: options.env,
    platform: options.platform,
  });
  const distro = resolveWslDistro({ distro: options.distro, env: options.env });
  const boundary = resolveHostBoundary({
    mode: policy.mode,
    workspaceRoot: policy.workspaceRoot,
    workdir: args.workdir,
  });
  const result = await runSubprocessForeground({
    executable,
    argv: [
      "-d",
      distro,
      "--exec",
      "/bin/bash",
      "--noprofile",
      "--norc",
      "-c",
      WSL_CANONICALIZE_SCRIPT,
      "dsh-wsl-canonicalize",
      boundary.workspaceRoot,
      boundary.workdir,
    ],
    timeoutMs: 20_000,
    signal: options.signal,
    memoryLimit: 16 * 1024,
    spillLimit: 16 * 1024,
    subprocess: options.subprocess,
  });
  if (result.failure !== undefined || result.exitCode !== 0 || result.signal !== null) {
    const detail = renderCapturedOutput(result.stderr);
    throw new Error(
      `wsl_bash: WSL path canonicalization failed${detail === "" ? "" : `: ${detail}`}`,
    );
  }
  if (result.stdout.truncated || result.stderr.truncated) {
    throw new Error(
      "wsl_bash: WSL path canonicalization output exceeded the 16KiB safety bound",
    );
  }
  const canonical = result.stdout.text.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  if (!canonical.endsWith("\n")) {
    throw new Error("wsl_bash: WSL path canonicalization returned invalid framing");
  }
  const lines = canonical.slice(0, -1).split("\n");
  const workspaceRoot = lines[0] ?? "";
  const cwd = lines[1] ?? "";
  if (
    lines.length !== 2 ||
    !workspaceRoot.startsWith("/") ||
    !cwd.startsWith("/") ||
    workspaceRoot.includes("\0") ||
    cwd.includes("\0")
  ) {
    throw new Error("wsl_bash: WSL path canonicalization returned invalid paths or framing");
  }
  const expected = resolveWslWorkspacePaths(boundary.workspaceRoot, boundary.workdir);
  if (workspaceRoot !== expected.workspaceRoot || cwd !== expected.cwd) {
    throw new Error(
      "wsl_bash: WSL realpath did not match the immutable Windows sandbox mapping",
    );
  }
  return expected;
}

function validateWslArgs(args: WslBashArgs): void {
  if (typeof args.command !== "string" || args.command.trim().length === 0) {
    throw new Error("invalid command: expected a non-empty string");
  }
  if (args.command.includes("\0")) {
    throw new Error("invalid command: NUL bytes are not allowed");
  }
  if (typeof args.description !== "string" || args.description.trim().length === 0) {
    throw new Error("invalid description: expected a non-empty string");
  }
  if (args.description.includes("\0")) {
    throw new Error("invalid description: NUL bytes are not allowed");
  }
  validateTimeout(args.timeoutMs);
  if (args.sandbox_permissions !== undefined && args.justification === undefined) {
    throw new Error("sandbox_permissions requires justification");
  }
  if (args.justification !== undefined && args.sandbox_permissions === undefined) {
    throw new Error("justification requires sandbox_permissions");
  }
}

function unavailableResult(
  timeoutMs: number,
  mode: SandboxMode,
  message: string,
  failureKind: "sandbox-unavailable" | "sandbox-denied" = "sandbox-unavailable",
): WslBashResult {
  const empty: CapturedOutput = {
    text: "",
    truncated: false,
    spillBytes: 0,
    totalBytes: 0,
    overflowed: false,
  };
  return {
    exitCode: null,
    signal: null,
    timedOut: false,
    aborted: false,
    timeoutMs,
    stdout: empty,
    stderr: { ...empty, text: message },
    failure: { kind: failureKind, message },
    sandbox: {
      mode,
      enforcement: "bwrap",
      denied: failureKind === "sandbox-denied",
    },
  };
}
