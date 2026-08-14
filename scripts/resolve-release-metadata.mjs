#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const RELEASE_TAG_PATTERN = /^v[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$/;

export function resolveReleaseMetadata({ requestedRef, runNumber, sourceSha }) {
  if (!requestedRef) {
    throw new Error("REQUESTED_REF is required");
  }
  if (!runNumber) {
    throw new Error("RUN_NUMBER is required");
  }

  const resolvedSha = sourceSha ?? currentSourceSha();
  const build = resolvedSha.slice(0, 8);

  if (requestedRef === "master" || requestedRef === "refs/heads/master") {
    return {
      channel: "master",
      channel_tag: "channel-master",
      version: `0.1.${runNumber}`,
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

function currentSourceSha() {
  return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

function main() {
  const metadata = resolveReleaseMetadata({
    requestedRef: process.env.REQUESTED_REF,
    runNumber: process.env.RUN_NUMBER,
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
