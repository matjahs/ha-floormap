import { defineConfig } from "vitest/config";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const pkg = JSON.parse(readFileSync(resolve(__dirname, "package.json"), "utf8")) as {
  version: string;
};
const sunflowRevision = process.env.SUNFLOW_REVISION?.trim() || pkg.version;

export default defineConfig({
  base: "./",
  define: {
    __SUNFLOW_REVISION__: JSON.stringify(sunflowRevision),
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
    minify: "esbuild",
    sourcemap: true,
    rollupOptions: {
      input: resolve(__dirname, "src/card.ts"),
      // Entry must only own the customElements.define side effect. Shared app
      // code goes in chunks/shared-*.js so async chunks never import
      // ../sunflow-floorplan-card.js (a second module URL under Lovelace path
      // aliases double-defines the card).
      preserveEntrySignatures: false,
      output: {
        format: "es",
        entryFileNames: "sunflow-floorplan-card.js",
        chunkFileNames: "chunks/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
        manualChunks(id) {
          const path = id.replace(/\\/g, "/");
          if (path.includes("node_modules/@babylonjs/loaders")) {
            return "babylon-loaders";
          }
          if (path.includes("node_modules/@babylonjs/core")) {
            return "babylon-core";
          }
          if (path.includes("node_modules/three/build/three.webgpu") || path.includes("three/webgpu")) {
            return "three-webgpu";
          }
          if (path.includes("node_modules/three")) {
            if (path.includes("GLTFLoader")) {
              return "GLTFLoader";
            }
            return "three";
          }
          if (path.includes("/src/") && !path.endsWith("/src/card.ts")) {
            return "shared";
          }
          return undefined;
        },
      },
    },
  },
  test: {
    globals: true,
    environment: "jsdom",
    include: ["tests/**/*.test.ts"],
  },
});
