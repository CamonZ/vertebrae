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

export default defineConfig(({ mode }) => ({
  configFile: false,
  root: guiRoot,
  logLevel: "warn",
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  esbuild: { jsx: "automatic", legalComments: "none" },
  // The freshness test inspects Rollup's complete graph, including modules
  // removed by tree shaking, so presentation imports cannot silently return.
  plugins:
    mode === "module-graph"
      ? [
          {
            name: "validator-module-graph",
            generateBundle() {
              this.emitFile({
                type: "asset",
                fileName: "modules.json",
                source: JSON.stringify([...this.getModuleIds()].sort()),
              });
            },
          },
        ]
      : [],
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
}));
