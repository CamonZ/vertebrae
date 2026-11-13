/**
 * Builds the standalone flow-spec validator that `vtb flow validate` embeds
 * and runs in QuickJS: one self-contained IIFE script defining
 * `globalThis.vtbValidateFlow`. Run with `npm run build:flow-validator`; the
 * output is committed so cargo builds stay npm-free, and
 * flowValidator.bundle.test.ts fails when it is stale.
 */
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const guiRoot = fileURLToPath(new URL(".", import.meta.url));
const flowDir = `${guiRoot}src/components/MachineDiagram/flow`;

export default defineConfig({
  configFile: false,
  root: guiRoot,
  logLevel: "warn",
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  esbuild: { jsx: "automatic", legalComments: "none" },
  plugins: [
    {
      // Evidence renderers pull in the app's query client, stores and Tauri
      // bindings; validation never renders, so swap in an empty table.
      name: "headless-attachment-renderers",
      enforce: "pre",
      resolveId(source, importer) {
        if (source === "./attachmentRenderers" && importer?.startsWith(flowDir))
          return `${flowDir}/headlessAttachmentRenderers.ts`;
        return null;
      },
    },
  ],
  build: {
    outDir: `${guiRoot}../cli/assets`,
    emptyOutDir: false,
    copyPublicDir: false,
    minify: true,
    target: "es2020",
    reportCompressedSize: false,
    lib: {
      entry: `${flowDir}/validatorEntry.ts`,
      formats: ["iife"],
      name: "vtbFlowValidator",
      fileName: () => "flow-validator.js",
    },
  },
});
