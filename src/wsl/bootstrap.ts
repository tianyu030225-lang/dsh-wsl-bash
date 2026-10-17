const BASH_STARTUP_ENVIRONMENT = Object.freeze([
  "BASH_ENV",
  "ENV",
  "SHELLOPTS",
  "BASHOPTS",
  "CDPATH",
  "GLOBIGNORE",
] as const);

function wslEnvName(entry: string): string {
  return (entry.split("/")[0] ?? "").trim().toUpperCase();
}

/** Preserve unrelated WSLENV forwarding while removing Bash startup controls. */
export function filteredWslEnv(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const blocked = new Set<string>([...BASH_STARTUP_ENVIRONMENT, "SHELL"]);
  const retained = value.split(":").filter((entry) => entry.length > 0 && !blocked.has(wslEnvName(entry)));
  return retained.length === 0 ? undefined : retained.join(":");
}

/** Overrides for DSH's managed subprocess environment merge. */
export function wslHostEnvironmentOverrides(
  base: NodeJS.ProcessEnv = process.env,
  additions: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { ...additions };
  for (const name of BASH_STARTUP_ENVIRONMENT) result[name] = undefined;
  result.SHELL = undefined;
  result.WSLENV = filteredWslEnv(base.WSLENV);
  return result;
}

/** Complete environment for direct Node child_process calls such as doctor. */
export function sanitizedWslHostEnvironment(
  base: NodeJS.ProcessEnv = process.env,
  additions: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { ...base, ...additions };
  for (const name of BASH_STARTUP_ENVIRONMENT) delete result[name];
  delete result.SHELL;
  const wslenv = filteredWslEnv(base.WSLENV);
  if (wslenv === undefined) delete result.WSLENV;
  else result.WSLENV = wslenv;
  return result;
}

/** Start fixed WSL Bash without allowing inherited startup variables to run. */
export function cleanWslBashArgv(script: string, ...args: readonly string[]): readonly string[] {
  const envArgs = BASH_STARTUP_ENVIRONMENT.flatMap((name) => ["-u", name]);
  return [
    "/usr/bin/env",
    ...envArgs,
    "SHELL=/bin/bash",
    "/bin/bash",
    "--noprofile",
    "--norc",
    "-c",
    script,
    ...args,
  ];
}

export { BASH_STARTUP_ENVIRONMENT };
