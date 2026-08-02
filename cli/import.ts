import { mkdirSync, writeFileSync, readFileSync, existsSync, copyFileSync, readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { JSDOM } from "jsdom";
import { importSweetHome3D } from "../src/import/sweethome3d";

function usage(): never {
  console.log(`Usage:
  sunflow-floorplan import <file.sh3d|Home.xml> --out <dir> [--base <base.png>] [--passes-dir <dir>]`);
  process.exit(1);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] !== "import" || !args[1]) {
    usage();
  }
  const input = resolve(args[1]!);
  let outDir = "";
  let basePath: string | undefined;
  let passesDir: string | undefined;
  for (let i = 2; i < args.length; i++) {
    if (args[i] === "--out") {
      outDir = resolve(args[++i] ?? "");
    } else if (args[i] === "--base") {
      basePath = resolve(args[++i] ?? "");
    } else if (args[i] === "--passes-dir") {
      passesDir = resolve(args[++i] ?? "");
    }
  }
  if (!outDir) {
    usage();
  }

  const dom = new JSDOM("");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).DOMParser = dom.window.DOMParser;

  mkdirSync(outDir, { recursive: true });
  const buf = readFileSync(input);
  const ir = await importSweetHome3D(buf, basename(input));

  const renders: {
    base: string;
    passes: Array<{ fixtureId: string; path: string }>;
    differenceBaked: boolean;
  } = {
    base: "base.png",
    passes: [],
    differenceBaked: false,
  };

  if (basePath && existsSync(basePath)) {
    copyFileSync(basePath, join(outDir, "base.png"));
  }

  if (passesDir && existsSync(passesDir)) {
    for (const file of readdirSync(passesDir)) {
      if (!/\.(png|webp|avif|jpg)$/i.test(file)) {
        continue;
      }
      const stem = file.replace(/\.[^.]+$/, "");
      const fixture = ir.fixtures.find((f) => f.id === stem || f.name === stem);
      copyFileSync(join(passesDir, file), join(outDir, file));
      renders.passes.push({ fixtureId: fixture?.id ?? stem, path: file });
    }
  }

  const manifest = { ir, renders, mapping: {} as Record<string, string> };
  writeFileSync(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  writeFileSync(join(outDir, "ir.json"), JSON.stringify(ir, null, 2));
  console.log(`Wrote ${join(outDir, "manifest.json")} (${ir.fixtures.length} fixtures)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
