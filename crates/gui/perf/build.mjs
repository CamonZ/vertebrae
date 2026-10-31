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
        if (id.endsWith("/shared/CodeSnippet.tsx")) {
          const entry =
            "export default function CodeSnippet({ language, source }: CodeSnippetProps) {";
          if (!source.includes(entry))
            throw new Error(
              "Snippet instrumentation boundary changed; update this fixture."
            );
          return source.replace(
            entry,
            `${entry} globalThis.__snippetRenders = (globalThis.__snippetRenders ?? 0) + 1;`
          );
        }
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
  // Match the app: Pierre's highlight worker lazy-loads grammars.
  worker: { format: "es" },
  build: {
    outDir: process.env.PERF_OUT || "/tmp/vertebrae-markdown-perf",
    emptyOutDir: true,
    // PERF_MINIFY=0 keeps function names readable in CPU profiles.
    minify: process.env.PERF_MINIFY !== "0",
    rollupOptions: {
      input: {
        fixture: path.join(root, "perf/markdown-streaming.html"),
        longChat: path.join(root, "perf/long-chat.html"),
        mermaidRenderer: path.join(root, "mermaid-renderer.html"),
      },
    },
  },
});
