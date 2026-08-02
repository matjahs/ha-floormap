#!/usr/bin/env node
/**
 * Scaffold for regenerating base + per-fixture light passes.
 *
 * Headless SweetHome3D / SunFlow automation is environment-specific and often
 * impractical. This script documents the contract and can shell out to Blender
 * if BLENDER_BIN and an OBJ export are provided.
 *
 * Manual SweetHome3D fallback:
 * 1. Open the .sh3d, select the same stored camera used for your plate.
 * 2. Set fixed exposure / quality; disable all lights → render base.
 * 3. For each light: enable only that light → render pass PNG (same camera).
 * 4. Run: sunflow-floorplan import Home.sh3d --out www/floorplan --base base.png --passes-dir passes/
 */
console.log(`render-passes.mjs

Manual workflow (recommended):
  1. SweetHome3D → same stored camera, fixed exposure
  2. All lights off → base.png
  3. One light on per pass → passes/<fixtureId>.png
  4. sunflow-floorplan import Home.sh3d --out /config/www/floorplan \\
       --base base.png --passes-dir passes/

Optional Blender path (experimental):
  BLENDER_BIN=/path/to/blender OBJ=home.obj node scripts/render-passes.mjs --blender

No headless SunFlow driver is bundled (GPL / packaging constraints).`);

if (process.argv.includes("--blender")) {
  console.error("Blender driver not implemented yet; use the manual workflow.");
  process.exit(2);
}
