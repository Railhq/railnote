import esbuild from "esbuild";

// Main and preload run in Node/Electron; the renderer is built by Vite.
await esbuild.build({
  entryPoints: { main: "electron/main.ts", preload: "electron/preload.ts" },
  outdir: "dist-electron",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  external: ["electron", "fsevents"],
  logLevel: "info",
});

// The agent skill each vault gets: its instructions plus a checker built from the app's own checks.
await esbuild.build({
  entryPoints: ["scripts/explainer-check.ts"],
  outfile: "dist-electron/skills/railnote-explainers/check.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  logLevel: "warning",
});
import fsSync from "fs";
fsSync.copyFileSync("skills/railnote-explainers/SKILL.md", "dist-electron/skills/railnote-explainers/SKILL.md");

// Exported notes carry the app's two typefaces inline; main hands them over from here.
import fs from "fs";
fs.mkdirSync("dist-electron/export-fonts", { recursive: true });
for (const f of [
  "node_modules/@fontsource-variable/literata/files/literata-latin-opsz-normal.woff2",
  "node_modules/@fontsource-variable/hanken-grotesk/files/hanken-grotesk-latin-wght-normal.woff2",
])
  fs.copyFileSync(f, `dist-electron/export-fonts/${f.replace(/^.*\//, "")}`);
