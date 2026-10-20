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
