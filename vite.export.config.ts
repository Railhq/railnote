import { defineConfig } from "vite";
import os from "os";
import path from "path";

// The standalone explainer player that exported notes carry inline. Hand pictures are copied
// beside it for the exporter to inline only the ones a note's explainers use.
const APP = process.env.OPENCANVIZ_APP || path.join(os.homedir(), "animated-diagram-editor-app");

export default defineConfig({
  publicDir: path.join(APP, "public/hands"),
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  resolve: {
    alias: {
      "@canviz-engine": path.resolve("src/export/engine.ts"),
      "@engine": path.join(APP, "src/components/diagram"),
      "lottie-web": path.resolve("src/plugins/canviz/stubs/lottie-web.ts"),
    },
  },
  build: {
    outDir: "dist-export",
    emptyOutDir: true,
    assetsInlineLimit: () => true,
    chunkSizeWarningLimit: 4000,
    lib: { entry: path.resolve("src/export/player-entry.ts"), formats: ["iife"], name: "RailnoteExplainers", fileName: () => "player.js" },
  },
});
