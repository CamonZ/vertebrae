#!/usr/bin/env node

// Create the static manifest consumed by tauri-plugin-updater. GUI bundles
// are signed by Tauri; the signature files are opaque and must be published
// byte-for-byte alongside the matching archive.

import { readFileSync, writeFileSync } from "node:fs";

const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const argument = process.argv[index];
  if (!argument.startsWith("--")) throw new Error(`unexpected argument: ${argument}`);
  args.set(argument.slice(2), process.argv[++index]);
}

const version = args.get("version");
const baseUrl = args.get("base-url")?.replace(/\/$/, "");
const output = args.get("output");
if (!version || !baseUrl || !output || !baseUrl.startsWith("https://")) {
  throw new Error("--version, --base-url (HTTPS), and --output are required");
}

const platforms = {};
for (const platform of ["darwin-aarch64", "darwin-x86_64", "linux-x86_64"]) {
  const artifact = args.get(`${platform}-artifact`);
  const signature = args.get(`${platform}-signature`);
  if (!artifact || !signature) continue;
  platforms[platform] = {
    url: `${baseUrl}/${artifact.split("/").pop()}`,
    signature: readFileSync(signature, "utf8").trim(),
  };
}

if (Object.keys(platforms).length === 0) {
  throw new Error("at least one signed GUI platform artifact is required");
}

writeFileSync(
  output,
  `${JSON.stringify({
    version,
    notes: `Vertebrae ${version}`,
    pub_date: new Date().toISOString(),
    platforms,
  }, null, 2)}\n`,
);
