import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  cleanStaleSidecars,
  needsRebuild,
  profileFromArgs,
  profileMarkerPath,
  stagedProfileMatches,
  stagedPath,
  staleSidecarPaths,
} from "./prepare-sidecars.mjs";

test("profileFromArgs defaults to release and honors env/flags", () => {
  assert.equal(profileFromArgs([], {}), "release");
  assert.equal(profileFromArgs([], { SIDECAR_PROFILE: "debug" }), "debug");
  assert.equal(profileFromArgs(["--release"], { SIDECAR_PROFILE: "debug" }), "release");
  assert.equal(profileFromArgs(["--debug"], {}), "debug");
  assert.equal(profileFromArgs(["--profile", "debug"], {}), "debug");
  assert.equal(profileFromArgs(["--profile=release"], {}), "release");
});

test("profileFromArgs rejects unsupported profiles", () => {
  assert.throws(
    () => profileFromArgs([], { SIDECAR_PROFILE: "relese" }),
    /unsupported sidecar profile: relese/,
  );
  assert.throws(
    () => profileFromArgs(["--profile", "fast"], {}),
    /unsupported sidecar profile: fast/,
  );
  assert.throws(() => profileFromArgs(["--profile"], {}), /requires/);
});

test("staleSidecarPaths identifies only supported non-host sidecars", (t) => {
  const stagingDir = mkdtempSync(join(tmpdir(), "vertebrae-sidecars-"));
  t.after(() => rmSync(stagingDir, { recursive: true, force: true }));

  const stale = [
    ".sidecar-profile-x86_64-apple-darwin",
    "vtb-x86_64-apple-darwin",
    "vtb-daemon-x86_64-apple-darwin",
    "vtb-gate-x86_64-apple-darwin",
  ];
  const current = [
    "vtb-aarch64-apple-darwin",
    "vtb-daemon-aarch64-apple-darwin",
    "vtb-gate-aarch64-apple-darwin",
  ];
  const unrelated = ["notes.txt", "vtb-unsupported-target"];
  const created = [...stale, ...current, ...unrelated].map((name) =>
    join(stagingDir, name),
  );

  for (const path of created) {
    writeFileSync(path, path.split("/").pop());
  }

  const staleNames = staleSidecarPaths("aarch64-apple-darwin", stagingDir).map(
    (path) => path.split("/").pop(),
  );
  assert.deepEqual(staleNames.sort(), stale.sort());

  cleanStaleSidecars("aarch64-apple-darwin", stagingDir);
  assert.deepEqual(staleSidecarPaths("aarch64-apple-darwin", stagingDir), []);
});

test("stagedProfileMatches requires an exact profile marker", (t) => {
  const stagingDir = mkdtempSync(join(tmpdir(), "vertebrae-sidecars-"));
  t.after(() => rmSync(stagingDir, { recursive: true, force: true }));

  const target = "aarch64-apple-darwin";
  assert.equal(stagedProfileMatches("debug", target, stagingDir), false);

  writeFileSync(profileMarkerPath(target, stagingDir), "release\n");
  assert.equal(stagedProfileMatches("release", target, stagingDir), true);
  assert.equal(stagedProfileMatches("debug", target, stagingDir), false);
});

test("needsRebuild compares source and staged sidecar mtimes", (t) => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "vertebrae-workspace-"));
  const stagingDir = mkdtempSync(join(tmpdir(), "vertebrae-sidecars-"));
  t.after(() => {
    rmSync(workspaceRoot, { recursive: true, force: true });
    rmSync(stagingDir, { recursive: true, force: true });
  });

  const profile = "debug";
  const target = "aarch64-apple-darwin";
  const suffix = "";
  const dirs = { workspaceRoot, stagingDir };

  assert.equal(needsRebuild(profile, target, suffix, dirs), true);

  const sourceDir = join(workspaceRoot, "target", profile);
  mkdirSync(sourceDir, { recursive: true });
  writeFileSync(profileMarkerPath(target, stagingDir), `${profile}\n`);

  for (const binName of ["vtb", "vtb-daemon", "vtb-gate"]) {
    const src = join(sourceDir, binName);
    const dst = stagedPath(binName, target, suffix, stagingDir);
    writeFileSync(src, "source");
    writeFileSync(dst, "staged");
    utimesSync(src, new Date(1000), new Date(1000));
    utimesSync(dst, new Date(2000), new Date(2000));
  }
  assert.equal(needsRebuild(profile, target, suffix, dirs), false);

  const staleDst = stagedPath("vtb", target, suffix, stagingDir);
  utimesSync(staleDst, new Date(500), new Date(500));
  assert.equal(needsRebuild(profile, target, suffix, dirs), true);

  for (const binName of ["vtb", "vtb-daemon", "vtb-gate"]) {
    const dst = stagedPath(binName, target, suffix, stagingDir);
    utimesSync(dst, new Date(2000), new Date(2000));
  }
  writeFileSync(profileMarkerPath(target, stagingDir), "release\n");
  assert.equal(needsRebuild(profile, target, suffix, dirs), true);
});
