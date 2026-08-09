import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const scriptPath = fileURLToPath(new URL("./create-gui-update-manifest.mjs", import.meta.url));

test("publishes only supported GUI platforms", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vertebrae-gui-manifest-"));
  const aarch64SignaturePath = join(directory, "darwin-aarch64.sig");
  const linuxSignaturePath = join(directory, "linux-x86_64.sig");
  const outputPath = join(directory, "gui-latest.json");
  await writeFile(aarch64SignaturePath, "aarch64-signature\n");
  await writeFile(linuxSignaturePath, "linux-signature\n");

  try {
    const result = spawnSync(process.execPath, [
      scriptPath,
      "--version",
      "1.2.3",
      "--base-url",
      "https://github.com/CamonZ/vertebrae/releases/download/components-1.2.3",
      "--darwin-aarch64-artifact",
      "gui-assets/vertebrae-gui-darwin-aarch64.app.tar.gz",
      "--darwin-aarch64-signature",
      aarch64SignaturePath,
      "--darwin-x86_64-artifact",
      "gui-assets/vertebrae-gui-darwin-x86_64.app.tar.gz",
      "--darwin-x86_64-signature",
      aarch64SignaturePath,
      "--linux-x86_64-artifact",
      "gui-assets/vertebrae-gui-linux-x86_64.AppImage.tar.gz",
      "--linux-x86_64-signature",
      linuxSignaturePath,
      "--output",
      outputPath,
    ], { encoding: "utf8" });

    assert.equal(result.status, 0, result.stderr);
    const manifest = JSON.parse(await readFile(outputPath, "utf8"));
    assert.deepEqual(Object.keys(manifest.platforms), ["darwin-aarch64", "linux-x86_64"]);
    assert.equal(manifest.platforms["darwin-aarch64"].signature, "aarch64-signature");
    assert.equal(manifest.platforms["linux-x86_64"].signature, "linux-signature");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
