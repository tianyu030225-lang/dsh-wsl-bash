import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute } from "node:path";

/** Exact host contracts supported by this release; never a floating range. */
export const SUPPORTED_DSH_VERSIONS = Object.freeze([
  "0.2.1-rc.2",
] as const);

/** @deprecated Use SUPPORTED_DSH_VERSIONS to include the Desktop contract. */
export const SUPPORTED_DSH_VERSION = SUPPORTED_DSH_VERSIONS[0];

const require = createRequire(import.meta.url);

/** Resolve public runtime modules from the actual host, never plugin-local peers. */
export function createDshHostRequire(installAnchor: string): NodeRequire {
  assertSupportedDshVersion(readDshVersion(installAnchor));
  return createRequire(realpathSync(installAnchor));
}

/**
 * Read an explicit host installation anchor. Without an anchor this is only
 * standalone discovery, not evidence of the running Desktop/CLI host.
 */
export function readDshVersion(installAnchor?: string): string {
  let packagePath: string;
  try {
    if (installAnchor !== undefined && (!isAbsolute(installAnchor) || installAnchor.includes("\0"))) {
      throw new Error("host installAnchor must be an absolute NUL-free path");
    }
    packagePath = installAnchor ?? require.resolve("@deepseek-ai/dsh/package.json");
  } catch (error) {
    throw new Error(
      `dsh-plugin-bash-wsl requires @deepseek-ai/dsh ${SUPPORTED_DSH_VERSIONS.join(" or ")}; the DSH installation could not be resolved`,
      { cause: error },
    );
  }

  try {
    const manifest: unknown = JSON.parse(readFileSync(packagePath, "utf8"));
    if (typeof manifest !== "object" || manifest === null || !("name" in manifest) || manifest.name !== "@deepseek-ai/dsh") {
      throw new Error("installAnchor is not an @deepseek-ai/dsh manifest");
    }
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

/** Fail before registering a backend/tool outside the tested host contract. */
export function assertSupportedDshVersion(version = readDshVersion()): void {
  if (!(SUPPORTED_DSH_VERSIONS as readonly string[]).includes(version)) {
    throw new Error(
      `dsh-plugin-bash-wsl supports DSH ${SUPPORTED_DSH_VERSIONS.join(" or ")} only; detected ${version}`,
    );
  }
}
