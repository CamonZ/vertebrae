import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile, cp } from "node:fs/promises";
import { generateKeyPairSync } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const scriptsDirectory = fileURLToPath(new URL(".", import.meta.url));

test("publishes a Tauri Linux AppImage and keeps the GUI manifest compatible", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vertebrae-release-assets-"));
  const binDirectory = join(directory, "bin");
  const releaseInput = join(directory, "release-input");
  const logPath = join(directory, "gh.log");
  const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey
    .export({ type: "pkcs8", format: "pem" });

  try {
    await mkdir(binDirectory, { recursive: true });
    await mkdir(join(directory, "scripts"), { recursive: true });
    await mkdir(join(releaseInput, "gui-macos-26"), { recursive: true });
    await mkdir(join(releaseInput, "gui-ubuntu-22.04"), { recursive: true });
    await writeFile(
      join(binDirectory, "gh"),
      "#!/usr/bin/env bash\nprintf '%s\\n' \"$*\" >> \"$GH_LOG\"\n",
    );
    await chmod(join(binDirectory, "gh"), 0o755);

    await writeFile(join(releaseInput, "gui-macos-26", "Vertebrae_1.2.3_arm64.app.tar.gz"), "mac app");
    await writeFile(join(releaseInput, "gui-macos-26", "Vertebrae_1.2.3_arm64.app.tar.gz.sig"), "mac signature\n");
    await writeFile(join(releaseInput, "gui-ubuntu-22.04", "Vertebrae_1.2.3_amd64.AppImage"), "linux app");
    await writeFile(join(releaseInput, "gui-ubuntu-22.04", "Vertebrae_1.2.3_amd64.AppImage.sig"), "linux signature\n");

    for (const target of [
      "aarch64-apple-darwin",
      "aarch64-unknown-linux-gnu",
      "x86_64-unknown-linux-gnu",
    ]) {
      const targetDirectory = join(releaseInput, `binaries-${target}`);
      await mkdir(targetDirectory, { recursive: true });
      await writeFile(join(targetDirectory, `vtb-1.2.3-build-${target}`), "cli");
      await writeFile(join(targetDirectory, `vtb-daemon-1.2.3-build-${target}`), "daemon");
      await writeFile(join(targetDirectory, `vtb-gate-1.2.3-build-${target}`), "gate");
    }

    await runPublisher({
      cwd: directory,
      env: {
        GH_LOG: logPath,
        GH_TOKEN: "test-token",
        VTB_UPDATE_PRIVATE_KEY: privateKey,
        VTB_UPDATE_PUBLIC_KEY: "test-public-key",
        IMMUTABLE_RELEASE_TAG: "components-master-abcdef12",
        UPDATE_SHA: "abcdef1234567890abcdef1234567890abcdef12",
        UPDATE_CHANNEL: "master",
        CHANNEL_TAG: "channel-master",
        UPDATE_VERSION: "1.2.3",
        UPDATE_BUILD: "build",
        GITHUB_REPOSITORY: "CamonZ/vertebrae",
        PATH: `${binDirectory}:${process.env.PATH}`,
      },
    });

    assert.equal(
      await readFile(join(directory, "gui-assets/vertebrae-gui-linux-x86_64.AppImage"), "utf8"),
      "linux app",
    );
    assert.equal(
      await readFile(join(directory, "gui-assets/vertebrae-gui-linux-x86_64.AppImage.sig"), "utf8"),
      "linux signature\n",
    );
    assert.equal(
      await readFile(join(directory, "gui-assets/vertebrae-gui-darwin-aarch64.app.tar.gz"), "utf8"),
      "mac app",
    );

    const manifest = JSON.parse(await readFile(join(directory, "gui-assets/gui-latest.json"), "utf8"));
    assert.equal(
      manifest.platforms["linux-x86_64"].url,
      "https://github.com/CamonZ/vertebrae/releases/download/components-master-abcdef12/vertebrae-gui-linux-x86_64.AppImage",
    );
    assert.equal(manifest.platforms["linux-x86_64"].signature, "linux signature");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function runPublisher({ cwd, env }) {
  await Promise.all([
    cp(join(scriptsDirectory, "publish-release-assets.sh"), join(cwd, "scripts/publish-release-assets.sh"), { recursive: false }),
    cp(join(scriptsDirectory, "create-gui-update-manifest.mjs"), join(cwd, "scripts/create-gui-update-manifest.mjs"), { recursive: false }),
    cp(join(scriptsDirectory, "create-release-manifest.mjs"), join(cwd, "scripts/create-release-manifest.mjs"), { recursive: false }),
  ]);
  await chmod(join(cwd, "scripts/publish-release-assets.sh"), 0o755);

  const child = spawn("bash", ["scripts/publish-release-assets.sh"], {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  assert.equal(exitCode, 0, stderr);
}
