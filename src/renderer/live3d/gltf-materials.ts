import type { Material, MeshLambertMaterial } from "three";

/** glTF glass often uses transmission without transparent=true; Lambert needs explicit alpha. */
export function isGlassGltfMaterial(
  materialName: string,
  meshName: string,
  material: Material,
): boolean {
  const label = `${materialName} ${meshName}`.toLowerCase();
  if (/glass|glasstransparent|windowpane|door_glass/.test(label)) {
    return true;
  }
  const physical = material as import("three").MeshPhysicalMaterial;
  if (physical.isMeshPhysicalMaterial && (physical.transmission ?? 0) > 0.05) {
    return true;
  }
  const std = material as import("three").MeshStandardMaterial;
  if (std.isMeshStandardMaterial && std.transparent && std.opacity < 0.98) {
    return true;
  }
  return false;
}

export function glassLambertOpacity(material: Material): number {
  const physical = material as import("three").MeshPhysicalMaterial;
  if (physical.isMeshPhysicalMaterial && (physical.transmission ?? 0) > 0.05) {
    return Math.max(0.22, Math.min(0.5, 1 - physical.transmission * 0.75));
  }
  const std = material as import("three").MeshStandardMaterial;
  if (std.isMeshStandardMaterial && std.transparent && std.opacity < 1) {
    return std.opacity;
  }
  return 0.35;
}

/** Collapse glTF PBR materials so shadow shaders stay under MAX_TEXTURE_IMAGE_UNITS. */
export function simplifyGltfMaterial(
  material: Material,
  THREE: typeof import("three"),
  meshName = "",
): MeshLambertMaterial {
  const std = material as import("three").MeshStandardMaterial;
  const physical = material as import("three").MeshPhysicalMaterial;
  if (!std.isMeshStandardMaterial && !physical.isMeshPhysicalMaterial) {
    const lambert = material as import("three").MeshLambertMaterial;
    const basic = material as import("three").MeshBasicMaterial;
    if (lambert.isMeshLambertMaterial) {
      return lambert;
    }
    if (basic.isMeshBasicMaterial) {
      return new THREE.MeshLambertMaterial({
        color: basic.color,
        map: basic.map ?? null,
        transparent: material.transparent,
        opacity: material.opacity,
        side: material.side,
      });
    }
    return new THREE.MeshLambertMaterial({ color: 0xcccccc, side: material.side });
  }
  const src = std.isMeshStandardMaterial ? std : physical;
  const glass = isGlassGltfMaterial(material.name, meshName, material);
  const glassOpacity = glass ? glassLambertOpacity(material) : src.opacity;
  const simple = new THREE.MeshLambertMaterial({
    color: src.color?.clone?.() ?? new THREE.Color(0xcccccc),
    map: src.map ?? null,
    transparent: glass || src.transparent,
    opacity: glassOpacity,
    alphaTest: glass ? 0 : src.alphaTest,
    side: glass ? THREE.DoubleSide : src.side,
  });
  if (glass) {
    simple.depthWrite = false;
    simple.color.lerp(new THREE.Color(0xdce8f5), 0.55);
  }
  if (simple.map) {
    simple.map.colorSpace = THREE.SRGBColorSpace;
  }
  return simple;
}

export function isTransparentGlassMaterial(material: Material): boolean {
  const lambert = material as MeshLambertMaterial;
  return Boolean(lambert.transparent && lambert.opacity < 0.9);
}
