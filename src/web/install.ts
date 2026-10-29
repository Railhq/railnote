// Runs before the app's modules: they read window.railnote as they load.
import { webHost } from "./host";

(window as any).railnote = webHost;

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch((e) => console.warn("No offline support:", e));
}
