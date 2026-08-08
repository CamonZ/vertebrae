#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function configureGuiRelease({ configPath, version, channelTag, repository }) {
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  if (!config.plugins?.updater) {
    throw new Error(`${configPath} does not define the Tauri updater plugin`);
  }

  config.version = version;
  config.plugins.updater.endpoints = [
    `https://github.com/${repository}/releases/download/${channelTag}/gui-latest.json`,
  ];
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

function main() {
  const configPath = process.argv[2] ?? "src-tauri/tauri.conf.json";
  const version = requiredEnv("UPDATE_VERSION");
  const channelTag = requiredEnv("UPDATE_CHANNEL_TAG");
  const repository = process.env.GITHUB_REPOSITORY ?? "CamonZ/vertebrae";
  configureGuiRelease({ configPath, version, channelTag, repository });
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
