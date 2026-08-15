import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const workflowPath = new URL("../.github/workflows/release.yml", import.meta.url);
const releaseAssetUrl =
  "https://github.com/${{ github.repository }}/releases/download/channel-master/latest-x86_64-unknown-linux-gnu.json";

test("fetches the master manifest through a release-asset redirect", async () => {
  const workflow = await readFile(workflowPath, "utf8");
  const fetchCommand = extractMasterManifestFetch(workflow);
  const { server, url } = await startRedirectServer();

  try {
    assert.ok(
      fetchCommand.split(/\s+/).includes("--location"),
      "the fetch command must follow release-asset redirects",
    );
    assert.ok(
      fetchCommand.includes(JSON.stringify(releaseAssetUrl)),
      "the fetch command must use the master release asset URL",
    );
    const redirectedCommand = fetchCommand.replace(
      JSON.stringify(releaseAssetUrl),
      JSON.stringify(url),
    );
    const { stdout } = await execFileAsync(
      "bash",
      ["-c", `set -euo pipefail\n${redirectedCommand}`],
      { encoding: "utf8" },
    );

    assert.equal(
      stdout,
      '{"components":{"gui":{"version":"0.1.0-build.18"}}}\n',
    );
  } finally {
    await closeServer(server);
  }
});

function extractMasterManifestFetch(workflow) {
  const step = workflow.match(
    /      - name: Read current master channel version\n[\s\S]*?(?=\n      - name:)/,
  )?.[0];
  assert.ok(step, "the release workflow must define the master manifest step");

  const command = step.match(
    /curl --fail[\s\S]*?latest-x86_64-unknown-linux-gnu\.json"/,
  )?.[0];
  assert.ok(command, "the master manifest step must fetch its release asset");

  return command.replace(/\\\s*/g, " ").replace(/\s+/g, " ").trim();
}

function startRedirectServer() {
  const server = createServer((request, response) => {
    if (request.url === "/asset") {
      response.writeHead(302, { Location: "/manifest" });
      response.end();
      return;
    }

    if (request.url === "/manifest") {
      response.end('{"components":{"gui":{"version":"0.1.0-build.18"}}}\n');
      return;
    }

    response.writeHead(404);
    response.end();
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("redirect test server did not receive a TCP address"));
        return;
      }
      resolve({ server, url: `http://127.0.0.1:${address.port}/asset` });
    });
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
