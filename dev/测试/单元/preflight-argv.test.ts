import { mkdirSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const WSL_EXECUTABLE = "C:\\Windows\\System32\\wsl.exe";
const DISTRO = process.env.DSH_WSL_DISTRO ?? "Ubuntu";
const DEADLINE_MS = 20_000;
const ARTIFACT_ROOT = resolve(process.cwd(), "测试", "运行产物");
const LOG_PATH = resolve(ARTIFACT_ROOT, "preflight-argv-20261009.json");

// Keep this literal aligned with probeWslRuntime()'s complete static command.
const PROBE_SCRIPT = [
  "command -v /bin/bash >/dev/null && command -v /usr/bin/script >/dev/null && command -v /usr/bin/bwrap >/dev/null && /usr/bin/bwrap --die-with-parent --new-session --unshare-pid --unshare-user --ro-bind / / --tmpfs /run --tmpfs /tmp --unsetenv WSL_INTEROP --unsetenv WSLENV --cap-drop ALL --disable-userns -- /bin/sh -c 'test -z \"${WSL_INTEROP-}\" && test -z \"${WSLENV-}\" && ! /mnt/c/Windows/System32/cmd.exe /d /c exit 0' && /usr/bin/script -qefc 'exit 0' /dev/null",
].join(" ");

const RESTRICTED_ENV_SCRIPT = "test -z \"${WSL_INTEROP-}\" && printf 'WSL_INTEROP_EMPTY\\n'";

interface SpawnRecord {
  argv: string[];
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  reaped: boolean;
  stdout: string;
  stderr: string;
  error?: string;
}

function runWindowsWsl(argv: string[]): Promise<SpawnRecord> {
  return new Promise((resolveResult) => {
    const child = spawn(WSL_EXECUTABLE, argv, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let spawnError: string | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let grace: ReturnType<typeof setTimeout> | undefined;

    const append = (target: "stdout" | "stderr", chunk: Buffer | string) => {
      const text = String(chunk);
      if (target === "stdout") stdout = `${stdout}${text}`.slice(0, 1_048_576);
      else stderr = `${stderr}${text}`.slice(0, 1_048_576);
    };
    const settle = (extra: Omit<SpawnRecord, "argv" | "stdout" | "stderr">) => {
      if (settled) return;
      settled = true;
      if (deadline !== undefined) clearTimeout(deadline);
      if (grace !== undefined) clearTimeout(grace);
      resolveResult({ argv: [...argv], stdout, stderr, ...extra });
    };

    child.stdout?.on("data", (chunk) => append("stdout", chunk));
    child.stderr?.on("data", (chunk) => append("stderr", chunk));
    child.once("error", (error: Error) => {
      spawnError = error.message;
      try {
        child.kill();
      } catch {
        // The close event below remains the authoritative reaping signal.
      }
    });
    child.once("close", (exitCode, signal) => {
      settle({
        exitCode,
        signal,
        timedOut,
        reaped: true,
        ...(spawnError === undefined ? {} : { error: spawnError }),
      });
    });
    deadline = setTimeout(() => {
      timedOut = true;
      try {
        child.kill();
      } catch {
        // The grace timer below still records the bounded failure.
      }
      grace = setTimeout(() => {
        // A kill request is not proof that the child was reaped. Preserve that
        // distinction in the record if Windows never emits the close event.
        settle({
          exitCode: null,
          signal: null,
          timedOut: true,
          reaped: false,
          error: "child did not emit close after kill",
        });
      }, 2_000);
    }, DEADLINE_MS);
    deadline.unref?.();
  });
}

describe("Windows WSL preflight argv comparison", () => {
  it.skipIf(process.platform !== "win32")(
    "records default and --exec argv semantics plus restricted env evidence",
    async () => {
    const commonTail = ["/bin/bash", "--noprofile", "--norc", "-c", PROBE_SCRIPT];
    const direct = await runWindowsWsl(["-d", DISTRO, "--", ...commonTail]);
    const exec = await runWindowsWsl(["-d", DISTRO, "--exec", ...commonTail]);
    const restricted = await runWindowsWsl([
      "-d",
      DISTRO,
      "--exec",
      "/usr/bin/bwrap",
      "--die-with-parent",
      "--new-session",
      "--unshare-pid",
      "--unshare-user",
      "--ro-bind",
      "/",
      "/",
      "--tmpfs",
      "/run",
      "--tmpfs",
      "/tmp",
      "--unsetenv",
      "WSL_INTEROP",
      "--unsetenv",
      "WSLENV",
      "--cap-drop",
      "ALL",
      "--disable-userns",
      "--",
      "/bin/sh",
      "-c",
      RESTRICTED_ENV_SCRIPT,
    ]);

    // Preserve launch diagnostics before asserting, including on CI failures.
    mkdirSync(ARTIFACT_ROOT, { recursive: true });
    writeFileSync(
      LOG_PATH,
      JSON.stringify({ executable: WSL_EXECUTABLE, distro: DISTRO, probeScript: PROBE_SCRIPT, direct, exec, restricted }, null, 2),
      "utf8",
    );

    expect(direct.argv.slice(0, 3)).toEqual(["-d", DISTRO, "--"]);
    expect(exec.argv.slice(0, 3)).toEqual(["-d", DISTRO, "--exec"]);
    expect(direct.argv.slice(3)).toEqual(exec.argv.slice(3));
    expect(direct.timedOut).toBe(false);
    expect(exec.timedOut).toBe(false);
    expect(restricted.timedOut).toBe(false);
    expect(exec.exitCode).toBe(0);
    expect(restricted.exitCode).toBe(0);
    expect(restricted.stdout).toContain("WSL_INTEROP_EMPTY");
    expect(direct.error).toBeUndefined();
    expect(exec.error).toBeUndefined();
    expect(restricted.error).toBeUndefined();
    expect(direct.reaped).toBe(true);
    expect(exec.reaped).toBe(true);
    expect(restricted.reaped).toBe(true);

    },
    3 * (DEADLINE_MS + 2_000) + 5_000,
  );
});
