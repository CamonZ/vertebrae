/// <reference types="vitest" />
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const guiRoot = fileURLToPath(new URL(".", import.meta.url));

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Vite options tailored for Tauri development
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      // Tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
  // Pierre's diff highlight worker lazy-loads grammars, which needs ES workers.
  worker: {
    format: "es",
  },
  // The worker entry is only reachable through `new URL(..., import.meta.url)`,
  // which the dev dependency scan misses; discovering it at runtime triggers a
  // full page reload.
  optimizeDeps: {
    include: ["@pierre/diffs/worker/worker.js"],
  },
  build: {
    // Tauri expects the frontend to be in ../dist relative to src-tauri
    outDir: "dist",
    emptyDirFirst: true,
    rollupOptions: {
      input: {
        main: `${guiRoot}/index.html`,
        mermaidRenderer: `${guiRoot}/mermaid-renderer.html`,
      },
    },
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    // Stylesheets stay stubbed; `?raw` imports return the source so tests
    // can check rules that jsdom cannot cascade.
    css: { include: [/\.css\?raw$/] },
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      exclude: ["node_modules/", "src/test/", "src/bindings.ts", "**/*.d.ts"],
    },
  },
});
