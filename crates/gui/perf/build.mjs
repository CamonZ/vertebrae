import { build } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
const root = process.cwd();
await build({
  configFile: false,
  root,
  plugins: [
    react(),
    tailwindcss(),
    {
      name: "count-rich-work",
      enforce: "pre",
      transform(source, id) {
        if (!id.endsWith("/shared/MarkdownContent.tsx")) return;
        if (
          !source.includes(
            "function RenderedMarkdownContent({ text, projectPath }: MarkdownContentProps) {"
          )
        ) {
          throw new Error(
            "Rich-render instrumentation boundary changed; update this fixture."
          );
        }
        return source.replace(
          "function RenderedMarkdownContent({ text, projectPath }: MarkdownContentProps) {",
          "function RenderedMarkdownContent({ text, projectPath }: MarkdownContentProps) { globalThis.__richWork?.push(text);"
        );
      },
    },
  ],
  build: {
    outDir: process.env.PERF_OUT || "/tmp/vertebrae-markdown-perf",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        fixture: path.join(root, "perf/markdown-streaming.html"),
        mermaidRenderer: path.join(root, "mermaid-renderer.html"),
      },
    },
  },
});
