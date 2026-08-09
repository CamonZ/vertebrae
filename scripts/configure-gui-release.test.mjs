import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { configureGuiRelease } from "./configure-gui-release.mjs";

const PUBLIC_KEY =
  "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDhDQTU0NTA5RjQyRUExRTgKUldUb29TNzBDVVdsakovVlVLUFBDR1dCejRrMVdHTG5DSm1nS0lQdDU1K2dFd1BnK0RSbmRaZDgK";

test("writes the GUI version and channel updater endpoint", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vertebrae-gui-release-"));
  const configPath = join(directory, "tauri.conf.json");
  await writeFile(
    configPath,
    JSON.stringify({
      version: "0.1.0",
      plugins: {
        updater: { endpoints: ["old-endpoint"], pubkey: "old-public-key" },
      },
    }),
  );

  try {
    configureGuiRelease({
      configPath,
      version: "1.2.3",
      channelTag: "channel-release",
      repository: "CamonZ/vertebrae",
      publicKey: PUBLIC_KEY,
    });

    assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), {
      version: "1.2.3",
      plugins: {
        updater: {
          endpoints: [
            "https://github.com/CamonZ/vertebrae/releases/download/channel-release/gui-latest.json",
          ],
          pubkey: PUBLIC_KEY,
        },
      },
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects a public key that is not a Tauri .pub file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vertebrae-gui-release-"));
  const configPath = join(directory, "tauri.conf.json");
  await writeFile(
    configPath,
    JSON.stringify({ plugins: { updater: {} } }),
  );

  try {
    assert.throws(
      () =>
        configureGuiRelease({
          configPath,
          version: "1.2.3",
          channelTag: "channel-release",
          repository: "CamonZ/vertebrae",
          publicKey: "KNJ74Hpuj6F8E2sh/JTsLP1Pgc4PXlo8yaIcdsI8onc=",
        }),
      /TAURI_UPDATE_PUBLIC_KEY must decode to a UTF-8 minisign public key/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
