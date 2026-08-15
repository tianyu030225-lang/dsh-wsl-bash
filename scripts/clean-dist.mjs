#!/usr/bin/env node

import { existsSync, lstatSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = resolve(projectRoot, "dist");

// Keep this cleanup deliberately narrow: only the build output directory
// belonging to this checkout may be removed. Refuse unexpected filesystem
// objects rather than risking a symlink/junction or path-resolution mistake.
if (dirname(distDir) !== projectRoot || distDir !== join(projectRoot, "dist")) {
  throw new Error(`Refusing to clean unexpected dist path: ${distDir}`);
}

if (!existsSync(distDir)) process.exit(0);

const distStat = lstatSync(distDir);
if (distStat.isSymbolicLink()) {
  throw new Error(`Refusing to clean symlinked dist directory: ${distDir}`);
}
if (!distStat.isDirectory()) {
  throw new Error(`Refusing to clean non-directory dist path: ${distDir}`);
}

rmSync(distDir, { recursive: true, force: true });
