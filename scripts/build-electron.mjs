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

// Exported notes carry the app's two typefaces inline; main hands them over from here.
import fs from "fs";
fs.mkdirSync("dist-electron/export-fonts", { recursive: true });
for (const f of [
  "node_modules/@fontsource-variable/literata/files/literata-latin-opsz-normal.woff2",
  "node_modules/@fontsource-variable/hanken-grotesk/files/hanken-grotesk-latin-wght-normal.woff2",
])
  fs.copyFileSync(f, `dist-electron/export-fonts/${f.replace(/^.*\//, "")}`);
