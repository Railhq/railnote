// The openCanviz player, compiled from its source in the app checkout (the `@opencanviz/player`
// alias in vite.config.ts): the renderer opencanviz.com and its MP4 export draw through, so a
// note plays what the site shows, scene transitions included.
// @ts-nocheck
import "./hands";
import { configureAssets } from "@opencanviz/player";

// The page CSP only allows fonts from the app itself, so the lettering faces are build assets
// rather than the package's own copies.
const fonts = import.meta.glob("@canviz-fonts/*.woff2", { eager: true, query: "?url", import: "default" });
const fontUrls = Object.fromEntries(Object.entries(fonts).map(([f, url]) => [f.replace(/^.*\//, ""), url as string]));
configureAssets({ fontUrl: (file) => fontUrls[file] });

export { createPlayer, buildProjectTimeline, toProject } from "@opencanviz/player";
export const available = true;
