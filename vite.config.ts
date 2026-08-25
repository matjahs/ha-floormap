import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
    minify: "esbuild",
    sourcemap: true,
    rollupOptions: {
      input: resolve(__dirname, "src/card.ts"),
      // Keep shared code out of the entry. Chunks must not import from
      // sunflow-floorplan-card.js — Lovelace loads it with ?v= cache busting,
      // which makes ../sunflow-floorplan-card.js a different (often stale)
      // module instance and breaks named re-exports ("export named 'q'").
      preserveEntrySignatures: false,
      output: {
        format: "es",
        entryFileNames: "sunflow-floorplan-card.js",
        chunkFileNames: "chunks/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
        manualChunks(id) {
          if (id.includes("node_modules/@babylonjs/loaders")) {
            return "babylon-loaders";
          }
          if (id.includes("node_modules/@babylonjs/core")) {
            return "babylon-core";
          }
          if (id.includes("node_modules/three/build/three.webgpu") || id.includes("three/webgpu")) {
            return "three-webgpu";
          }
          if (!id.includes("node_modules/three")) {
            return undefined;
          }
          if (id.includes("GLTFLoader")) {
            return "GLTFLoader";
          }
          return "three";
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
