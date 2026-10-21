// A note's title is its opening `# heading`. Railnote has no separate title field.

import { parseFrontmatter } from "./parse";

export interface Title {
  text: string;
  /** 0-based line of the heading. */
  line: number;
}

/** The `# heading` that opens the note, after any frontmatter and blank lines. */
export function leadingTitle(content: string): Title | null {
  const { end } = parseFrontmatter(content);
  // Only the top of the note matters; long notes shouldn't be split on every keystroke.
  const lines = content.slice(0, end + 4000).split("\n");
  let i = end ? content.slice(0, end).split("\n").length - 1 : 0;
  while (i < lines.length && !lines[i].trim()) i++;
  const m = /^#\s+(.+?)\s*#*\s*$/.exec(lines[i] ?? "");
  return m ? { text: m[1].trim(), line: i } : null;
}

/** Puts `# text` at the top of the note's body, below any frontmatter. */
export function withTitle(content: string, text: string): string {
  const { end } = parseFrontmatter(content);
  const head = content.slice(0, end);
  const body = content.slice(end).replace(/^\s*\n/, "");
  return `${head}# ${text}\n\n${body}`;
}
