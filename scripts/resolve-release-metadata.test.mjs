import assert from "node:assert/strict";
import test from "node:test";

import { resolveReleaseMetadata } from "./resolve-release-metadata.mjs";

test("starts the master build counter at one", () => {
  assert.deepEqual(
    resolveReleaseMetadata({
      requestedRef: "refs/heads/master",
      baseVersion: "0.1.0",
      sourceSha: "0123456789abcdef",
    }),
    {
      channel: "master",
      channel_tag: "channel-master",
      version: "0.1.0-build.1",
      build: "01234567",
      source_sha: "0123456789abcdef",
      artifact_tag: "channel-master",
    },
  );
});

test("increments the master build counter for the current version", () => {
  assert.equal(
    resolveReleaseMetadata({
      requestedRef: "master",
      baseVersion: "0.1.0",
      previousMasterVersion: "0.1.0-build.18",
      sourceSha: "0123456789abcdef",
    }).version,
    "0.1.0-build.19",
  );
});

test("carries the legacy master build number into the new format", () => {
  assert.equal(
    resolveReleaseMetadata({
      requestedRef: "master",
      baseVersion: "0.1.0",
      previousMasterVersion: "0.1.18",
      sourceSha: "0123456789abcdef",
    }).version,
    "0.1.0-build.19",
  );
});

test("resets the master build counter when the base version changes", () => {
  assert.equal(
    resolveReleaseMetadata({
      requestedRef: "master",
      baseVersion: "0.1.1",
      previousMasterVersion: "0.1.0-build.18",
      sourceSha: "0123456789abcdef",
    }).version,
    "0.1.1-build.1",
  );
});

test("resolves release metadata from a semantic version tag", () => {
  assert.deepEqual(
    resolveReleaseMetadata({
      requestedRef: "refs/tags/v1.2.3-rc.1",
      sourceSha: "fedcba9876543210",
    }),
    {
      channel: "release",
      channel_tag: "channel-release",
      version: "1.2.3-rc.1",
      build: "fedcba98",
      source_sha: "fedcba9876543210",
      artifact_tag: "v1.2.3-rc.1",
    },
  );
});

test("rejects unsupported refs", () => {
  assert.throws(
    () =>
      resolveReleaseMetadata({
        requestedRef: "refs/heads/feature/release-workflow",
        sourceSha: "0123456789abcdef",
      }),
    /Unsupported release ref/,
  );
});
