// The player for exported pages. Same package as the app's, but hand pictures come from the page
// itself (the exporter inlines the ones an explainer uses as window.__HAND_ASSET_URIS), and the
// page carries no fonts, so lettering falls back to the system's.
import { configureAssets } from "@opencanviz/player";

configureAssets({ fonts: false });

export { createPlayer, buildProjectTimeline, toProject, type ProjectRenderer } from "@opencanviz/player";
