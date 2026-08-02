/**
 * Floorplanner FML adapter — feature-flagged stub.
 *
 * FML (`GET /projects/:id.fml`) is gated behind enterprise/partner API access.
 * No public sample schema is available in this repo, so this module deliberately
 * does not guess field names. Enable with `SUNFLOW_FML=1` / config flag only.
 */

import { emptyIR, type FloorplanIR } from "./ir";

export const FML_FEATURE_FLAG = "SUNFLOW_FML";

export function isFmlEnabled(): boolean {
  if (typeof process !== "undefined" && process.env?.[FML_FEATURE_FLAG] === "1") {
    return true;
  }
  return false;
}

export function importFml(_raw: string, fileName = "project.fml"): FloorplanIR {
  if (!isFmlEnabled()) {
    throw new Error(
      "Floorplanner FML import is disabled (feature flag SUNFLOW_FML). " +
        "No verified FML sample is bundled; provide one before enabling.",
    );
  }
  // Stub: return empty IR with source tagging when flag is on.
  const ir = emptyIR("floorplanner-fml", fileName);
  return ir;
}
