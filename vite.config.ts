import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import fs from "fs";
import os from "os";
import path from "path";

// Explainer playback compiles the openCanviz engine from its source checkout. Without one,
// canviz blocks render a notice instead and the rest of the app is unaffected.
const APP = process.env.OPENCANVIZ_APP || path.join(os.homedir(), "animated-diagram-editor-app");
const ENGINE = path.join(APP, "src/components/diagram");
const hasEngine = fs.existsSync(ENGINE);

export default defineConfig({
  base: "./",
  plugins: [react()],
  define: { "process.env.NODE_ENV": JSON.stringify(process.env.NODE_ENV ?? "production") },
  resolve: {
    alias: {
      "@canviz-engine": path.resolve(hasEngine ? "src/plugins/canviz/engine.ts" : "src/plugins/canviz/engine-missing.ts"),
      "@engine": ENGINE,
      "@canviz-hands": path.join(APP, "public/hands"),
      "lottie-web": path.resolve("src/plugins/canviz/stubs/lottie-web.ts"),
    },
  },
  server: { port: 5199, strictPort: true, fs: { allow: [".", APP] } },
  // Fonts stay files: the page CSP (default-src 'self') blocks data: fonts.
  build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 4000, assetsInlineLimit: (file) => (/\.woff2?$/.test(file) ? false : undefined) },
});
