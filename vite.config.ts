import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

// Explainers play through @opencanviz/player from npm. Its fonts and hand pictures become build
// assets, since the page is file:// and its CSP only allows the app's own files.
const ASSETS = path.resolve("node_modules/@opencanviz/player/dist/assets");

export default defineConfig({
  base: "./",
  plugins: [react()],
  define: { "process.env.NODE_ENV": JSON.stringify(process.env.NODE_ENV ?? "production") },
  resolve: {
    alias: {
      "@canviz-engine": path.resolve("src/plugins/canviz/engine.ts"),
      "@canviz-fonts": path.join(ASSETS, "fonts"),
      "@canviz-hands": path.join(ASSETS, "hands"),
    },
  },
  server: { port: 5199, strictPort: true },
  // Fonts stay files: the page CSP (default-src 'self') blocks data: fonts.
  build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 4000, assetsInlineLimit: (file) => (/\.woff2?$/.test(file) ? false : undefined) },
});
