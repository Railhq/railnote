import { defineConfig } from "vite";
import path from "path";

// The standalone explainer player that exported notes carry inline. Hand pictures are copied
// beside it for the exporter to inline only the ones a note's explainers use.
export default defineConfig({
  publicDir: path.resolve("node_modules/@opencanviz/player/dist/assets/hands"),
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  resolve: {
    alias: {
      "@canviz-engine": path.resolve("src/export/engine.ts"),
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
