import assert from "node:assert/strict";
import test from "node:test";

import { resolveReleaseMetadata } from "./resolve-release-metadata.mjs";

test("resolves master metadata from the workflow run number", () => {
  assert.deepEqual(
    resolveReleaseMetadata({
      requestedRef: "refs/heads/master",
      runNumber: "42",
      sourceSha: "0123456789abcdef",
    }),
    {
      channel: "master",
      channel_tag: "channel-master",
      version: "0.1.42",
      build: "01234567",
      source_sha: "0123456789abcdef",
      immutable_tag: "components-master-01234567",
    },
  );
});

test("resolves release metadata from a semantic version tag", () => {
  assert.deepEqual(
    resolveReleaseMetadata({
      requestedRef: "refs/tags/v1.2.3-rc.1",
      runNumber: "42",
      sourceSha: "fedcba9876543210",
    }),
    {
      channel: "release",
      channel_tag: "channel-release",
      version: "1.2.3-rc.1",
      build: "fedcba98",
      source_sha: "fedcba9876543210",
      immutable_tag: "v1.2.3-rc.1",
    },
  );
});

test("rejects unsupported refs", () => {
  assert.throws(
    () =>
      resolveReleaseMetadata({
        requestedRef: "feature/release-workflow",
        runNumber: "42",
        sourceSha: "0123456789abcdef",
      }),
    /Unsupported release ref/,
  );
});
