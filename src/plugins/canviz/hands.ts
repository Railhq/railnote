// The engine fetches hand drawings from its app's /hands route, which doesn't exist under file://.
// Ship them as build assets and point the engine at them through its bootstrap map. This must
// run before any engine module loads, since some start fetching hands as soon as they're imported.
const hands = import.meta.glob("@canviz-hands/*.png", { eager: true, query: "?url", import: "default" });
(globalThis as { __HAND_ASSET_URIS?: Record<string, string> }).__HAND_ASSET_URIS = Object.fromEntries(
  Object.entries(hands).map(([file, url]) => [file.replace(/^.*\//, ""), url as string]),
);
