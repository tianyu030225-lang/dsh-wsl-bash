import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_CONFIG, resolveConfig } from "../../../src/config.js";
import { apply, inject as pluginInject } from "../../../src/index.js";
import { registerShellModes, SHELL_MODES } from "../../../src/modes.js";

const artifactRoot = resolve(process.cwd(), "测试", "运行产物");
const temporaryRoots: string[] = [];

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value), "utf8");
}

function writeText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, "utf8");
}

function createHostAnchor(version = "0.2.1-alpha.1"): string {
  mkdirSync(artifactRoot, { recursive: true });
  const root = mkdtempSync(join(artifactRoot, "unit-mode-host-"));
  temporaryRoots.push(root);
  const anchor = join(root, "node_modules", "@deepseek-ai", "dsh", "package.json");
  writeJson(anchor, { name: "@deepseek-ai/dsh", version });
  return anchor;
}

function createHostPresetFixture(): {
  anchor: string;
  standardPlugins: readonly Record<string, unknown>[];
} {
  mkdirSync(artifactRoot, { recursive: true });
  const root = mkdtempSync(join(artifactRoot, "unit-mode-standard-"));
  temporaryRoots.push(root);

  const standardPlugins = [
    {
      id: "stock-bash",
      name: "@deepseek-ai/dsh-tool-bash",
      config: { source: "host-standard" },
    },
    {
      id: "stock-pwsh",
      name: "@deepseek-ai/dsh-tool-pwsh",
      config: { source: "host-standard" },
    },
    {
      id: "host-js-disabled",
      name: "@deepseek-ai/dsh-host-capability",
      disabled: { __jsExpr: "hostCapability" },
      config: { source: "host-standard" },
    },
    {
      id: "stock-other",
      name: "@deepseek-ai/dsh-tool-other",
      config: { source: "host-standard" },
    },
  ] as const;
  const patch = [
    {
      insert: [
        {
          name: "@deepseek-ai/dsh-agent-preset",
          config: {
            id: "standard",
            plugins: standardPlugins,
          },
        },
      ],
    },
  ];

  writeJson(join(root, "node_modules", "@deepseek-ai", "dsh", "package.json"), {
    name: "@deepseek-ai/dsh",
    version: "0.2.1-alpha.1",
  });
  writeJson(join(root, "node_modules", "@deepseek-ai", "cordis-plugin-include", "package.json"), {
    name: "@deepseek-ai/cordis-plugin-include",
    version: "1.0.10-alpha.1",
    type: "module",
    exports: { ".": "./index.js" },
  });
  writeText(
    join(root, "node_modules", "@deepseek-ai", "cordis-plugin-include", "index.js"),
    'export const entryListSchema = { hostMarker: "host-entry-list-schema" };\n',
  );
  writeJson(join(root, "node_modules", "@deepseek-ai", "dsh-agent-preset-registry", "package.json"), {
    name: "@deepseek-ai/dsh-agent-preset-registry",
    version: "0.2.1-alpha.1",
    type: "module",
    exports: { ".": "./index.js" },
  });
  writeText(
    join(root, "node_modules", "@deepseek-ai", "dsh-agent-preset-registry", "index.js"),
    [
      "export function entryListProblem(rows) {",
      "  const marker = Array.isArray(rows) && rows.find((row) => row?.id === 'host-js-disabled');",
      "  return marker?.disabled?.__jsExpr === 'hostCapability' ? undefined : 'host standard marker missing';",
      "}",
    ].join("\n"),
  );
  writeJson(join(root, "node_modules", "js-yaml", "package.json"), {
    name: "js-yaml",
    version: "4.2.0",
    main: "index.cjs",
  });
  writeText(
    join(root, "node_modules", "js-yaml", "index.cjs"),
    [
      "exports.load = function load(_text, options) {",
      "  if (options?.schema?.hostMarker !== 'host-entry-list-schema') throw new Error('host entryListSchema was not used');",
      `  return ${JSON.stringify(patch)};`,
      "};",
    ].join("\n"),
  );
  writeJson(join(root, "node_modules", "@deepseek-ai", "dsh-web-app", "package.json"), {
    name: "@deepseek-ai/dsh-web-app",
    version: "0.2.1-alpha.1",
  });
  writeText(
    join(root, "node_modules", "@deepseek-ai", "dsh-web-app", "presets", "standard.patch.yml"),
    "host standard patch\n",
  );

  return {
    anchor: join(root, "node_modules", "@deepseek-ai", "dsh", "package.json"),
    standardPlugins,
  };
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("mode configuration contract", () => {
  it("defaults to persistent WSL mode and retains mode registration", () => {
    expect(DEFAULT_CONFIG.persistentShell).toBe("wsl");
    expect(DEFAULT_CONFIG.registerModes).toBe(true);
    expect(resolveConfig()).toMatchObject({
      persistentShell: "wsl",
      registerModes: true,
    });
  });

  it("accepts the Git Bash selection and an explicit child-registration opt-out", () => {
    expect(resolveConfig({
      persistentShell: "git-bash",
      registerModes: false,
    })).toMatchObject({
      persistentShell: "git-bash",
      registerModes: false,
    });
  });

  it.each([
    ["persistentShell", "cmd.exe"],
    ["registerModes", "yes"],
  ] as const)("rejects invalid %s", (field, value) => {
    expect(() => resolveConfig({ [field]: value } as never)).toThrow(field);
  });
});

describe("official persistent Bash backend injection contract", () => {
  it("declares every service required by the installed alpha1 official backend", async () => {
    const anchor = realpathSync.native(
      resolve(process.cwd(), "node_modules", "@deepseek-ai", "dsh", "package.json"),
    );
    const hostRequire = createRequire(anchor);
    const official = await import(
      pathToFileURL(hostRequire.resolve("@deepseek-ai/dsh-terminal-bash")).href,
    ) as { inject: readonly string[] };
    expect(official.inject).toEqual([
      "terminals",
      "sandboxPolicy",
      "sessionProjections",
      "subprocess",
    ]);
    expect(pluginInject).toEqual(expect.arrayContaining([...official.inject]));
    expect(pluginInject).toContain("sessionProjections");
  });
});

describe("CLI activation without an agent-preset registry", () => {
  it("registers the optional injection and returns without waiting for it", () => {
    const anchor = createHostAnchor();
    const inject = vi.fn();
    const ctx = {
      profileContext: { installAnchor: anchor },
      terminals: { registerBackend: vi.fn() },
      tools: { register: vi.fn() },
      subprocess: {},
      sandboxPolicy: {},
      systemPrompt: {
        getSectionOrder: vi.fn(() => 1000),
        section: vi.fn(),
      },
      inject,
    } as any;

    expect(() => apply(ctx, { registerModes: true })).not.toThrow();
    expect(inject).toHaveBeenCalledOnce();
    expect(inject).toHaveBeenCalledWith(["agentPresets"], expect.any(Function));
    expect(inject.mock.calls[0]?.[1]).toBeTypeOf("function");
  });

  it("does not request the optional registry when registration is disabled", () => {
    const anchor = createHostAnchor();
    const inject = vi.fn();
    const ctx = {
      profileContext: { installAnchor: anchor },
      terminals: { registerBackend: vi.fn() },
      tools: { register: vi.fn() },
      subprocess: {},
      sandboxPolicy: {},
      systemPrompt: {
        getSectionOrder: vi.fn(() => 1000),
        section: vi.fn(),
      },
      inject,
    } as any;

    expect(() => apply(ctx, { registerModes: false })).not.toThrow();
    expect(inject).not.toHaveBeenCalled();
  });
});

describe("host Standard composition and shell mode registration", () => {
  it("rejects an unsupported actual host anchor before any preset registration", async () => {
    const anchor = createHostAnchor("0.2.0-rc.99");
    const register = vi.fn();

    await expect(registerShellModes({
      profileContext: { installAnchor: anchor },
      agentPresets: { register },
    } as any, resolveConfig())).rejects.toThrow(/supports DSH .*detected 0\.2\.0-rc\.99/);
    expect(register).not.toHaveBeenCalled();
  });

  it("registers exactly the two isolated modes from the real host Standard shape", async () => {
    const fixture = createHostPresetFixture();
    const registrations: any[] = [];
    const disposers: ReturnType<typeof vi.fn>[] = [];
    const ctx = {
      profileContext: { installAnchor: fixture.anchor },
      agentPresets: {
        register: vi.fn(async (definition: unknown) => {
          registrations.push(definition);
          const disposer = vi.fn(async () => undefined);
          disposers.push(disposer);
          return disposer;
        }),
      },
    } as any;
    const config = resolveConfig({
      gitBashExecutable: "C:\\Program Files\\Git\\bin\\bash.exe",
    });

    const dispose = await registerShellModes(ctx, config);

    expect(SHELL_MODES.map((mode) => mode.id)).toEqual(["bash-wsl", "bash-git-bash"]);
    expect(registrations.map((definition) => definition.id)).toEqual([
      "bash-wsl",
      "bash-git-bash",
    ]);
    expect(registrations.map((definition) => definition.name)).toEqual([
      "WSL 模式",
      "Git Bash 模式",
    ]);
    expect(registrations.map((definition) => definition.order)).toEqual([5, 6]);
    expect(registrations[0]?.plugins).toHaveLength(fixture.standardPlugins.length);

    for (const [index, definition] of registrations.entries()) {
      const shell = index === 0 ? "wsl" : "git-bash";
      const expectedStandard = fixture.standardPlugins.filter(
        (plugin) => plugin.name !== "@deepseek-ai/dsh-tool-bash",
      );
      expect(definition.plugins.slice(0, -1)).toEqual(expectedStandard);
      expect(definition.plugins.slice(0, -1)).not.toBe(expectedStandard);
      expect(definition.plugins.some((plugin: any) => plugin.name === "@deepseek-ai/dsh-tool-pwsh")).toBe(true);

      const modeGroup = definition.plugins.at(-1);
      expect(modeGroup).toMatchObject({
        id: "native-bash-terminal",
        name: "cordis:group",
        group: true,
        isolate: { terminals: true },
      });
      expect(modeGroup.config).toHaveLength(3);
      expect(modeGroup.config[0]).toMatchObject({
        id: "terminal-registry",
        name: "@deepseek-ai/dsh-terminal",
      });
      expect(modeGroup.config[1]).toMatchObject({
        id: "native-backend-and-tools",
        name: "dsh-plugin-bash-wsl",
        config: {
          backendType: shell,
          persistentShell: shell,
          registerModes: false,
        },
      });
      expect(modeGroup.config[2]).toMatchObject({
        id: "persistent-bash",
        name: "dsh-plugin-bash-wsl/persistent",
        config: { backendType: shell },
      });
      expect(definition.description).toContain(shell === "wsl" ? "持久 WSL Bash" : "持久 Git Bash");
    }

    // The host's stock one-shot bash row was replaced only in each derived list;
    // the parsed Standard source itself still contains it for later host users.
    expect(fixture.standardPlugins.some((plugin) => plugin.name === "@deepseek-ai/dsh-tool-bash")).toBe(true);
    expect(registrations[0]?.plugins.at(-1)).not.toBe(registrations[1]?.plugins.at(-1));
    expect(registrations[0]?.plugins[0]).not.toBe(registrations[1]?.plugins[0]);

    await dispose();
    expect(disposers).toHaveLength(2);
    for (const disposer of disposers) expect(disposer).toHaveBeenCalledOnce();
  });

  it("parses the installed alpha1 Standard patch with official js-yaml/!!js and preserves the full plugin tree", async () => {
    const anchor = realpathSync.native(
      resolve(process.cwd(), "node_modules", "@deepseek-ai", "dsh", "package.json"),
    );
    const hostRequire = createRequire(anchor);
    const include = await import(
      pathToFileURL(hostRequire.resolve("@deepseek-ai/cordis-plugin-include")).href,
    ) as { entryListSchema: unknown };
    const yaml = hostRequire("js-yaml") as typeof import("js-yaml");
    const parsed = yaml.load(
      readFileSync(
        hostRequire.resolve("@deepseek-ai/dsh-web-app/presets/standard.patch.yml"),
        "utf8",
      ),
      { schema: include.entryListSchema as any },
    );
    expect(Array.isArray(parsed)).toBe(true);
    const rows = (parsed as any[]).flatMap((item) =>
      item && Array.isArray(item.insert) ? item.insert : [],
    );
    const standard = rows.find(
      (row) => row?.name === "@deepseek-ai/dsh-agent-preset" && row?.config?.id === "standard",
    );
    expect(standard).toBeDefined();
    const standardPlugins = standard.config.plugins as any[];
    const registry = await import(
      pathToFileURL(hostRequire.resolve("@deepseek-ai/dsh-agent-preset-registry")).href,
    ) as { entryListProblem: (plugins: unknown) => string | undefined };
    expect(registry.entryListProblem(standardPlugins)).toBeUndefined();
    const loader = await import(
      pathToFileURL(hostRequire.resolve("@deepseek-ai/cordis-plugin-loader")).href,
    ) as { isJsExpr: (value: unknown) => boolean };
    const stockBash = standardPlugins.find((plugin) => plugin.id === "tool-bash");
    expect(stockBash?.disabled).toEqual({ __jsExpr: "process.platform === 'win32'" });
    expect(loader.isJsExpr(stockBash?.disabled)).toBe(true);
    const parsedBeforeRegistration = structuredClone(standardPlugins);

    const registrations: any[] = [];
    const ctx = {
      profileContext: { installAnchor: anchor },
      agentPresets: {
        register: vi.fn(async (definition: unknown) => {
          registrations.push(definition);
          return vi.fn(async () => undefined);
        }),
      },
    } as any;

    await registerShellModes(ctx, resolveConfig());

    expect(registrations).toHaveLength(2);
    const expectedPlugins = standardPlugins.filter(
      (plugin) => plugin.name !== "@deepseek-ai/dsh-tool-bash",
    );
    for (const definition of registrations) {
      expect(definition.plugins.slice(0, -1)).toEqual(expectedPlugins);
      const retainedBash = definition.plugins.find((plugin: any) => plugin.id === "tool-bash");
      expect(retainedBash).toBeUndefined();
      expect(definition.plugins.some((plugin: any) => plugin.id === "tool-pwsh")).toBe(true);
      expect(definition.plugins.some((plugin: any) => plugin.id === "tool-fs")).toBe(true);
    }
    expect(standardPlugins).toEqual(parsedBeforeRegistration);
  });

  it("rolls back a partial registration when the second mode is rejected as a duplicate", async () => {
    const fixture = createHostPresetFixture();
    const firstDisposer = vi.fn(async () => undefined);
    const register = vi.fn()
      .mockResolvedValueOnce(firstDisposer)
      .mockRejectedValueOnce(new Error("duplicate preset id: bash-git-bash"));
    const ctx = {
      profileContext: { installAnchor: fixture.anchor },
      agentPresets: { register },
    } as any;

    await expect(registerShellModes(ctx, resolveConfig())).rejects.toThrow(
      /duplicate preset id/,
    );
    expect(register).toHaveBeenCalledTimes(2);
    expect(firstDisposer).toHaveBeenCalledOnce();
  });
});
