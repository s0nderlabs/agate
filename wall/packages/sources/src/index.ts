// Pure exports only (safe anywhere): the pure API, the panel rules and the synthetic page renderers.
// The bun-only io layer (fetch, archive, replay) is "@agate/sources/io".
export type * from "./types.ts";
export * from "./pure/index.ts";
export { type ArchiveStats, buildPanel, CAP_WARN_SHARE, type DeployEntry, type PanelChoice, type PanelFlags } from "./panelTool.ts";
export { renderEcb, renderPage, type SynthGpu, type SynthOptions, type SynthPage, times } from "./synthetic.ts";
