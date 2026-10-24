import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  runDoctor,
  type DoctorOptions,
  type ProbeResult,
} from "../../../src/doctor/checks.js";
import type { GitBashFs } from "../../../src/discovery/git-bash.js";

const artifactRoot = resolve(process.cwd(), "测试", "运行产物");
const temporaryRoots: string[] = [];
const workspaceRoot = "C:\\Users\\Alice\\work\\dsh 插件 测试";
const gitBashPath = "C:\\Program Files\\Git\\bin\\bash.exe";

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function hostAnchor(version: string, name = "@deepseek-ai/dsh"): string {
  mkdirSync(artifactRoot, { recursive: true });
  const root = mkdtempSync(join(artifactRoot, "doctor-host-"));
  temporaryRoots.push(root);
  const anchor = join(root, "node_modules", "@deepseek-ai", "dsh", "package.json");
  mkdirSync(dirname(anchor), { recursive: true });
  writeFileSync(anchor, JSON.stringify({ name, version }), "utf8");
  return anchor;
}

function gitBashFs(): GitBashFs {
  const realpathSync = Object.assign(
    vi.fn((value: string) => value),
    { native: vi.fn((value: string) => value) },
  );
  return Object.freeze({
    statSync: vi.fn(() => ({ isFile: () => true })),
    accessSync: vi.fn(),
    realpathSync,
  }) as unknown as GitBashFs;
}

function passingProbe(): NonNullable<DoctorOptions["probe"]> {
  return vi.fn(async (_executable: string, argv: readonly string[]): Promise<ProbeResult> => {
    if (argv[0] === "-l") {
      return {
        exitCode: 0,
        stdout: Buffer.from("Ubuntu\r\n", "utf16le").toString("utf8"),
        stderr: "",
      };
    }
    if (argv.includes("/bin/uname")) {
      return { exitCode: 0, stdout: "Linux 6.1 WSL2", stderr: "" };
    }
    if (argv.includes("/usr/bin/wslpath")) {
      return { exitCode: 0, stdout: "/mnt/c/Users/Alice/work/dsh 插件 测试\r\n", stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  });
}

function doctorOptions(overrides: Partial<DoctorOptions> = {}): DoctorOptions {
  return {
    platform: "win32",
    wslExecutable: "C:\\Windows\\System32\\wsl.exe",
    distro: "Ubuntu",
    workspaceRoot,
    gitBashPath,
    pathExists: vi.fn(() => true),
    gitBashFs: gitBashFs(),
    probe: passingProbe(),
    ...overrides,
  };
}

function check(report: Awaited<ReturnType<typeof runDoctor>>, id: string) {
  return report.checks.find((item) => item.id === id);
}

describe("doctor host identity and read-only contract", () => {
  it.each(["0.2.1-rc.3"])(
    "reports supported host version %s as an overall pass",
    async (version) => {
      const report = await runDoctor(doctorOptions({ dshVersion: version }));

      expect(report.version).toBe(version);
      expect(report.ok).toBe(true);
      expect(report.exitCode).toBe(0);
      expect(check(report, "dsh-version")).toMatchObject({ status: "pass" });
    },
  );

  it("rejects the legacy rc.6 host in the overall report", async () => {
    const report = await runDoctor(doctorOptions({ dshVersion: "0.1.0-rc.6" }));

    expect(report.version).toBe("0.1.0-rc.6");
    expect(report.ok).toBe(false);
    expect(report.exitCode).toBe(1);
    expect(check(report, "dsh-version")).toMatchObject({ status: "fail" });
  });

  it("uses an explicit host anchor instead of an environment shadow version", async () => {
    const anchor = hostAnchor("0.2.1-rc.3");
    vi.stubEnv("DSH_VERSION", "0.1.0-rc.6");

    const report = await runDoctor(doctorOptions({ installAnchor: anchor }));

    expect(report.version).toBe("0.2.1-rc.3");
    expect(check(report, "dsh-version")).toMatchObject({ status: "pass" });
    expect(report.ok).toBe(true);
  });

  it("turns an invalid explicit anchor into a version failure instead of using env", async () => {
    vi.stubEnv("DSH_VERSION", "0.2.1-rc.3");
    const invalidAnchor = resolve(artifactRoot, "missing-doctor-anchor", "package.json");

    const report = await runDoctor(doctorOptions({ installAnchor: invalidAnchor }));

    expect(report.version).toBe("");
    expect(check(report, "dsh-version")).toMatchObject({ status: "fail" });
    expect(report.ok).toBe(false);
  });

  it("keeps a profile fixture unchanged while using injected read-only seams", async () => {
    mkdirSync(artifactRoot, { recursive: true });
    const profileRoot = mkdtempSync(join(artifactRoot, "doctor-profile-"));
    temporaryRoots.push(profileRoot);
    const sentinel = join(profileRoot, "sentinel.txt");
    writeFileSync(sentinel, "preserve", "utf8");
    const beforeNames = readdirSync(profileRoot);
    const beforeContent = readFileSync(sentinel, "utf8");
    const fsSeam = gitBashFs();
    const pathExists = vi.fn(() => true);
    const probe = passingProbe();
    vi.stubEnv("DSH_VERSION", "0.2.1-rc.3");

    const report = await runDoctor(doctorOptions({
      installAnchor: hostAnchor("0.2.1-rc.3"),
      env: {
        DSH_HOME: profileRoot,
        DSH_PROFILE: profileRoot,
      },
      pathExists,
      gitBashFs: fsSeam,
      probe,
    }));

    expect(report.ok).toBe(true);
    expect(readdirSync(profileRoot)).toEqual(beforeNames);
    expect(readFileSync(sentinel, "utf8")).toBe(beforeContent);
    expect(pathExists).toHaveBeenCalledWith("C:\\Windows\\System32\\wsl.exe");
    expect(fsSeam.statSync).toHaveBeenCalled();
    expect(fsSeam.accessSync).toHaveBeenCalled();
    expect(probe).toHaveBeenCalled();
  });
});
