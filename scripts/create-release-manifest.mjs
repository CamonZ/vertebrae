#!/usr/bin/env node

// Build the signed channel pointer for component update clients. Every
// component entry is signed independently, then the complete pointer is signed
// again.
// Artifact filenames include the version/build/target and are never reused.

import { createHash, createPrivateKey, sign } from "node:crypto";
import { readFileSync, statSync } from "node:fs";

const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const argument = process.argv[index];
  if (!argument.startsWith("--")) throw new Error(`unexpected argument: ${argument}`);
  args.set(argument.slice(2), process.argv[++index]);
}

const channel = args.get("channel");
const version = args.get("version");
const build = args.get("build");
const target = args.get("target");
const output = args.get("output");
const baseUrl = args.get("base-url");
const privateKey = process.env.VTB_UPDATE_PRIVATE_KEY;
const publicKey = process.env.VTB_UPDATE_PUBLIC_KEY;
if (!channel || !["master", "release"].includes(channel)) throw new Error("--channel must be master or release");
if (!version || !build || !target || !output || !baseUrl || !privateKey || !publicKey) {
  throw new Error("--version, --build, --target, --base-url, --output, VTB_UPDATE_PRIVATE_KEY, and VTB_UPDATE_PUBLIC_KEY are required");
}

const artifactNames = { cli: "vtb", daemon: "vtb-daemon", gate: "vtb-gate", gui: "gui" };

const components = {};
for (const [name, path] of [
  ["gui", args.get("gui")],
  ["cli", args.get("cli")],
  ["daemon", args.get("daemon")],
  ["gate", args.get("gate")],
]) {
  if (!path) continue;
  const bytes = readFileSync(path);
  const metadata = {
    version,
    build,
    target,
    url: `${baseUrl.replace(/\/$/, "")}/${artifactNames[name]}-${version}-${build}-${target}`,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: statSync(path).size,
    signature: "",
    public_key: publicKey,
  };
  metadata.signature = sign(null, Buffer.from(signaturePayload(name, metadata)), createPrivateKey(privateKey)).toString("base64");
  components[name] = metadata;
}

const manifest = {
  schema: 1,
  channel,
  generated_at: new Date().toISOString(),
  components,
  signature: null,
  public_key: publicKey,
};
manifest.signature = sign(null, Buffer.from(manifestPayload(manifest)), createPrivateKey(privateKey)).toString("base64");
await import("node:fs/promises").then(({ writeFile }) => writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`));

function signaturePayload(component, artifact) {
  return `vertebrae-artifact-v1\ncomponent=${component}\nversion=${artifact.version}\nbuild=${artifact.build}\ntarget=${artifact.target}\nurl=${artifact.url}\nsha256=${artifact.sha256}\nsize=${artifact.size}\n`;
}

function manifestPayload(value) {
  let payload = `vertebrae-manifest-v1\nschema=${value.schema}\nchannel=${value.channel}\ngenerated_at=${value.generated_at}\n`;
  for (const component of ["gui", "cli", "daemon", "gate"]) {
    const artifact = value.components[component];
    if (artifact) payload += signaturePayload(component, artifact);
  }
  return payload;
}
