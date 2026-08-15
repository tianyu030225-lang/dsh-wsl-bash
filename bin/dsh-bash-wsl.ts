#!/usr/bin/env node

import { formatDoctorJson, formatDoctorText, runDoctor } from "../src/doctor/index.js";

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  if (argv[0] !== "doctor" || argv.slice(1).some((arg) => arg !== "--json")) {
    process.stderr.write("Usage: dsh-bash-wsl doctor [--json]\n");
    return 2;
  }
  const report = await runDoctor();
  process.stdout.write(argv.includes("--json") ? `${formatDoctorJson(report)}\n` : `${formatDoctorText(report)}\n`);
  return report.exitCode;
}

if (import.meta.url === `file://${process.argv[1]?.replaceAll("\\", "/")}`) {
  main().then((code) => { process.exitCode = code; }, (error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

