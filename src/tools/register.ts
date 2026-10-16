import type { Context } from "@deepseek-ai/cordis";
import { ESCALATION_TARGETS } from "@deepseek-ai/dsh-sandbox";
import type { SandboxExecutionPolicy, SandboxMode } from "@deepseek-ai/dsh-sandbox";
import type { SubprocessRuntime } from "@deepseek-ai/dsh-subprocess";
import { defineTool, type ToolRunContext } from "@deepseek-ai/dsh-tools";

import {
  executeGitBash,
  GIT_BASH_TOOL_NAME,
  type GitBashArgs,
  type GitBashResult,
} from "./git-bash.js";
import { renderOneShotResult } from "./render.js";
import {
  executeWslBash,
  WSL_BASH_TOOL_NAME,
  type WslBashArgs,
  type WslBashResult,
} from "./wsl-bash.js";
import type { ResolvedPluginConfig } from "../types.js";

const INTEGER_OR_NULL = [
  { type: "integer" },
  { type: "null" },
] as const;

const STRING_OR_NULL = [
  { type: "string" },
  { type: "null" },
] as const;

const CAPTURED_STREAM_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    text: { type: "string", required: true },
    truncated: { type: "boolean", required: true },
    spillPath: { type: "string" },
  },
} as const;

const ONE_SHOT_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    kind: { type: "string", const: "foreground", required: true },
    exitCode: { oneOf: INTEGER_OR_NULL, required: true },
    signal: { oneOf: STRING_OR_NULL, required: true },
    timedOut: { type: "boolean", required: true },
    aborted: { type: "boolean", required: true },
    timeoutMs: { type: "number", required: true },
    stdout: { ...CAPTURED_STREAM_SCHEMA, required: true },
    stderr: { ...CAPTURED_STREAM_SCHEMA, required: true },
    sandbox: {
      type: "object",
      additionalProperties: false,
      required: true,
      properties: {
        mode: { type: "string", required: true },
        denied: { type: "boolean", required: true },
        enforcement: { type: "string" },
        runnerFailed: { type: "boolean" },
      },
    },
  },
} as const;

type OneShotOutput = {
  kind: "foreground";
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  aborted: boolean;
  timeoutMs: number;
  stdout: { text: string; truncated: boolean; spillPath?: string };
  stderr: { text: string; truncated: boolean; spillPath?: string };
  sandbox: {
    mode: SandboxMode;
    denied: boolean;
    enforcement: "bwrap" | "none";
    runnerFailed?: boolean;
  };
};

type OneShotResult = WslBashResult | GitBashResult;

function oneShotParameters() {
  return {
    command: {
      type: "string",
      required: true,
      description: "The shell command to execute.",
    },
    description: {
      type: "string",
      required: true,
      description: "Clear, concise description of this command.",
    },
    workdir: {
      type: "string",
      description: "Working directory; relative paths use the workspace.",
    },
    timeoutMs: {
      type: "number",
      description: "Timeout in milliseconds.",
    },
    sandbox_permissions: {
      type: "string",
      enum: [...ESCALATION_TARGETS],
      description: "A strictly wider mode for an exact approved retry.",
    },
    justification: {
      type: "string",
      description: "Why this exact command needs wider access.",
    },
  } as const;
}

function canonicalStream(stream: OneShotResult["stdout"]): OneShotOutput["stdout"] {
  return {
    text: stream.text,
    truncated: stream.truncated,
    ...(stream.spillPath === undefined ? {} : { spillPath: stream.spillPath }),
  };
}

function canonicalResult(result: OneShotResult): OneShotOutput {
  return {
    kind: "foreground",
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    aborted: result.aborted,
    timeoutMs: result.timeoutMs,
    stdout: canonicalStream(result.stdout),
    stderr: canonicalStream(result.stderr),
    sandbox: {
      mode: result.sandbox.mode,
      denied: result.sandbox.denied,
      enforcement: result.sandbox.enforcement,
      ...(!("runnerFailed" in result.sandbox) || result.sandbox.runnerFailed === undefined
        ? {}
        : { runnerFailed: result.sandbox.runnerFailed }),
    },
  };
}

function renderCanonical(value: OneShotOutput): string {
  return renderOneShotResult({
    ...value,
    stdout: value.stdout,
    stderr: value.stderr,
  });
}

function resolvePolicy(ctx: Context, exec: ToolRunContext): SandboxExecutionPolicy {
  const policyService = ctx.get("sandboxPolicy");
  if (policyService === undefined || typeof policyService.resolve !== "function") {
    throw new Error("dsh-plugin-bash-wsl: sandboxPolicy service is required");
  }
  return policyService.resolve(
    exec.agent === undefined ? {} : { session: exec.agent.session },
  );
}

function approvalContext(ctx: Context, exec: ToolRunContext, toolName: string) {
  return {
    approver: ctx.get("approval"),
    agent: exec.agent,
    callId: exec.callId,
    toolName,
    signal: exec.signal,
  };
}

function subprocessOf(ctx: Context): SubprocessRuntime {
  const subprocess = ctx.get("subprocess");
  if (subprocess === undefined || typeof subprocess.spawn !== "function") {
    throw new Error("dsh-plugin-bash-wsl: subprocess service is required");
  }
  return subprocess;
}

function toolDescription(name: string): string {
  return name === WSL_BASH_TOOL_NAME
    ? "Execute one clean Bash command in the configured Ubuntu WSL distribution."
    : "Execute one native Bash command through Git for Windows.";
}

/** Register the model-facing stateless tools beside the official persistent bash. */
export function registerOneShotTools(
  ctx: Context,
  config: ResolvedPluginConfig,
): void {
  ctx.tools.register(defineTool({
    name: WSL_BASH_TOOL_NAME,
    description: toolDescription(WSL_BASH_TOOL_NAME),
    parameters: oneShotParameters(),
    output: {
      schema: ONE_SHOT_OUTPUT_SCHEMA,
      render: (_args, value) => [{
        type: "text",
        text: renderCanonical(value as OneShotOutput),
      }],
    },
    async execute(args, exec) {
      const standingPolicy = resolvePolicy(ctx, exec);
      const executionArgs = {
        ...args,
        timeoutMs: args.timeoutMs ?? config.oneShotTimeoutMs,
      } as WslBashArgs;
      const result = await executeWslBash(executionArgs, {
        policy: standingPolicy,
        executable: config.wslExecutable,
        distro: config.distro,
        signal: exec.signal,
        approvalContext: approvalContext(ctx, exec, WSL_BASH_TOOL_NAME),
        subprocess: subprocessOf(ctx),
        memoryLimit: config.oneShotMaxOutputBytes,
        spillLimit: config.oneShotMaxSpillBytes,
        skipPreflight: false,
      });
      return canonicalResult(result);
    },
    presentCall: (args) => ({
      card: "terminal",
      title: args.command,
      description: args.description,
      ...(args.workdir === undefined ? {} : { cwd: args.workdir }),
    }),
  }));

  ctx.tools.register(defineTool({
    name: GIT_BASH_TOOL_NAME,
    description: toolDescription(GIT_BASH_TOOL_NAME),
    parameters: oneShotParameters(),
    output: {
      schema: ONE_SHOT_OUTPUT_SCHEMA,
      render: (_args, value) => [{
        type: "text",
        text: renderCanonical(value as OneShotOutput),
      }],
    },
    async execute(args, exec) {
      const standingPolicy = resolvePolicy(ctx, exec);
      if (typeof standingPolicy.workspaceRoot !== "string" || standingPolicy.workspaceRoot.length === 0) {
        throw new Error("git_bash: execution requires immutable sandboxPolicy.workspaceRoot");
      }
      const executionArgs = {
        ...args,
        timeoutMs: args.timeoutMs ?? config.oneShotTimeoutMs,
      } as GitBashArgs;
      const result = await executeGitBash(executionArgs, {
        policy: standingPolicy,
        executable: config.gitBashExecutable,
        signal: exec.signal,
        approvalContext: approvalContext(ctx, exec, GIT_BASH_TOOL_NAME),
        subprocess: subprocessOf(ctx),
        memoryLimit: config.oneShotMaxOutputBytes,
        spillLimit: config.oneShotMaxSpillBytes,
      });
      return canonicalResult(result);
    },
    presentCall: (args) => ({
      card: "terminal",
      title: args.command,
      description: args.description,
      ...(args.workdir === undefined ? {} : { cwd: args.workdir }),
    }),
  }));
}
