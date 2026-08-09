#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function configureGuiRelease({
  configPath,
  version,
  channelTag,
  repository,
  publicKey,
}) {
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  if (!config.plugins?.updater) {
    throw new Error(`${configPath} does not define the Tauri updater plugin`);
  }

  config.version = version;
  config.plugins.updater.pubkey = validateTauriPublicKey(publicKey);
  config.plugins.updater.endpoints = [
    `https://github.com/${repository}/releases/download/${channelTag}/gui-latest.json`,
  ];
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

export function validateTauriPublicKey(publicKey) {
  if (typeof publicKey !== "string" || !publicKey.trim()) {
    throw new Error("TAURI_UPDATE_PUBLIC_KEY is required");
  }

  const normalized = publicKey.trim();
  if (
    normalized.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(normalized) ||
    Buffer.from(normalized, "base64").toString("base64") !== normalized
  ) {
    throw new Error("TAURI_UPDATE_PUBLIC_KEY must be valid base64");
  }

  let decoded;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.from(normalized, "base64"),
    );
  } catch {
    throw new Error(
      "TAURI_UPDATE_PUBLIC_KEY must decode to a UTF-8 minisign public key",
    );
  }

  if (!decoded.startsWith("untrusted comment: minisign public key:") || !decoded.includes("\n")) {
    throw new Error(
      "TAURI_UPDATE_PUBLIC_KEY must contain the base64-encoded Tauri .pub file",
    );
  }

  return normalized;
}

function main() {
  const configPath = process.argv[2] ?? "src-tauri/tauri.conf.json";
  const version = requiredEnv("UPDATE_VERSION");
  const channelTag = requiredEnv("UPDATE_CHANNEL_TAG");
  const publicKey = requiredEnv("TAURI_UPDATE_PUBLIC_KEY");
  const repository = process.env.GITHUB_REPOSITORY ?? "CamonZ/vertebrae";
  configureGuiRelease({
    configPath,
    version,
    channelTag,
    repository,
    publicKey,
  });
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
