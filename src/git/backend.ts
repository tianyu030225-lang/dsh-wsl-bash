import type { Context } from "@deepseek-ai/cordis";
import { realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { win32 } from "node:path";
import { pathToFileURL } from "node:url";
import type { BashTerminalBackend } from "@deepseek-ai/dsh-terminal-bash";
import type {
  TerminalBackend,
  TerminalBackendSession,
  TerminalBackendSpawnSpec,
} from "@deepseek-ai/dsh-terminal";
import type {} from "@deepseek-ai/dsh-sandbox-policy";

import { rejectUnsafeWindowsPath, resolveGitBashPath } from "../discovery/git-bash.js";
import { createDshHostRequire } from "../runtime.js";
import { spawnGitBashPty } from "./pty.js";
import { WslPtySession, type TerminalProtocolEmulator } from "../terminal/session.js";
import type { ResolvedPluginConfig } from "../types.js";

/** Native Git for Windows PTY; no implicit escalation or PowerShell/WSL wrapper. */
export class GitBashTerminalBackend implements TerminalBackend {
  readonly type: string;

  constructor(private readonly ctx: Context, private readonly config: ResolvedPluginConfig) {
    this.type = config.backendType;
  }

  private requireFullAccess(spec: TerminalBackendSpawnSpec): string {
    const policy = this.ctx.sandboxPolicy.resolve({ session: spec.owner.session });
    if (policy.mode !== "danger-full-access") {
      throw new Error(
        "Persistent Git Bash requires this session's explicit danger-full-access permission; " +
        "selecting Git Bash mode does not change permissions. No Git Bash process was started.",
      );
    }
    return policy.workspaceRoot;
  }

  async spawn(spec: TerminalBackendSpawnSpec): Promise<TerminalBackendSession> {
    spec.signal?.throwIfAborted();
    // Check authority before executable discovery or loading the native PTY runtime.
    const workspaceRoot = this.requireFullAccess(spec);
    rejectUnsafeWindowsPath(workspaceRoot);
    if (!/^[A-Za-z]:[\\/]/.test(workspaceRoot)) {
      throw new Error("Git Bash workspace must be an absolute local Windows path");
    }
    const canonicalRoot = realpathSync.native(workspaceRoot).replace(/^\\\\\?\\(?=[A-Za-z]:\\)/, "");
    rejectUnsafeWindowsPath(canonicalRoot);
    if (win32.normalize(canonicalRoot) === win32.parse(canonicalRoot).root || !statSync(canonicalRoot).isDirectory()) {
      throw new Error("Git Bash workspace must be an existing directory, not a drive root");
    }
    if (spec.cwd !== undefined) {
      if (spec.cwd.includes("\0") || /^[A-Za-z]:(?:$|[^\\/])|^(?:\\\\|\/\/|\\[?.])/.test(spec.cwd)) {
        throw new Error("Git Bash cwd must not contain NUL or use drive-relative, UNC, or device paths");
      }
    }
    const requestedCwd = win32.resolve(canonicalRoot, spec.cwd ?? ".");
    rejectUnsafeWindowsPath(requestedCwd);
    // Strip only the local-drive extended spelling produced by Windows realpath.
    const cwd = realpathSync.native(requestedCwd).replace(/^\\\\\?\\(?=[A-Za-z]:\\)/, "");
    rejectUnsafeWindowsPath(cwd);
    if (!statSync(cwd).isDirectory()) throw new Error("Git Bash cwd must be an existing directory");
    const shellPath = resolveGitBashPath(this.config.gitBashExecutable);
    const hostRequire = createDshHostRequire(this.ctx.profileContext.installAnchor);
    const runtime = await import(pathToFileURL(hostRequire.resolve("@deepseek-ai/dsh-terminal-bash")).href) as {
      BashTerminalBackend: typeof BashTerminalBackend;
    };
    spec.signal?.throwIfAborted();
    // A permission change while importing cannot turn a full-access spawn into a
    // confined argv retry. The official backend installs its own live/pending fence.
    this.requireFullAccess(spec);
    // Resolve the emulator exactly as the installed official backend does;
    // never substitute the plugin's dependencies for native host capabilities.
    const terminalRequire = createRequire(hostRequire.resolve("@deepseek-ai/dsh-terminal-bash"));
    const { Terminal: HeadlessTerminal } = terminalRequire("@xterm/headless") as {
      Terminal: new (options: { rows: number; cols: number; scrollback: number }) => TerminalProtocolEmulator;
    };
    if (typeof HeadlessTerminal !== "function") throw new Error("Git Bash host terminal emulator is unavailable");
    const backend = new runtime.BashTerminalBackend(this.ctx, {
      backendType: this.type,
      shellDialect: "bash",
      shellPath,
      shellArgs: ["--noprofile", "--norc", "-i"],
      rows: this.config.rows,
      cols: this.config.cols,
      scrollbackLines: this.config.scrollbackLines,
      scrollbackMaxBytes: this.config.scrollbackMaxBytes,
      maxReadBytes: this.config.maxReadBytes,
      pollIntervalMs: this.config.pollIntervalMs,
      exactProbeAfterMs: 150,
      idleSilenceMs: this.config.idleSilenceMs,
      handoffGraceMs: Math.max(500, this.config.pollIntervalMs),
      promptTailGraceMs: 0,
      timeoutMs: this.config.timeoutMs,
      disposeGraceMs: this.config.disposeGraceMs,
    }, (request) => {
      this.requireFullAccess(spec);
      return spawnGitBashPty(this.ctx, {
        ...request,
        env: {
          ...request.env,
          PS1: "",
          // ConPTY forwards OSC before repainting earlier ordinary output.
          // Carry the complete prompt identity inside the OSC as well as in
          // visible text, retaining the actual previous shell status.
          PROMPT_COMMAND: '__dsh_status=$?; PS1=""; printf "\\033]133;D;%s;__DSH_PERSISTENT_BASH_PROMPT__\\007__DSH_PERSISTENT_BASH_PROMPT__" "$__dsh_status"',
        },
      }, () => { this.requireFullAccess(spec); });
    }, (terminal) => {
      const session = new WslPtySession(terminal, this.config, {
        emulator: new HeadlessTerminal({ rows: this.config.rows, cols: this.config.cols, scrollback: 0 }),
        // ConPTY replaces a trailing blank with CSI cursor motion. End the
        // native sentinel in visible text; the WSL pipe contract is unchanged.
        promptText: "__DSH_PERSISTENT_BASH_PROMPT__",
        promptControlText: "__DSH_PERSISTENT_BASH_PROMPT__",
        protectPrompt: false,
        inferIdle: false,
      });
      // The public factory's .d.ts unnecessarily names its concrete private
      // class. Both supported hosts consume only TerminalBackendSession plus
      // initialize(), as verified in their installed startupSession().
      return session as unknown as ReturnType<NonNullable<ConstructorParameters<typeof BashTerminalBackend>[3]>>;
    });
    return backend.spawn({ ...spec, cwd });
  }
}

export function registerGitBashTerminalBackend(ctx: Context, config: ResolvedPluginConfig): void {
  ctx.terminals.registerBackend(new GitBashTerminalBackend(ctx, config));
}
