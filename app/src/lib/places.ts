// The app's places and their paths, for the top bar, the phone dock and More (its own module, so the sheets can link
// to a place without importing the shell that imports them).
export const PLACES = { markets: "/app", positions: "/app/positions", index: "/app/gpu-index", docs: "/docs" } as const;
