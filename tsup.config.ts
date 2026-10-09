import { defineConfig } from "tsup"

export default defineConfig({
  entry: { index: "src/index.ts", contract: "src/contract/index.ts" },
  format: ["esm"],
  target: "node20",
  dts: true,
  clean: true,
  sourcemap: true,
  // Shared chunks keep one copy of each class across entry points.
  splitting: true,
})
