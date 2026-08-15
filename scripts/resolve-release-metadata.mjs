#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const RELEASE_TAG_PATTERN = /^v[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$/;
const STABLE_VERSION_TAG_PATTERN = /^v([0-9]+\.[0-9]+\.[0-9]+)$/;
const MASTER_BUILD_VERSION_PATTERN = /^(\d+\.\d+\.\d+)-build\.(\d+)$/;
const DEFAULT_MASTER_BASE_VERSION = "0.1.0";

export function resolveReleaseMetadata({
  requestedRef,
  baseVersion,
  previousMasterVersion,
  sourceSha,
}) {
  if (!requestedRef) {
    throw new Error("REQUESTED_REF is required");
  }

  const resolvedSha = sourceSha ?? currentSourceSha();
  const build = resolvedSha.slice(0, 8);

  if (requestedRef === "master" || requestedRef === "refs/heads/master") {
    const masterBaseVersion = baseVersion ?? latestStableVersion();
    return {
      channel: "master",
      channel_tag: "channel-master",
      version: `${masterBaseVersion}-build.${nextMasterBuildNumber(masterBaseVersion, previousMasterVersion)}`,
      build,
      source_sha: resolvedSha,
      artifact_tag: "channel-master",
    };
  }

  const tag = requestedRef.startsWith("refs/tags/")
    ? requestedRef.slice("refs/tags/".length)
    : requestedRef;
  if (RELEASE_TAG_PATTERN.test(tag)) {
    return {
      channel: "release",
      channel_tag: "channel-release",
      version: tag.slice(1),
      build,
      source_sha: resolvedSha,
      artifact_tag: tag,
    };
  }

  throw new Error(
    `Unsupported release ref: ${requestedRef} (expected master or a vX.Y.Z tag)`,
  );
}

function nextMasterBuildNumber(baseVersion, previousMasterVersion) {
  return masterBuildNumber(baseVersion, previousMasterVersion) + 1;
}

function masterBuildNumber(baseVersion, previousMasterVersion) {
  if (!previousMasterVersion) return 0;

  const currentBuild = previousMasterVersion.match(MASTER_BUILD_VERSION_PATTERN);
  if (currentBuild?.[1] === baseVersion) return Number(currentBuild[2]);

  // The old master channel used 0.1.<run number>. Carry that number forward
  // once so existing clients can see the first build-prerelease update.
  const legacyVersion = previousMasterVersion.match(/^([0-9]+)\.([0-9]+)\.(\d+)$/);
  const base = baseVersion.match(/^([0-9]+)\.([0-9]+)\.([0-9]+)$/);
  if (
    legacyVersion &&
    base &&
    base[1] === legacyVersion[1] &&
    base[2] === legacyVersion[2] &&
    base[3] === "0"
  ) {
    return Number(legacyVersion[3]);
  }

  return 0;
}

function latestStableVersion() {
  const versions = execFileSync("git", ["tag", "--list"], { encoding: "utf8" })
    .split("\n")
    .map((tag) => tag.match(STABLE_VERSION_TAG_PATTERN)?.[1])
    .filter(Boolean);
  return versions.sort(compareVersions).at(-1) ?? DEFAULT_MASTER_BASE_VERSION;
}

function compareVersions(left, right) {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] !== rightParts[index]) {
      return leftParts[index] - rightParts[index];
    }
  }
  return 0;
}

function currentSourceSha() {
  return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

function main() {
  const metadata = resolveReleaseMetadata({
    requestedRef: process.env.REQUESTED_REF,
    baseVersion: process.env.MASTER_BASE_VERSION,
    previousMasterVersion: process.env.PREVIOUS_MASTER_VERSION,
  });
  for (const [key, value] of Object.entries(metadata)) {
    process.stdout.write(`${key}=${value}\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
