import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

/** The only DSH runtime contract this release is built and tested against. */
export const SUPPORTED_DSH_VERSION = "0.1.0-rc.6";

const require = createRequire(import.meta.url);

/**
 * Read the DSH package version from the host that is loading this plugin.
 * Package-manager peer checks are not sufficient: `--legacy-peer-deps` and
 * hand-written profile manifests can bypass them, so activation must fail
 * closed when the host is missing or outside the tested rc.6 contract.
 */
export function readDshVersion(): string {
  let packagePath: string;
  try {
    packagePath = require.resolve("@deepseek-ai/dsh/package.json");
  } catch (error) {
    throw new Error(
      `dsh-plugin-bash-wsl requires @deepseek-ai/dsh ${SUPPORTED_DSH_VERSION}; the host DSH package could not be resolved`,
      { cause: error },
    );
  }

  try {
    const manifest: unknown = JSON.parse(readFileSync(packagePath, "utf8"));
    const version =
      typeof manifest === "object" &&
      manifest !== null &&
      "version" in manifest &&
      typeof manifest.version === "string"
        ? manifest.version
        : undefined;
    if (version === undefined) throw new Error("missing string version");
    return version;
  } catch (error) {
    throw new Error(
      `dsh-plugin-bash-wsl could not read the host DSH version from ${packagePath}`,
      { cause: error },
    );
  }
}

/** Fail before registering any backend/tool when the host is not exact rc.6. */
export function assertSupportedDshVersion(version = readDshVersion()): void {
  if (version !== SUPPORTED_DSH_VERSION) {
    throw new Error(
      `dsh-plugin-bash-wsl supports DSH ${SUPPORTED_DSH_VERSION} only; detected ${version}`,
    );
  }
}
