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
// Idempotency: if the staged profile marker matches and the staged copies are
// at least as new as the source binaries in `target/<profile>/`, the script
// skips the rebuild and copy. That keeps `tauri:dev` fast for engineers who
// run it manually while still forcing a restage when switching debug/release.

import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SUPPORTED_TARGETS = new Set([
  "aarch64-apple-darwin",
  "x86_64-apple-darwin",
  "aarch64-unknown-linux-gnu",
  "x86_64-unknown-linux-gnu",
]);

const BINARIES = [
  { cargoPkg: "vertebrae-cli", binName: "vtb" },
  { cargoPkg: "vertebrae-daemon", binName: "vtb-daemon" },
  { cargoPkg: "vtb-gate", binName: "vtb-gate" },
];

const scriptDir = dirname(fileURLToPath(import.meta.url));
const guiDir = resolve(scriptDir, "..");
const tauriDir = join(guiDir, "src-tauri");
const workspaceRoot = resolve(guiDir, "..", "..");
const stagingDir = join(tauriDir, "binaries");

function profileFromArgs(argv = process.argv.slice(2), env = process.env) {
  let profile = env.SIDECAR_PROFILE || "release";

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--debug") {
      profile = "debug";
    } else if (arg === "--release") {
      profile = "release";
    } else if (arg === "--profile") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--profile requires `debug` or `release`");
      }
      profile = value;
      index += 1;
    } else if (arg.startsWith("--profile=")) {
      profile = arg.slice("--profile=".length);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  if (profile !== "debug" && profile !== "release") {
    throw new Error(`unsupported sidecar profile: ${profile}`);
  }

  return profile;
}

function detectTargetTriple() {
  // Tauri sets this env var when invoking beforeBuildCommand for the
  // active build target. Honor it so cross-compilation stays consistent.
  const fromEnv = process.env.TAURI_ENV_TARGET_TRIPLE;
  if (fromEnv && fromEnv.length > 0) {
    return fromEnv;
  }

  const result = spawnSync("rustc", ["-vV"], { encoding: "utf8" });
  if (result.error) {
    throw new Error(`failed to run rustc -vV: ${result.error.message}`);
  }
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

function sourcePath(profile, binName, suffix, root = workspaceRoot) {
  return join(root, "target", profile, `${binName}${suffix}`);
}

function stagedPath(binName, target, suffix, dir = stagingDir) {
  return join(dir, `${binName}-${target}${suffix}`);
}

function profileMarkerPath(target, dir = stagingDir) {
  return join(dir, `.sidecar-profile-${target}`);
}

function stagedProfileMatches(profile, target, dir = stagingDir) {
  const marker = profileMarkerPath(target, dir);
  return existsSync(marker) && readFileSync(marker, "utf8").trim() === profile;
}

function needsRebuild(profile, target, suffix, dirs = {}) {
  const sourceRoot = dirs.workspaceRoot ?? workspaceRoot;
  const stagedDir = dirs.stagingDir ?? stagingDir;

  if (!stagedProfileMatches(profile, target, stagedDir)) {
    return true;
  }

  for (const { binName } of BINARIES) {
    const src = sourcePath(profile, binName, suffix, sourceRoot);
    const dst = stagedPath(binName, target, suffix, stagedDir);
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

function staleSidecarPaths(target, dir = stagingDir) {
  if (!existsSync(dir)) {
    return [];
  }

  const staleNames = new Set();
  for (const supportedTarget of SUPPORTED_TARGETS) {
    if (supportedTarget === target) {
      continue;
    }

    const suffix = exeSuffix(supportedTarget);
    staleNames.add(`.sidecar-profile-${supportedTarget}`);
    for (const { binName } of BINARIES) {
      staleNames.add(`${binName}-${supportedTarget}${suffix}`);
    }
  }

  return readdirSync(dir)
    .filter((name) => staleNames.has(name))
    .map((name) => join(dir, name));
}

function cleanStaleSidecars(target, dir = stagingDir) {
  for (const path of staleSidecarPaths(target, dir)) {
    rmSync(path, { force: true });
    console.log(`[prepare-sidecars] removed stale sidecar ${path}`);
  }
}

function runCargoBuild(profile) {
  const args = [
    "build",
    "-p",
    "vertebrae-cli",
    "-p",
    "vertebrae-daemon",
    "-p",
    "vtb-gate",
  ];
  if (profile === "release") {
    args.splice(1, 0, "--release");
  }
  console.log(`[prepare-sidecars] cargo ${args.join(" ")}`);
  const result = spawnSync("cargo", args, {
    cwd: workspaceRoot,
    stdio: "inherit",
  });
  if (result.error) {
    throw new Error(`failed to run cargo build: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`cargo build failed with status ${result.status}`);
  }
}

function stageBinaries(profile, target, suffix) {
  mkdirSync(stagingDir, { recursive: true });
  for (const { binName } of BINARIES) {
    const src = sourcePath(profile, binName, suffix);
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
  writeFileSync(profileMarkerPath(target), `${profile}\n`);
}

function main() {
  const profile = profileFromArgs();
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
  cleanStaleSidecars(target);

  if (
    stagedBinariesPresent(target, suffix) &&
    !needsRebuild(profile, target, suffix)
  ) {
    console.log(
      `[prepare-sidecars] ${profile} sidecars for ${target} are up to date; skipping rebuild`,
    );
    return;
  }

  runCargoBuild(profile);
  stageBinaries(profile, target, suffix);
  console.log(`[prepare-sidecars] done for ${target} (${profile})`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (err) {
    console.error(`[prepare-sidecars] ${err.message}`);
    process.exit(1);
  }
}

export {
  cleanStaleSidecars,
  needsRebuild,
  profileFromArgs,
  profileMarkerPath,
  stagedProfileMatches,
  stagedPath,
  staleSidecarPaths,
};
