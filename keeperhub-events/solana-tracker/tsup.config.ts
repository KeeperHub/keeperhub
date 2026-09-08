import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node22",
  outDir: "dist",
  sourcemap: "inline",
  clean: true,
  splitting: false,
  dts: false,
  shims: false,
  skipNodeModulesBundle: true,
});
