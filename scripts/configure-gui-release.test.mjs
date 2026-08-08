import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { configureGuiRelease } from "./configure-gui-release.mjs";

test("writes the GUI version and channel updater endpoint", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vertebrae-gui-release-"));
  const configPath = join(directory, "tauri.conf.json");
  await writeFile(
    configPath,
    JSON.stringify({
      version: "0.1.0",
      plugins: { updater: { endpoints: ["old-endpoint"] } },
    }),
  );

  try {
    configureGuiRelease({
      configPath,
      version: "1.2.3",
      channelTag: "channel-release",
      repository: "CamonZ/vertebrae",
    });

    assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), {
      version: "1.2.3",
      plugins: {
        updater: {
          endpoints: [
            "https://github.com/CamonZ/vertebrae/releases/download/channel-release/gui-latest.json",
          ],
        },
      },
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
