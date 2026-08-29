/** Injected at build time via vite `define` (see vite.config.ts). */
declare const __SUNFLOW_REVISION__: string | undefined;

export const CARD_REVISION =
  typeof __SUNFLOW_REVISION__ === "string" && __SUNFLOW_REVISION__.length > 0
    ? __SUNFLOW_REVISION__
    : "dev";
