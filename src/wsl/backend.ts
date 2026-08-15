import { TerminalBackendCleanupError } from "@deepseek-ai/dsh-terminal";
import type { Context } from "@deepseek-ai/cordis";
import { effectiveSandboxMode } from "@deepseek-ai/dsh-sandbox-policy";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type {
  SubprocessHandle,
  SubprocessSpawnSpec,
} from "@deepseek-ai/dsh-subprocess";
import type {
  TerminalBackend,
  TerminalBackendSession,
  TerminalBackendSpawnSpec,
} from "@deepseek-ai/dsh-terminal";

import type { ResolvedPluginConfig } from "../types.js";
import { resolveWslExecutable } from "../discovery/wsl.js";
import {
  createWslPtyTransport,
  WslPtySession,
} from "../terminal/session.js";
import {
  buildWslLaunchPlan,
  resolveHostBoundary,
  type WslPathCanonicalizer,
} from "./launcher.js";
import { buildBwrapArgs } from "./sandbox.js";
import { runSubprocessForeground } from "../tools/process.js";

type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";
interface SandboxPolicyLike { mode: SandboxMode; workspaceRoot: string; }
interface OwnerFenceState {
  terminals: Context["terminals"];
  sandboxPolicy: { readonly defaultMode?: SandboxMode };
}
const sandboxModeFences = new WeakMap<object, OwnerFenceState>();

function ensureSandboxModeFence(ctx: Context, owner: Agent): void {
  const key = owner as unknown as object;
  const existing = sandboxModeFences.get(key);
  if (existing !== undefined) {
    existing.terminals = ctx.terminals;
    existing.sandboxPolicy = ctx.sandboxPolicy;
    return;
  }
  const state: OwnerFenceState = {
    terminals: ctx.terminals,
    sandboxPolicy: ctx.sandboxPolicy,
  };
  sandboxModeFences.set(key, state);
  // Structural test owners may not expose Cordis' event listener. Real rc.6
  // Agents always do, so this preserves the production fence without making
  // the backend impossible to inject in unit tests.
  if (typeof owner.ctx?.on !== "function") return;
  owner.ctx.on("internal/dispatch", (_mode, eventName, args) => {
    if (eventName !== "session/event") return;
    const [session, event] = args as [
      { events: readonly unknown[] } | undefined,
      { type?: string; data?: { mode?: SandboxMode } } | undefined,
    ];
    if (session !== owner.session || event?.type !== "sandbox/mode") return;
    const current = effectiveSandboxMode(session.events as never) ?? state.sandboxPolicy.defaultMode;
    const next = event.data?.mode;
    if (next === undefined || next === current || !state.terminals.hasOwnerActivity(owner)) return;
    throw new Error(
      `cannot change sandbox mode from "${current}" to "${next}" while persistent terminal sessions are open or being created; wait for creation to settle and close them first`,
    );
  }, { global: true });
}

function quotePosix(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

// Keep the prompt marker alive even if a model command changes PS1. PROMPT_COMMAND
// itself is made readonly during session initialization so later sends cannot
// silently remove the readiness signal.
const CONTROLLED_PROMPT_COMMAND =
  '__dsh_status=$?; PS1="__DSH_PERSISTENT_BASH_PROMPT__ "; printf "\\033]133;D;%s\\007" "$__dsh_status"';
const CONTROLLED_PROMPT = "__DSH_PERSISTENT_BASH_PROMPT__ ";

function shellCommand(config: ResolvedPluginConfig): string {
  // util-linux `script -c` evaluates its command through /bin/sh; that
  // intermediary may reset Bash's special PS1 variable even when bwrap's
  // environment is correct. Put the controlled terminal environment in the
  // direct argv command as well, so the final Bash process receives it.
  // `script` also inherits no window size from a pipe, so the PTY it allocates
  // defaults to 0x0; set the configured rows/cols before exec so pagers and
  // width-detecting TUI commands see a real geometry.
  const envChain = [
    "/usr/bin/env",
    "TERM=dumb",
    "PAGER=cat",
    "GIT_PAGER=cat",
    `PS1=${CONTROLLED_PROMPT}`,
    `PROMPT_COMMAND=${CONTROLLED_PROMPT_COMMAND}`,
    "BASH_SILENCE_DEPRECATION_WARNING=1",
    "DSH_SHELL=1",
    config.shellPath,
    ...config.shellArgs,
  ].map(quotePosix).join(" ");
  // The stty prefix is shell control text evaluated by script's /bin/sh, not
  // an argv element, so it stays unquoted; only the env chain is quoted.
  return `/usr/bin/stty rows ${config.rows} cols ${config.cols} && exec ${envChain}`;
}

function exposeBwrapEnvironment(
  runnerArgs: readonly string[],
  config: ResolvedPluginConfig,
  environment: Readonly<Record<string, string>>,
): readonly string[] {
  const separator = runnerArgs.indexOf("--");
  if (separator < 0) return runnerArgs;
  const metadata: string[] = [];
  for (const [key, value] of Object.entries(environment)) {
    metadata.push("--setenv", key, value);
  }
  metadata.push("--setenv", "DSH_SHELL_PATH", config.shellPath);
  config.shellArgs.forEach((arg, index) => {
    metadata.push("--setenv", `DSH_SHELL_ARG_${index}`, arg);
  });
  return [...runnerArgs.slice(0, separator), ...metadata, ...runnerArgs.slice(separator)];
}

function childEnvironment(spec: TerminalBackendSpawnSpec): Record<string, string> {
  const environment = {
    TERM: "dumb",
    PAGER: "cat",
    GIT_PAGER: "cat",
    PS1: CONTROLLED_PROMPT,
    PROMPT_COMMAND: CONTROLLED_PROMPT_COMMAND,
    BASH_SILENCE_DEPRECATION_WARNING: "1",
    DSH_SHELL: "1",
    DSH_SESSION_ID: String(spec.owner.id),
    DSH_PTY_SESSION_ID: String(spec.sessionId),
  };
  for (const [key, value] of Object.entries(environment)) {
    if (key.includes("\0") || value.includes("\0")) {
      throw new Error("dsh-plugin-bash-wsl: terminal environment must not contain NUL bytes");
    }
  }
  return environment;
}

async function canonicalizePathInsideWsl(
  subprocess: NonNullable<Context["subprocess"]>,
  config: ResolvedPluginConfig,
  boundary: { readonly workdir: string },
  linuxPath: string,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  const result = await runSubprocessForeground({
    executable: config.wslExecutable,
    argv: [
      "-d",
      config.distro,
      "--exec",
      "/usr/bin/realpath",
      "--canonicalize-existing",
      linuxPath,
    ],
    cwd: process.platform === "win32" ? boundary.workdir : "/",
    timeoutMs: 20_000,
    signal,
    memoryLimit: 16 * 1024,
    spillLimit: 16 * 1024,
    subprocess,
  });
  if (result.failure !== undefined || result.exitCode !== 0 || result.signal !== null) {
    const detail = result.stderr.text.trim();
    throw new Error(
      `dsh-plugin-bash-wsl: WSL realpath failed for ${JSON.stringify(linuxPath)}${detail.length > 0 ? `: ${detail}` : ""}`,
    );
  }
  if (result.stdout.truncated || result.stderr.truncated) {
    throw new Error("dsh-plugin-bash-wsl: WSL realpath output exceeded the 16KiB safety bound");
  }
  const canonical = result.stdout.text.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  const withoutTrailingNewline = canonical.endsWith("\n")
    ? canonical.slice(0, -1)
    : canonical;
  if (withoutTrailingNewline.length === 0 || withoutTrailingNewline.includes("\n")) {
    throw new Error("dsh-plugin-bash-wsl: WSL realpath returned an invalid path");
  }
  return withoutTrailingNewline;
}

async function initializeSession(session: WslPtySession, signal?: AbortSignal): Promise<void> {
  if (signal === undefined) {
    await session.initialize();
    return;
  }
  signal.throwIfAborted();
  let rejectAbort: ((reason?: unknown) => void) | undefined;
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const onAbort = (): void => rejectAbort?.(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    await Promise.race([session.initialize(signal), aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

/** Persistent WSL PTY backend over the official rc.6 terminal registry. */
export class WslTerminalBackend implements TerminalBackend {
  public readonly type: string;

  public constructor(
    private readonly ctx: Context,
    private readonly config: ResolvedPluginConfig,
  ) {
    this.type = config.backendType;
  }

  public async spawn(spec: TerminalBackendSpawnSpec): Promise<TerminalBackendSession> {
    spec.signal?.throwIfAborted();
    const executionConfig = process.platform === "win32"
      ? {
          ...this.config,
          wslExecutable: resolveWslExecutable({
            executable: this.config.wslExecutable,
            env: process.env,
            platform: "win32",
          }),
        }
      : this.config;
    if (!executionConfig.shellPath.startsWith("/") || executionConfig.shellPath.includes("\0")) {
      throw new Error("dsh-plugin-bash-wsl: shellPath must be an absolute NUL-free Linux path");
    }
    if (executionConfig.shellArgs.some((arg) => arg.includes("\0"))) {
      throw new Error("dsh-plugin-bash-wsl: shellArgs must not contain NUL bytes");
    }
    ensureSandboxModeFence(this.ctx, spec.owner);
    const policyService = this.ctx.sandboxPolicy;
    if (policyService === undefined || typeof policyService.resolve !== "function") {
      throw new Error("dsh-plugin-bash-wsl: sandboxPolicy service is required");
    }
    const policy = policyService.resolve({ session: spec.owner.session }) as SandboxPolicyLike;
    if (typeof policy.workspaceRoot !== "string" || policy.workspaceRoot.length === 0) {
      throw new Error("dsh-plugin-bash-wsl: sandboxPolicy.workspaceRoot is required");
    }
    const boundary = resolveHostBoundary({
      mode: policy.mode,
      workspaceRoot: policy.workspaceRoot,
      ...(spec.cwd === undefined ? {} : { workdir: spec.cwd }),
    });
    const subprocess = this.ctx.subprocess;
    if (subprocess === undefined || typeof subprocess.spawn !== "function") {
      throw new Error("dsh-plugin-bash-wsl: subprocess.spawn service is required");
    }
    const canonicalize: WslPathCanonicalizer | undefined = process.platform === "win32"
      ? (linuxPath, signal) => canonicalizePathInsideWsl(
        subprocess,
        executionConfig,
        boundary,
        linuxPath,
        signal,
      )
      : undefined;
    const plan = await buildWslLaunchPlan(executionConfig, {
      mode: policy.mode,
      workspaceRoot: boundary.workspaceRoot,
      workdir: boundary.workdir,
    }, spec.signal, canonicalize);
    const environment = childEnvironment(spec);
    const runnerArgs = buildBwrapArgs({
      mode: policy.mode,
      workspaceRootLinux: plan.workspaceRootLinux,
      workdirLinux: plan.workdirLinux,
      command: "/usr/bin/script",
      args: ["-qefc", shellCommand(executionConfig), "/dev/null"],
    });
    const processSpec: SubprocessSpawnSpec = {
      argv: [
        plan.executable,
        ...plan.args,
        "/usr/bin/bwrap",
        ...exposeBwrapEnvironment(runnerArgs, executionConfig, environment),
      ],
      cwd: process.platform === "win32" ? boundary.workdir : plan.workdirLinux,
      stdio: {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      },
      graceMs: executionConfig.disposeGraceMs,
      ...(spec.signal === undefined ? {} : { signal: spec.signal }),
      env: environment,
    };
    let handle: SubprocessHandle;
    try {
      handle = subprocess.spawn(processSpec);
    } catch (error) {
      throw error;
    }
    let session: WslPtySession | undefined;
    try {
      session = new WslPtySession(createWslPtyTransport(handle), executionConfig);
      await initializeSession(session, spec.signal);
      return session;
    } catch (error) {
      try {
        if (session !== undefined) {
          await session.close("WSL PTY startup failed");
        } else {
          handle.terminate();
          const exited = await handle.waitForExit();
          if (!exited) throw new Error("WSL PTY subprocess exit wait was aborted");
          await handle.done;
        }
      } catch (closeError) {
        throw new TerminalBackendCleanupError(error, closeError);
      }
      throw error;
    }
  }
}

export function registerWslTerminalBackend(ctx: Context, config: ResolvedPluginConfig): void {
  const backend = new WslTerminalBackend(ctx, config);
  ctx.terminals.registerBackend(backend);
}
