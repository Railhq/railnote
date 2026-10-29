const today = () => new Date().toISOString().slice(0, 10);

/** First-run layout: a vault that works with zero setup. */
export const STARTER_FILES: Record<string, () => string> = {
  "Welcome.md": () => `---
tags: [railnote]
---
# Welcome to Railnote

Plain Markdown files in a folder you own. No setup, no plugins to hunt for.

## What's built in
- **Daily notes**: Cmd+D opens today's note in [[Daily]].
- **Links**: type \`[[\` to link a note. Cmd+click a link to follow it. Notes that link here are listed at the end of the note.
- **Tasks**: every \`- [ ]\` in the vault shows up in the Tasks view.
- **Search**: Cmd+K jumps to a note, Cmd+Shift+F searches every note.
- **Inbox**: capture anything into Inbox/, then press **Organize** and Claude suggests a folder, tags and links.
- **Ask**: ask a question and get an answer from your own notes, with links to the notes it used.
- **Explainers**: an animated explainer plays inline from a \`\`\`canviz block.

## Your agents can use this vault too
Everything is a Markdown file, so Claude Code or any other agent can read and edit it. See [[AGENTS]].
Edits made outside the app show up live.

- [ ] Write your first note
- [ ] Try Cmd+K
`,
  "AGENTS.md": () => `# AGENTS.md

Instructions for AI agents working in this vault.

- Notes are Markdown. Link notes with \`[[Note name]]\`. Tags go in frontmatter \`tags: [a, b]\` or inline as #tag.
- New captures go in \`Inbox/\`. Daily notes live in \`Daily/YYYY-MM-DD.md\`.
- Tasks are \`- [ ] text\`. Mark done with \`- [x]\`.
- Explainers (animated openCanviz diagrams) are JSON in \`*.canviz\` files or \`\`\`canviz\` blocks. Before editing one, read \`.claude/skills/railnote-explainers/SKILL.md\`, and check your edit with \`node .claude/skills/railnote-explainers/check.mjs <file>\`.
- Don't touch \`.railnote/\` or \`.obsidian/\`.
`,
  "Inbox/.keep": () => "",
  "Notes/.keep": () => "",
  "Attachments/.keep": () => "",
  "Templates/Daily.md": () => `# {{date}}

## Plan
- [ ]

## Notes

`,
  [`Daily/${today()}.md`]: () => `# ${today()}

## Plan
- [ ] Explore [[Welcome]]

## Notes

`,
};
