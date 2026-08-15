import { spawn } from "node:child_process";
import type { SubprocessRuntime } from "@deepseek-ai/dsh-subprocess";
import {
  resolveGitBashPath,
  rejectUnsafeWindowsPath,
} from "../discovery/git-bash.js";
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
  type CapturedOutput,
} from "./output.js";
import {
  runForeground,
  runSubprocessForeground,
  validateTimeout,
  type ForegroundProcessResult,
} from "./process.js";

export const GIT_BASH_TOOL_NAME = "git_bash";

export interface GitBashArgs {
  command: string;
  description: string;
  workdir?: string | undefined;
  timeoutMs?: number | undefined;
  sandbox_permissions?: SandboxMode | undefined;
  justification?: string | undefined;
}

export interface GitBashPolicy {
  mode: SandboxMode;
}

export interface GitBashArgvPlan {
  executable: string;
  argv: readonly string[];
  cwd?: string;
  mode: SandboxMode;
}

export interface GitBashExecutionOptions {
  policy: GitBashPolicy;
  executable?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  platform?: NodeJS.Platform | undefined;
  config?: { gitBashPath?: string; gitBashExecutable?: string; bashPath?: string; executable?: string } | string | undefined;
  signal?: AbortSignal | undefined;
  approvalContext?: ApprovalContext | undefined;
  approve?: ApproveEscalation | undefined;
  spillDirectory?: string | undefined;
  memoryLimit?: number | undefined;
  spillLimit?: number | undefined;
  spawnImpl?: typeof spawn | undefined;
  /** Official rc.6 subprocess service used by mounted DSH tools. */
  subprocess?: SubprocessRuntime | undefined;
}

export interface GitBashResult extends ForegroundProcessResult {
  /** Git Bash is never presented as sandboxed; `none` is an explicit fact. */
  sandbox: {
    mode: SandboxMode;
    enforcement: "none";
    denied: boolean;
  };
}

/** Build the native Git Bash argv; command is exactly one `-c` argument. */
export function buildGitBashArgv(
  args: GitBashArgs,
  options: Pick<GitBashExecutionOptions, "executable" | "env" | "platform" | "config"> = {},
  mode: SandboxMode = "danger-full-access",
): GitBashArgvPlan {
  validateGitBashArgs(args);
  const executable = resolveGitBashPath(options.executable, {
    env: options.env,
    platform: options.platform,
    config: options.config,
  });
  const cwd = normalizeGitWorkdir(args.workdir);
  return {
    executable,
    argv: ["--noprofile", "--norc", "-c", args.command],
    ...(cwd === undefined ? {} : { cwd }),
    mode,
  };
}

export async function executeGitBash(
  args: GitBashArgs,
  options: GitBashExecutionOptions,
): Promise<GitBashResult> {
  validateGitBashArgs(args);
  const timeoutMs = validateTimeout(args.timeoutMs);
  const signal = options.signal ?? new AbortController().signal;
  let effectiveMode = options.policy.mode;

  // Git for Windows cannot participate in DSH's restricted Windows token
  // boundary.  Refuse before executable discovery/spawn, rather than running
  // and implying that a sandbox exists.
  if (effectiveMode !== "danger-full-access") {
    if (args.sandbox_permissions !== undefined || args.justification !== undefined) {
      if (args.sandbox_permissions !== "danger-full-access" || args.justification === undefined) {
        return deniedResult(timeoutMs, effectiveMode, "git_bash restricted mode has no Windows sandbox; only danger-full-access is an allowed exact retry");
      }
      if (!options.approvalContext) {
        return deniedResult(timeoutMs, effectiveMode, "git_bash escalation requires the rc.6 approval context");
      }
      try {
        effectiveMode = await approveOneShotEscalation({
          requestedMode: args.sandbox_permissions,
          justification: args.justification,
          effectiveMode,
          subject: "command",
        }, options.approvalContext, options.approve ?? approveEscalation);
        if (effectiveMode !== "danger-full-access") {
          return deniedResult(timeoutMs, options.policy.mode, "git_bash approval did not grant the required danger-full-access mode");
        }
      } catch (error) {
        return deniedResult(timeoutMs, options.policy.mode, `git_bash escalation rejected: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else {
      return deniedResult(
        timeoutMs,
        effectiveMode,
        "git_bash is unavailable under read-only/workspace-write: Git Bash has no restricted Windows sandbox and no process was started. Retry this exact command with sandbox_permissions: danger-full-access plus justification.",
      );
    }
  } else if (args.sandbox_permissions !== undefined || args.justification !== undefined) {
    return deniedResult(timeoutMs, effectiveMode, "sandbox_permissions is only valid as a retry from a restricted Git Bash call");
  }

  let plan: GitBashArgvPlan;
  try {
    plan = buildGitBashArgv(args, options, effectiveMode);
  } catch (error) {
    return deniedResult(timeoutMs, effectiveMode, error instanceof Error ? error.message : String(error));
  }
  const processRequest = {
    executable: plan.executable,
    argv: plan.argv,
    cwd: plan.cwd,
    env: options.env,
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
  return { ...result, sandbox: { mode: effectiveMode, enforcement: "none", denied: false } };
}

function normalizeGitWorkdir(workdir: string | undefined): string | undefined {
  if (workdir === undefined || workdir.trim().length === 0) return undefined;
  const value = workdir.trim();
  if (value.includes("\0")) throw new Error("workdir contains NUL");
  // Absolute workdirs must be local Windows paths; relative values are passed
  // as cwd and resolved by Node without a shell.
  if (/^(?:\\\\|\/\/|\\\\[?.]|\\\?\?\\|\/\?\?\/)/.test(value)) {
    throw new Error("workdir must not use UNC or device namespaces");
  }
  if (/^[A-Za-z]:/.test(value)) rejectUnsafeWindowsPath(value);
  return value;
}

function validateGitBashArgs(args: GitBashArgs): void {
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

function deniedResult(timeoutMs: number, mode: SandboxMode, message: string): GitBashResult {
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
    failure: { kind: "sandbox-denied", message },
    sandbox: { mode, enforcement: "none", denied: true },
  };
}
