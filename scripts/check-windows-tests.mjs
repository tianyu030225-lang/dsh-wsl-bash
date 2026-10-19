#!/usr/bin/env node

import { readFileSync } from "node:fs";

// These platform-gated contracts must execute on Windows. Checking the JSON
// assertions prevents a removed suite or a newly introduced skip from going green.
export function checkWindowsTests(report) {
  if (report.success !== true || report.numFailedTests !== 0 || report.numTotalTests === 0) {
    throw new Error("Windows unit tests did not complete successfully");
  }
  if (report.numPendingTests !== 0 || report.numTodoTests !== 0 || report.numPassedTests !== report.numTotalTests) {
    throw new Error("Windows unit tests contain skipped or todo cases");
  }
  const required = new Map([
    ["git-pty-broker-contract.test.ts", 22],
    ["wsl-prompt-producer.test.ts", 1],
    ["preflight-argv.test.ts", 1],
  ]);
  for (const [file, minimum] of required) {
    const suites = report.testResults.filter((suite) => suite.name.replaceAll("\\", "/").endsWith(`/${file}`));
    const assertions = suites.flatMap((suite) => suite.assertionResults);
    if (suites.length !== 1 || assertions.length < minimum || assertions.some((test) => test.status !== "passed")) {
      throw new Error(`Windows contract did not fully pass: ${file} (${assertions.length} cases)`);
    }
  }
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith("/check-windows-tests.mjs")) {
  checkWindowsTests(JSON.parse(readFileSync(process.argv[2] ?? "unit-results.json", "utf8")));
  console.log("Windows contracts executed successfully; no skipped or todo unit tests.");
}
