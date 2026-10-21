// Each top-level folder is a line with its own colour, the same in the sidebar, the route and the map.

import type { VaultIndex } from "./vault-index";

export const topFolder = (path: string) => (path.includes("/") ? path.slice(0, path.indexOf("/")) : "");

/** Top-level folders in sidebar order. */
export function folderLines(index: VaultIndex): string[] {
  const out = new Set<string>();
  for (const p of [...index.notes.keys(), ...index.files.keys()]) if (p.includes("/")) out.add(topFolder(p));
  return [...out].sort((a, b) => a.localeCompare(b));
}

/** The CSS colour of the line a note sits on; notes at the vault root share the root line. */
export function lineColour(lines: string[], path: string): string {
  const i = lines.indexOf(topFolder(path));
  return i < 0 ? "var(--line-0)" : `var(--line-${(i % 4) + 1})`;
}
