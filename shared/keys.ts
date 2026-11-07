/** Shortcut labels are written the Mac way ("⇧⌘F"); elsewhere they read "Ctrl+Shift+F". */
const mac =
  typeof process !== "undefined" && process.platform
    ? process.platform === "darwin"
    : typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

export const keys = (s: string) =>
  mac ? s : s.replace(/([⇧⌥]*)⌘/g, (_, m: string) => `Ctrl+${m.replace(/⌥/g, "Alt+").replace(/⇧/g, "Shift+")}`);
