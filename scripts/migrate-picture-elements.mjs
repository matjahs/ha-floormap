#!/usr/bin/env node
/**
 * Migrate a picture-elements floorplan YAML to sunflow-floorplan-card config.
 * Usage: node scripts/migrate-picture-elements.mjs [path|-] [--ir ir.json]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

function usage() {
  console.error("Usage: migrate-picture-elements.mjs <file.yaml|-> [--ir ir.json] [--out out.yaml]");
  process.exit(1);
}

const args = process.argv.slice(2);
if (args.length === 0) {
  usage();
}

let inputPath = args[0];
let irPath;
let outPath;
for (let i = 1; i < args.length; i++) {
  if (args[i] === "--ir") {
    irPath = args[++i];
  } else if (args[i] === "--out") {
    outPath = args[++i];
  }
}

const raw = inputPath === "-" ? readFileSync(0, "utf8") : readFileSync(inputPath, "utf8");
const doc = parseYaml(raw);

function findPictureElements(node, acc = []) {
  if (!node || typeof node !== "object") {
    return acc;
  }
  if (Array.isArray(node)) {
    for (const n of node) {
      findPictureElements(n, acc);
    }
    return acc;
  }
  if (node.type === "picture-elements") {
    acc.push(node);
  }
  for (const v of Object.values(node)) {
    findPictureElements(v, acc);
  }
  return acc;
}

const cards = findPictureElements(doc);
if (cards.length === 0) {
  // Treat root as the card
  if (doc.type === "picture-elements") {
    cards.push(doc);
  }
}
if (cards.length === 0) {
  console.error("No picture-elements card found");
  process.exit(2);
}

const card = cards[0];
const elements = card.elements ?? [];
const images = elements.filter((e) => e.type === "image" && e.entity);
const icons = elements.filter((e) => e.type === "state-icon" && e.entity);

const entities = {};
const overrides = {};
const passes = [];
const dead = new Set(["light.kitchen_ledstrip_2", "light.livingroom_light_2"]);

for (const img of images) {
  const icon = icons.find((i) => i.entity === img.entity);
  const fixtureId = `migrated_${img.entity.replace(/\./g, "_")}`;
  const overlay = typeof img.image === "string" ? img.image.split("/").pop() : undefined;
  entities[fixtureId] = {
    entity: img.entity,
    overlay,
  };
  if (icon?.style) {
    const left = Number.parseFloat(String(icon.style.left ?? "").replace("%", ""));
    const top = Number.parseFloat(String(icon.style.top ?? "").replace("%", ""));
    if (Number.isFinite(left) && Number.isFinite(top)) {
      overrides[fixtureId] = { marker: [left, top] };
    }
  }
  if (overlay) {
    passes.push({ fixtureId, path: overlay });
  }
}

let irNote = null;
if (irPath) {
  const ir = JSON.parse(readFileSync(irPath, "utf8"));
  irNote = {
    fixtures: ir.fixtures?.length,
    cameras: ir.cameras?.length,
  };
  // Cross-check projected vs hand markers would need projection module; report counts
}

const commentedDead = Object.entries(entities)
  .filter(([, v]) => dead.has(v.entity))
  .map(([id]) => id);

for (const id of commentedDead) {
  delete entities[id];
  delete overrides[id];
}

const out = {
  type: "custom:sunflow-floorplan-card",
  title: card.title ?? "Floorplan",
  manifest: "/local/floorplan/manifest.json",
  render: {
    mode: "baked",
    tone_map: "aces",
    exposure: 1.0,
    gamma: 2.2,
    transition: 400,
    ambient: "sun",
  },
  floors: [
    {
      level: "ground",
      camera: "stored_1",
      base_image: card.image,
    },
  ],
  entities,
  overrides,
  _migration: {
    base: card.image,
    passes,
    dead_entities_todo: [...dead],
    ir: irNote,
  },
};

const yamlOut = `# Migrated from picture-elements
# TODO: dead entities (do not enable until replaced):
# - light.kitchen_ledstrip_2
# - light.livingroom_light_2
${stringifyYaml(out)}`;

if (outPath) {
  writeFileSync(outPath, yamlOut);
} else {
  process.stdout.write(yamlOut);
}
