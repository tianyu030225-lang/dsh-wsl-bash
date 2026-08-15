#!/usr/bin/env node

import { formatDoctorJson, formatDoctorText, runDoctor } from "../dist/doctor/index.js";

const argv = process.argv.slice(2);
if (argv[0] !== "doctor" || argv.slice(1).some((arg) => arg !== "--json")) {
  process.stderr.write("Usage: dsh-bash-wsl doctor [--json]\n");
  process.exitCode = 2;
} else {
  try {
    const report = await runDoctor();
    process.stdout.write(argv.includes("--json")
      ? `${formatDoctorJson(report)}\n`
      : `${formatDoctorText(report)}\n`);
    process.exitCode = report.exitCode;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

