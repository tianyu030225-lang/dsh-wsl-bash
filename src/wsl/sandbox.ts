import { posix } from "node:path";

import type { SandboxMode } from "../types.js";

export interface BwrapRequest {
  mode: SandboxMode;
  workspaceRootLinux: string;
  workdirLinux: string;
  command: string;
  args: readonly string[];
}

function assertAbsoluteLinuxPath(name: string, path: string): void {
  if (!path.startsWith("/") || path.includes("\0")) {
    throw new Error(`dsh-plugin-bash-wsl: ${name} must be an absolute NUL-free Linux path`);
  }
}

function canonicalLinuxPath(name: string, path: string): string {
  assertAbsoluteLinuxPath(name, path);
  const normalized = posix.normalize(path);
  if (!normalized.startsWith("/")) {
    throw new Error(`dsh-plugin-bash-wsl: ${name} must remain absolute`);
  }
  return normalized;
}

function isInsideLinuxRoot(root: string, candidate: string): boolean {
  const normalizedRoot = root.replace(/\/+$/, "") || "/";
  return candidate === normalizedRoot || candidate.startsWith(`${normalizedRoot}/`);
}

function assertNarrowWorkspaceRoot(path: string): void {
  const normalized = path.replace(/\/+$/, "") || "/";
  if (["/", "/mnt", "/mnt/c", "/tmp"].includes(normalized)) {
    throw new Error(`dsh-plugin-bash-wsl: Linux workspace root is too broad: ${JSON.stringify(path)}`);
  }
}

/** Build bubblewrap argv only; the caller supplies `/usr/bin/bwrap` as argv[0]. */
export function buildBwrapArgs(request: BwrapRequest): readonly string[] {
  if (!['read-only', 'workspace-write', 'danger-full-access'].includes(request.mode)) {
    throw new Error(`dsh-plugin-bash-wsl: unsupported sandbox mode: ${JSON.stringify(request.mode)}`);
  }
  const workspaceRootLinux = canonicalLinuxPath("workspaceRootLinux", request.workspaceRootLinux);
  const workdirLinux = canonicalLinuxPath("workdirLinux", request.workdirLinux);
  const command = canonicalLinuxPath("command", request.command);
  if (request.args.some((arg) => arg.includes("\0"))) {
    throw new Error("dsh-plugin-bash-wsl: command arguments must not contain NUL bytes");
  }
  assertNarrowWorkspaceRoot(workspaceRootLinux);
  if (!isInsideLinuxRoot(workspaceRootLinux, workdirLinux)) {
    throw new Error("dsh-plugin-bash-wsl: Linux workdir escaped the canonical workspace root");
  }

  const args: string[] = [
    "--die-with-parent",
    "--new-session",
    "--unshare-pid",
  ];

 if (request.mode === "danger-full-access") {
   args.push("--bind", "/", "/");
 } else {
   args.push("--ro-bind", "/", "/");
    // WSL exposes a host-side Windows interop broker through WSL_INTEROP
    // (and WSLENV can reintroduce translated variables). Isolate the
    // broker mount and environment in both restricted modes; danger-full
    // access is the explicit opt-in that retains host interop.
    args.push(
      "--tmpfs", "/run",
      "--tmpfs", "/tmp",
     "--unsetenv", "WSL_INTEROP",
     "--unsetenv", "WSLENV",
     "--cap-drop", "ALL",
      "--unshare-user",
     "--disable-userns",
   );
 }
  args.push("--dev", "/dev", "--proc", "/proc");

 if (request.mode === "workspace-write") {
   args.push(
     "--bind", workspaceRootLinux, workspaceRootLinux,
   );
  }

  args.push(
    "--chdir", workdirLinux,
    "--",
    command,
    ...request.args,
  );
  return args;
}
