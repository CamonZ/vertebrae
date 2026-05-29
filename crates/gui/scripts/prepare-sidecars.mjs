#!/usr/bin/env node
// Prepare Tauri sidecar binaries for the Vertebrae GUI bundle.
//
// Builds `vtb`, `vtb-daemon`, and `vtb-gate` from the workspace and stages them under
// `crates/gui/src-tauri/binaries/<bin>-<target-triple>` using the naming
// convention Tauri's `externalBin` expects.
//
// Profile: defaults to `release`. Set SIDECAR_PROFILE=debug to build and
// stage debug binaries instead — used by the GUI acceptance Docker build,
// which compiles everything in debug for speed.
//
// Idempotency: if the staged copies exist and are at least as new as the
// source binaries in `target/<profile>/`, the script skips the rebuild and
// the copy. That keeps `tauri:dev` fast for engineers who run it manually.

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SUPPORTED_TARGETS = new Set([
  "aarch64-apple-darwin",
  "x86_64-apple-darwin",
  "x86_64-unknown-linux-gnu",
]);

const BINARIES = [
  { cargoPkg: "vertebrae-cli", binName: "vtb" },
  { cargoPkg: "vertebrae-daemon", binName: "vtb-daemon" },
  { cargoPkg: "vtb-gate", binName: "vtb-gate" },
];

const PROFILE = process.env.SIDECAR_PROFILE === "debug" ? "debug" : "release";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const guiDir = resolve(scriptDir, "..");
const tauriDir = join(guiDir, "src-tauri");
const workspaceRoot = resolve(guiDir, "..", "..");
const stagingDir = join(tauriDir, "binaries");
const profileDir = join(workspaceRoot, "target", PROFILE);

function detectTargetTriple() {
  // Tauri sets this env var when invoking beforeBuildCommand for the
  // active build target. Honor it so cross-compilation stays consistent.
  const fromEnv = process.env.TAURI_ENV_TARGET_TRIPLE;
  if (fromEnv && fromEnv.length > 0) {
    return fromEnv;
  }

  const result = spawnSync("rustc", ["-vV"], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(
      `rustc -vV failed (status ${result.status}): ${result.stderr}`,
    );
  }
  const match = result.stdout.match(/^host:\s*(.+)$/m);
  if (!match) {
    throw new Error("could not parse host target from `rustc -vV` output");
  }
  return match[1].trim();
}

function exeSuffix(target) {
  return target.includes("windows") ? ".exe" : "";
}

function sourcePath(binName, suffix) {
  return join(profileDir, `${binName}${suffix}`);
}

function stagedPath(binName, target, suffix) {
  return join(stagingDir, `${binName}-${target}${suffix}`);
}

function needsRebuild(target, suffix) {
  for (const { binName } of BINARIES) {
    const src = sourcePath(binName, suffix);
    const dst = stagedPath(binName, target, suffix);
    if (!existsSync(dst)) {
      return true;
    }
    if (!existsSync(src)) {
      // No source yet — we need a build to produce one.
      return true;
    }
    const srcMtime = statSync(src).mtimeMs;
    const dstMtime = statSync(dst).mtimeMs;
    if (srcMtime > dstMtime) {
      return true;
    }
  }
  return false;
}

function stagedBinariesPresent(target, suffix) {
  return BINARIES.every(({ binName }) =>
    existsSync(stagedPath(binName, target, suffix)),
  );
}

function runCargoBuild() {
  const args = [
    "build",
    "-p",
    "vertebrae-cli",
    "-p",
    "vertebrae-daemon",
    "-p",
    "vtb-gate",
  ];
  if (PROFILE === "release") {
    args.splice(1, 0, "--release");
  }
  console.log(`[prepare-sidecars] cargo ${args.join(" ")}`);
  const result = spawnSync("cargo", args, {
    cwd: workspaceRoot,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(`cargo build failed with status ${result.status}`);
  }
}

function stageBinaries(target, suffix) {
  mkdirSync(stagingDir, { recursive: true });
  for (const { binName } of BINARIES) {
    const src = sourcePath(binName, suffix);
    const dst = stagedPath(binName, target, suffix);
    if (!existsSync(src)) {
      throw new Error(
        `expected built binary not found: ${src}. ` +
          "cargo build must produce vtb, vtb-daemon, and vtb-gate.",
      );
    }
    copyFileSync(src, dst);
    console.log(`[prepare-sidecars] staged ${src} -> ${dst}`);
  }
}

function main() {
  const target = detectTargetTriple();
  if (!SUPPORTED_TARGETS.has(target)) {
    console.error(
      `[prepare-sidecars] unsupported target triple: ${target}.\n` +
        `Supported targets: ${[...SUPPORTED_TARGETS].join(", ")}.\n` +
        "Add the triple to SUPPORTED_TARGETS in scripts/prepare-sidecars.mjs " +
        "and verify cross-compilation tooling is available.",
    );
    process.exit(1);
  }

  const suffix = exeSuffix(target);

  if (stagedBinariesPresent(target, suffix) && !needsRebuild(target, suffix)) {
    console.log(
      `[prepare-sidecars] sidecars for ${target} are up to date; skipping rebuild`,
    );
    return;
  }

  runCargoBuild();
  stageBinaries(target, suffix);
  console.log(`[prepare-sidecars] done for ${target}`);
}

try {
  main();
} catch (err) {
  console.error(`[prepare-sidecars] ${err.message}`);
  process.exit(1);
}
