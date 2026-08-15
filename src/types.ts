import type { SandboxMode as DshSandboxMode } from "@deepseek-ai/dsh-sandbox";

export type SandboxMode = DshSandboxMode;

export interface PluginConfig {
  backendType?: string;
  distro?: string;
  wslExecutable?: string;
  gitBashExecutable?: string;
  shellPath?: string;
  shellArgs?: string[];
  rows?: number;
  cols?: number;
  scrollbackLines?: number;
  scrollbackMaxBytes?: number;
  maxReadBytes?: number;
  pollIntervalMs?: number;
  idleSilenceMs?: number;
  timeoutMs?: number;
  disposeGraceMs?: number;
  oneShotTimeoutMs?: number;
  oneShotMaxOutputBytes?: number;
  oneShotMaxSpillBytes?: number;
}

export interface ResolvedPluginConfig {
  backendType: string;
  distro: string;
  wslExecutable: string;
  gitBashExecutable?: string;
  shellPath: string;
  shellArgs: readonly string[];
  rows: number;
  cols: number;
  scrollbackLines: number;
  scrollbackMaxBytes: number;
  maxReadBytes: number;
  pollIntervalMs: number;
  idleSilenceMs: number;
  timeoutMs: number;
  disposeGraceMs: number;
  oneShotTimeoutMs: number;
  oneShotMaxOutputBytes: number;
  oneShotMaxSpillBytes: number;
}

export interface WslExecutionBoundary {
  mode: SandboxMode;
  /** Immutable host workspace root supplied by ctx.sandboxPolicy. */
  workspaceRoot: string;
  /** Optional command cwd. This never changes the writable bind root. */
  workdir?: string;
}

export interface WslLaunchPlan {
  executable: string;
  args: readonly string[];
  workspaceRootLinux: string;
  workdirLinux: string;
  mode: SandboxMode;
}
