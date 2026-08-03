import { defineConfig } from "vite";
import { resolve } from "node:path";

/**
 * Local playground for sunflow-floorplan-card.
 * - Serves `dev/index.html`
 * - Static assets from `dev/public` (run `npm run playground:sync` for HA overlays)
 *
 * Note: do not proxy `/local` to HA here. Vite's proxy runs before publicDir and
 * shadows local files (browser saw 404 while files existed under dev/public).
 * Point HA_PROXY only if you add an explicit overlay proxy later.
 */
export default defineConfig({
  root: resolve(__dirname, "dev"),
  publicDir: resolve(__dirname, "dev/public"),
  server: {
    port: 5173,
    open: true,
  },
  build: {
    outDir: resolve(__dirname, "dev-dist"),
    emptyOutDir: true,
  },
});
