import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { apply } from "../../../src/index.js";
import {
  assertSupportedDshVersion,
  readDshVersion,
  SUPPORTED_DSH_VERSION,
  SUPPORTED_DSH_VERSIONS,
} from "../../../src/runtime.js";

const artifactRoot = resolve(process.cwd(), "测试", "运行产物");
const temporaryRoots: string[] = [];

function hostManifest(version: string, name = "@deepseek-ai/dsh"): string {
  mkdirSync(artifactRoot, { recursive: true });
  const root = mkdtempSync(join(artifactRoot, "unit-host-runtime-"));
  temporaryRoots.push(root);
  const anchor = join(root, "node_modules", "@deepseek-ai", "dsh", "package.json");
  mkdirSync(dirname(anchor), { recursive: true });
  writeFileSync(anchor, JSON.stringify({ name, version }), "utf8");
  return anchor;
}

function activationContext(anchor: string) {
  return {
    profileContext: { installAnchor: anchor },
    terminals: { registerBackend: vi.fn() },
    tools: { register: vi.fn() },
    inject: vi.fn(),
    systemPrompt: {
      getSectionOrder: vi.fn(() => 1000),
      section: vi.fn(() => vi.fn()),
    },
    workingDirectory: { ensure: vi.fn() },
  } as any;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("0.2 host compatibility and profileContext anchor", () => {
  it.each([...SUPPORTED_DSH_VERSIONS])("reads the exact host manifest for %s", (version) => {
    const anchor = hostManifest(version);

    expect(readDshVersion(anchor)).toBe(version);
    expect(JSON.parse(readFileSync(anchor, "utf8"))).toMatchObject({
      name: "@deepseek-ai/dsh",
      version,
    });
  });

  it.each([...SUPPORTED_DSH_VERSIONS])(
    "uses the supplied %s anchor instead of an accepted local dependency",
    (version) => {
      const anchor = hostManifest(version);
      const ctx = activationContext(anchor);

      expect(() => apply(ctx)).not.toThrow();
      expect(ctx.terminals.registerBackend).toHaveBeenCalledTimes(1);
      expect(ctx.tools.register).toHaveBeenCalledTimes(2);
      expect(ctx.systemPrompt.section).toHaveBeenCalledTimes(1);
    },
  );

  it("rejects an unknown anchor even when the local dependency is supported", () => {
    const anchor = hostManifest("0.2.0-rc.99");
    const ctx = activationContext(anchor);

    expect(() => apply(ctx)).toThrow(/supports DSH 0\.2\.1-rc\.2 only.*detected 0\.2\.0-rc\.99/);
    expect(ctx.terminals.registerBackend).not.toHaveBeenCalled();
    expect(ctx.tools.register).not.toHaveBeenCalled();
    expect(ctx.systemPrompt.section).not.toHaveBeenCalled();
  });

  it.each(["0.1.0-rc.6", "0.1.0-rc.5", "", "unknown"])(
    "rejects legacy or unknown DSH version %s before activation",
    (version) => {
      expect(() => assertSupportedDshVersion(version)).toThrow(/supports DSH/);
    },
  );

  it("requires an absolute anchor and the real DSH package identity", () => {
    expect(() => readDshVersion("relative/package.json")).toThrow(/absolute|DSH installation/);
    expect(() => readDshVersion(hostManifest("0.2.0-rc.2", "shadow-package"))).toThrow(
      /could not read the host DSH version|@deepseek-ai\/dsh manifest/,
    );
  });

  it("fails closed before registration when profileContext.installAnchor is absent", () => {
    const ctx = activationContext(hostManifest("0.2.0-rc.2"));
    delete ctx.profileContext;

    expect(() => apply(ctx)).toThrow(/profileContext\.installAnchor/);
    expect(ctx.terminals.registerBackend).not.toHaveBeenCalled();
    expect(ctx.tools.register).not.toHaveBeenCalled();
    expect(ctx.systemPrompt.section).not.toHaveBeenCalled();
  });

  it("rejects an anchor containing NUL before filesystem access", () => {
    const ctx = activationContext(resolve(artifactRoot, "host\0package.json"));

    expect(() => apply(ctx)).toThrow(/installAnchor|DSH installation/);
    expect(ctx.terminals.registerBackend).not.toHaveBeenCalled();
    expect(ctx.tools.register).not.toHaveBeenCalled();
  });

  it("keeps the deprecated singular export tied to the current exact contract", () => {
    expect(SUPPORTED_DSH_VERSION).toBe("0.2.1-rc.2");
    expect(SUPPORTED_DSH_VERSIONS).toEqual(["0.2.1-rc.2"]);
  });
});
