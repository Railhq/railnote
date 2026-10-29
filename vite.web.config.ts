import { defineConfig, mergeConfig } from "vite";
import path from "path";
import base from "./vite.config";

// The phone build: the same app with src/web/host.ts standing in for Electron. The sync server
// serves dist-web (WEB=dist-web), so a phone opens the app from the address it syncs with.
export default mergeConfig(
  base,
  defineConfig({
    publicDir: "public-web",
    build: { outDir: "dist-web", emptyOutDir: true, rollupOptions: { input: { index: path.resolve("web.html") } } },
    plugins: [
      {
        name: "railnote-web-index",
        // web.html is the page; it's served as index.html.
        enforce: "post",
        generateBundle(_o, bundle) {
          const page = bundle["web.html"];
          if (page) {
            page.fileName = "index.html";
            delete bundle["web.html"];
            bundle["index.html"] = page;
          }
        },
      },
    ],
  }),
);
