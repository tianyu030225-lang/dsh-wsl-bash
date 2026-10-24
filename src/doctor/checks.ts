import { existsSync } from "node:fs";
import { resolveGitBashPath, type GitBashFs } from "../discovery/git-bash.js";
import {
  DEFAULT_WSL_DISTRO,
  resolveWslDistro,
  resolveWslExecutable,
} from "../discovery/wsl.js";
import { runForeground } from "../tools/process.js";
import { SUPPORTED_DSH_VERSIONS, readDshVersion } from "../runtime.js";
import { cleanWslBashArgv, sanitizedWslHostEnvironment } from "../wsl/bootstrap.js";

export const EXPECTED_DSH_VERSIONS = SUPPORTED_DSH_VERSIONS;
/** @deprecated Use EXPECTED_DSH_VERSIONS for the exact supported host set. */
export const EXPECTED_DSH_VERSION = EXPECTED_DSH_VERSIONS[0];

export type DoctorStatus = "pass" | "fail" | "warn" | "skip";

export interface DoctorCheck {
  id: string;
  status: DoctorStatus;
  detail: string;
  manual?: string;
}

export interface DoctorReport {
  ok: boolean;
  exitCode: 0 | 1;
  checks: DoctorCheck[];
  version: string;
}

export interface DoctorOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  dshVersion?: string;
  /** Explicit host anchor for embedders; standalone discovery is not a live-host assertion. */
  installAnchor?: string;
  wslExecutable?: string;
  distro?: string;
  workspaceRoot?: string;
  gitBashPath?: string;
  /** Read-only filesystem seams for deterministic doctor tests/embedders. */
  pathExists?: (path: string) => boolean;
  gitBashFs?: GitBashFs;
  /** Used by unit tests and embedders to observe probe argv. */
  probe?: (
    executable: string,
    argv: readonly string[],
    timeoutMs: number,
    execution?: ProbeExecutionOptions,
  ) => Promise<ProbeResult>;
  now?: () => Date;
}

export interface ProbeResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  failure?: string;
}

export interface ProbeExecutionOptions {
  env?: NodeJS.ProcessEnv | undefined;
}

const MANUAL = {
  windows: "在 Windows 主机上运行 DSH；Linux/macOS 不提供 Windows 原生 Git Bash/WSL 后端。",
  dsh: "使用兼容版本 DSH 0.2.1-rc.3（Desktop/CLI）；不要忽略版本不兼容检查。",
  wsl: "启用 Windows Subsystem for Linux，并确认 C:\\Windows\\System32\\wsl.exe 可执行。",
  distro: "安装/初始化 WSL2 Ubuntu：wsl --install -d Ubuntu；完成首次用户初始化后重试。",
  bash: "在 Ubuntu 中确认 /bin/bash 可执行。",
  bwrap: "在 Ubuntu 中安装 bubblewrap（例如 apt install bubblewrap），然后重试 doctor。",
  script: "在 Ubuntu 中安装 util-linux/script（例如 apt install util-linux），然后重试 doctor。",
  scriptRuntime: "已找到 util-linux/script，但无法经可信 /bin/bash 启动；检查发行版环境和 SHELL 配置。",
  realpath: "在 Ubuntu 中确认 coreutils/realpath 可执行，然后重试 doctor。",
  mapping: "确认 Windows workspace 位于本地磁盘且 wslpath 能映射；不要使用 UNC/device namespace。",
  git: "安装 Git for Windows，或通过 profile YAML / DSH_GIT_BASH_PATH 指向本地 Git\\bin\\bash.exe。",
} as const;

export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorReport> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const checks: DoctorCheck[] = [];
  const version = options.dshVersion ?? detectDshVersion(options.installAnchor);

  if (platform === "win32") checks.push(pass("windows", "Windows host detected"));
  else checks.push(fail("windows", `unsupported host platform: ${platform}`, MANUAL.windows));

  if ((EXPECTED_DSH_VERSIONS as readonly string[]).includes(version)) checks.push(pass("dsh-version", `DSH ${version}`));
  else checks.push(fail("dsh-version", `expected DSH ${EXPECTED_DSH_VERSIONS.join(" or ")}, found ${version || "unknown"}`, MANUAL.dsh));

  let wslPath: string | undefined;
  let distro = DEFAULT_WSL_DISTRO;
  if (platform === "win32") {
    try {
      wslPath = resolveWslExecutable({ executable: options.wslExecutable, env, platform });
      if ((options.pathExists ?? existsSync)(wslPath)) checks.push(pass("wsl-exe", wslPath));
      else {
        checks.push(fail("wsl-exe", `wsl.exe not found at ${wslPath}`, MANUAL.wsl));
        wslPath = undefined;
      }
    } catch (error) {
      checks.push(fail("wsl-exe", errorMessage(error), MANUAL.wsl));
    }
    try {
      distro = resolveWslDistro({ distro: options.distro, env });
    } catch (error) {
      checks.push(fail("wsl-distro-name", errorMessage(error), MANUAL.distro));
    }
  } else {
    checks.push(skip("wsl-exe", "not checked on a non-Windows host"));
    checks.push(skip("wsl-distro", "not checked on a non-Windows host"));
  }

  const probe = options.probe ?? defaultProbe;
  if (wslPath !== undefined) {
    const wslEnvironment = sanitizedWslHostEnvironment(env, { WSL_UTF8: "1" });
    const list = await safeProbe(probe, wslPath, ["-l", "-q"], 20_000, { env: wslEnvironment });
    const distros = stripProbeNuls(list.stdout)
      .split(/[\r\n]+/)
      .map((line) => line.trim())
      .filter(Boolean);
    const listed = !list.failure && list.exitCode === 0 &&
      distros.some((name) => name.toLowerCase() === distro.toLowerCase());
    const kernel = await safeProbe(
      probe,
      wslPath,
      ["-d", distro, "--exec", "/bin/uname", "-r"],
      20_000,
      { env: wslEnvironment },
    );
    if (!kernel.failure && kernel.exitCode === 0 && /wsl2/i.test(stripProbeNuls(kernel.stdout))) {
      checks.push(pass("wsl2", listed
        ? `${distro} listed by WSL and started successfully`
        : `${distro} started successfully; redirected distro listing was unavailable or did not match`));
      checks.push(pass("wsl2-kernel", stripProbeNuls(kernel.stdout).trim()));
    } else {
      const listDetail = list.failure ? `; list probe failed: ${list.failure}`
        : list.exitCode !== 0 ? `; list probe exited ${list.exitCode}`
          : listed ? "" : `; ${distro} was not found in the decoded distro list`;
      checks.push(fail("wsl2", `selected distro could not start${listDetail}`, MANUAL.distro));
      checks.push(fail("wsl2-kernel", `Ubuntu does not report a WSL2 kernel${kernel.failure ? `: ${kernel.failure}` : ""}`, MANUAL.distro));
    }

    const bash = await safeProbe(
      probe,
      wslPath,
      ["-d", distro, "--exec", ...cleanWslBashArgv("test -x /bin/bash")],
      20_000,
      { env: wslEnvironment },
    );
    addProbeCheck(checks, "wsl-bash", bash, MANUAL.bash, "WSL /bin/bash functional");

    const bwrap = await safeProbe(probe, wslPath, [
      "-d", distro, "--exec", "/usr/bin/bwrap",
     "--die-with-parent", "--new-session", "--unshare-pid",
      "--unshare-user",
     "--ro-bind", "/", "/",
      "--tmpfs", "/run", "--tmpfs", "/tmp",
      "--unsetenv", "WSL_INTEROP", "--unsetenv", "WSLENV",
      "--cap-drop", "ALL", "--disable-userns",
      "--", "/bin/sh", "-c",
      "test -z \"${WSL_INTEROP-}\" && test -z \"${WSLENV-}\" && ! /mnt/c/Windows/System32/cmd.exe /d /c exit 0",
    ], 20_000, { env: wslEnvironment });
    addProbeCheck(checks, "bwrap", bwrap, MANUAL.bwrap, "bubblewrap functional with WSL interop disabled (network namespace unchanged)");

    const scriptPresent = await safeProbe(
      probe,
      wslPath,
      ["-d", distro, "--exec", "/usr/bin/test", "-x", "/usr/bin/script"],
      20_000,
      { env: wslEnvironment },
    );
    if (scriptPresent.failure || scriptPresent.exitCode !== 0) {
      addProbeCheck(checks, "script", scriptPresent, MANUAL.script, "util-linux/script installed");
    } else {
      const script = await safeProbe(
        probe,
        wslPath,
        ["-d", distro, "--exec", ...cleanWslBashArgv("SHELL=/bin/bash exec /usr/bin/script -qefc 'exit 0' /dev/null")],
        20_000,
        { env: wslEnvironment },
      );
      addProbeCheck(checks, "script", script, MANUAL.scriptRuntime, "script functional through trusted Bash");
    }

    const realpath = await safeProbe(
      probe,
      wslPath,
      ["-d", distro, "--exec", "/usr/bin/realpath", "-e", "/"],
      20_000,
      { env: wslEnvironment },
    );
    addProbeCheck(checks, "realpath", realpath, MANUAL.realpath, "realpath functional");

    const workspace = options.workspaceRoot ?? process.cwd();
    // Use the equivalent slash form accepted by wslpath, with direct exec so
    // WSL's default shell cannot reinterpret the mapping argument.
    const mappingInput = workspace.replaceAll("\\", "/");
    const mapping = await safeProbe(
      probe,
      wslPath,
      ["-d", distro, "--exec", "/usr/bin/wslpath", "-a", "-u", mappingInput],
      20_000,
      { env: wslEnvironment },
    );
    if (mapping.failure || mapping.exitCode !== 0 || !stripProbeNuls(mapping.stdout).trim().startsWith("/")) {
      checks.push(fail("path-mapping", `Windows↔WSL mapping failed${mapping.failure ? `: ${mapping.failure}` : ""}`, MANUAL.mapping));
    } else checks.push(pass("path-mapping", `${workspace} -> ${stripProbeNuls(mapping.stdout).trim()}`));
  } else {
    checks.push(skip("wsl2", "wsl.exe unavailable"));
    checks.push(skip("wsl2-kernel", "wsl.exe unavailable"));
    checks.push(skip("wsl-bash", "wsl.exe unavailable"));
    checks.push(skip("bwrap", "wsl.exe unavailable"));
    checks.push(skip("script", "wsl.exe unavailable"));
    checks.push(skip("realpath", "wsl.exe unavailable"));
    checks.push(skip("path-mapping", "wsl.exe unavailable"));
  }

  if (platform === "win32") {
    try {
      const git = resolveGitBashPath(options.gitBashPath, {
        env,
        platform,
        fsImpl: options.gitBashFs,
      });
      const result = await safeProbe(probe, git, ["--noprofile", "--norc", "-c", "test -x /usr/bin/env"], 20_000);
      addProbeCheck(checks, "git-bash", result, MANUAL.git, `${git} functional`);
    } catch (error) {
      checks.push(fail("git-bash", errorMessage(error), MANUAL.git));
    }
  } else {
    checks.push(skip("git-bash", "not checked on a non-Windows host"));
  }

  const ok = checks.every((check) => check.status !== "fail");
  return { ok, exitCode: ok ? 0 : 1, checks, version };
}

export function formatDoctorText(report: DoctorReport): string {
  const lines = [`dsh-bash-wsl doctor: ${report.ok ? "PASS" : "FAIL"}`];
  for (const check of report.checks) {
    lines.push(`${check.status.toUpperCase().padEnd(4)} ${check.id}: ${check.detail}`);
    if (check.status === "fail" && check.manual) lines.push(`      manual: ${check.manual}`);
  }
  return lines.join("\n");
}

export function formatDoctorJson(report: DoctorReport): string {
  return JSON.stringify(report, null, 2);
}

function addProbeCheck(checks: DoctorCheck[], id: string, result: ProbeResult, manual: string, passDetail: string): void {
  if (!result.failure && result.exitCode === 0) checks.push(pass(id, passDetail));
  else checks.push(fail(id, `${result.failure ? `probe failed: ${result.failure}` : `exit ${result.exitCode}`}${result.stderr.trim() ? ` (${result.stderr.trim()})` : ""}`, manual));
}

async function defaultProbe(
  executable: string,
  argv: readonly string[],
  timeoutMs: number,
  execution: ProbeExecutionOptions = {},
): Promise<ProbeResult> {
  const result = await runForeground({
    executable,
    argv,
    timeoutMs,
    memoryLimit: 64 * 1024,
    spillLimit: 64 * 1024,
    ...(execution.env === undefined ? {} : { env: execution.env }),
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.text,
    stderr: result.stderr.text,
    ...(result.failure ? { failure: result.failure.message } : {}),
  };
}

async function safeProbe(
  probe: NonNullable<DoctorOptions["probe"]>,
  executable: string,
  argv: readonly string[],
  timeoutMs: number,
  execution?: ProbeExecutionOptions,
): Promise<ProbeResult> {
  try {
    return execution === undefined
      ? await probe(executable, argv, timeoutMs)
      : await probe(executable, argv, timeoutMs, execution);
  } catch (error) {
    return {
      exitCode: null,
      stdout: "",
      stderr: "",
      failure: errorMessage(error),
    };
  }
}

function detectDshVersion(installAnchor?: string): string {
  const envValue = installAnchor === undefined ? process.env.DSH_VERSION?.trim() : undefined;
  if (envValue) return envValue;
  try {
    return readDshVersion(installAnchor);
  } catch {
    return "";
  }
}

function pass(id: string, detail: string): DoctorCheck { return { id, status: "pass", detail }; }
function fail(id: string, detail: string, manual: string): DoctorCheck { return { id, status: "fail", detail, manual }; }
function skip(id: string, detail: string): DoctorCheck { return { id, status: "skip", detail }; }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }

function stripProbeNuls(value: string): string {
  return value.replaceAll("\0", "").replace(/^\uFEFF/, "");
}
