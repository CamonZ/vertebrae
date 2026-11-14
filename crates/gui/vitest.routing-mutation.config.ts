import { defineConfig } from "vitest/config";
import base from "./vite.config";
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: [
      "src/components/MachineDiagram/route{,.bus}.test.ts",
      "src/components/MachineDiagram/flow/{lanePlanner.model,bus.model,crossings,routing,layout,portTopology.model}.test.{ts,tsx}",
    ],
    maxWorkers: 2,
  },
});
