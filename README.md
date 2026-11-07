# Railnote

Open-source Markdown notes that work the moment you open them.

Railnote keeps the part of Obsidian people love (a folder of plain `.md` files you own) and fixes the parts they complain about: the setup, the plugin hunt, the filing paralysis, and the missing AI. It opens an existing Obsidian vault as is.

Railnote is free and MIT licensed, with no account.

## Download

macOS 13 or later: get the `.dmg` for your Mac (Apple silicon `arm64`, or Intel `x64`) from [Releases](https://github.com/Railhq/railnote/releases), open it and drag Railnote into Applications. It updates itself from new releases.

## What it fixes

| Common complaint | What Railnote does |
|---|---|
| Hours of setup and plugin hunting before it's useful | One click creates a starter vault with an inbox, daily notes, templates and a welcome note. Daily notes, tasks, templates, search, backlinks and an outline are built in. |
| "Where does this note go?" | New notes land in `Inbox/`. **Organize** asks Claude for a folder, tags and related notes; you tick what to apply. |
| No built-in AI | **Ask** answers questions from your own notes and cites them as `[[links]]`. Search runs locally; only the best-matching passages are sent. |
| Tasks scattered across notes | The **Tasks** view collects every `- [ ]` in the vault. Ticking one edits the file. |
| Sharing a note means sharing the app | **Export to HTML** makes one self-contained page with pictures, fonts, diagrams and playing explainers inside it. **Export to PDF** prints the same page, explainers shown at their last frame. |
| The graph is a hairball | **Graph** draws the vault as a transit map: each top-level folder is a line, each note a station on a grid, and notes linked across folders are interchanges. Point at a station to see its links; narrow to the notes 1 to 3 links from the one you're on. **Web** switches to a free-floating layout. |
| Lock-in, agents, open source | Plain Markdown, Obsidian syntax (wikilinks, aliases, embeds, frontmatter, `#tags`), `.obsidian/` ignored, edits made by other apps or agents appear live, MIT licensed. Renames rewrite links across the vault. Deletes go to `.trash/`. |

## How it moves

- **Today** is where a vault opens: today's note, what's waiting in the inbox, open tasks, the notes you were in, and the route from last time to step back onto.
- **The route** replaces tabs. The notes you open line up as stops on a line across the top, coloured by folder, with the one you're on lit. Opening a note adds the next stop; ⌘-click adds it without leaving.
- **The page** has one title: the note's first heading, which is also its file name. Headings show as stops in the margin, and the notes that link here are listed at the end of the note. ⌘J slides Ask up over the page.
- **History** keeps every note's saved versions in the vault, in `.railnote/history`: your edits, edits an agent or another app made, and the text before Railnote first touched it. They show as stops on a line, each compared with the note now, and any of them can be put back (⇧⌘H). Older versions thin out to one an hour, then one a day, then one a week.
- **The sidebar folds** to a slim rail by default, so the page has the window. Point at the folder lines to peek at every note; ⇧⌘\\ keeps it open.

## Sync and your phone

Sync keeps a vault the same on every computer and phone you use, through a small server: run your own (`server/sync-server.mjs`, plain Node, no dependencies) or use the free one at `https://sync.getrailhq.com`.

- **End-to-end encrypted.** Each device turns your passphrase into the keys, then encrypts every file and its name before it leaves. The server stores numbered, unreadable blobs: it knows how many files there are, how big they are and when they change, nothing else. Nobody can recover the passphrase, the server included.
- **Turning it on.** Settings, Sync: give the server's address and a passphrase. You get a sync link (`https://your-server#<space>`). On another computer, choose **Join from another device** and paste it.
- **On a phone.** Open the sync link in the phone's browser, enter the passphrase, and your notes come over. Add it to the home screen to use it like an app. The phone keeps the vault in its own storage and works offline; it syncs when you open it and while it's open.
- **Conflicts.** Edits on two devices to the same note while apart keep both: yours stays, and the other device's text sits beside it as `Note (conflict 2026-10-29).md`. An edit wins over a delete.
- **What stays local.** Version history is kept per computer (`.railnote/` never syncs). The phone has no version history or PDF export; Ask and Organize work there with an API key set on the phone (a computer uses your coding agent instead), which is then stored in the browser.

### Run a sync server

```bash
npm run build:web                    # the phone app, into dist-web/
PORT=8787 DATA=./sync-data WEB=./dist-web node server/sync-server.mjs
```

Put it behind HTTPS (Caddy, nginx): phones only install the app and keep it offline from a secure address. Settings: `CREATE_KEY` (only clients sending `X-Create-Key` may make new spaces), `MAX_FILE_MB` (70), `MAX_SPACE_MB` (2048), `MAX_SPACES` (1000), `CREATES_PER_DAY` per address (5), `TRUST_PROXY=1` behind a proxy that overwrites `X-Real-IP`. `DATA` is the only state; back it up like any folder. A `Dockerfile` for the server is in `server/`.

## Plugins

A plugin claims a code-block language or a file type, and Railnote hands it an element to draw into. It can also add commands to the ⌘P palette and read and write vault files. The whole API is in [`src/plugins/api.ts`](src/plugins/api.ts).

**Explainers** is the built-in plugin: a ```` ```canviz ```` block or `![[file.canviz]]` embed plays an animated openCanviz explainer inline, and "Edit source" opens the `.canviz` file (needs the openCanviz engine checkout at build time; without it the block shows a notice). It can be switched off in Settings. A file exported from opencanviz.com with several scenes plays them one after another.

### Explainers and coding agents

An explainer is JSON on disk, so Claude Code or any other agent running in the vault can change it. When the file is saved, the note redraws the explainer at the same moment of playback. A save that doesn't parse or doesn't add up (an edge to a node that doesn't exist, say) leaves the last version that played on screen, with the problem and its line and column written above it.

New vaults include an agent skill at `.claude/skills/railnote-explainers/`: `SKILL.md` covers where explainers live and how to edit one without breaking it, and `check.mjs` runs the app's own checks from the command line (`node .claude/skills/railnote-explainers/check.mjs Explainers/x.canviz`). `AGENTS.md` points agents at it. To add or update it in an existing vault, run "Teach agents to edit explainers" from the ⌘P palette. For writing new explainers from scratch, the full openCanviz authoring skill is `npx skills add opencanviz/opencanviz-skills-repo`.

Your own plugins live in the vault, one folder each:

```
<vault>/.railnote/plugins/progress/
  manifest.json   {"id": "progress", "name": "Progress bars", "version": "1.0.0"}
  main.js         export default { activate(railnote) { ... } }
```

```js
export default {
  activate(railnote) {
    railnote.registerBlock("progress", (source, el) => { el.textContent = source; });
    railnote.registerEmbed(["csv"], async (file, el) => { el.textContent = await railnote.vault.read(file); });
    railnote.addCommand({ id: "hello", label: "Say hello", run: () => railnote.notice("Hello") });
  },
};
```

A renderer may return a cleanup function, which runs when the block leaves the screen or the plugin is switched off. If a plugin throws, its error shows in Settings and the rest of the app carries on.

Vault plugins are off until you allow them: Settings, Plugins, **Allow plugins in this vault**, then switch each one on. They run with the same access as Railnote, so only allow code you wrote or trust. A working example is in [`examples/plugins/progress`](examples/plugins/progress).

## Keys

| Key | Action |
|---|---|
| ⌘K | Jump to a note, or create one |
| ⌘P | Command palette |
| ⌘N | New note in Inbox |
| ⌘D | Today's note |
| ⌘T | Insert template |
| ⇧⌘F | Search all notes |
| ⇧⌘O | Organize this note |
| ⇧⌘H | Version history of this note |
| ⌘J | Ask your notes |
| ⌘\\ | Split the view in two |
| ⇧⌘\\ | Fold or keep open the sidebar |
| ⌘1…9, Ctrl+Tab | Pick or step through the stops on the route |
| ⌥⌘G | Graph view |
| ⌥⌘P | Export to PDF |
| ⌘, | Settings |

## AI: your coding agent, or an API key

On a computer, Ask and Organize run through a coding agent you already use: **Claude Code**, **Codex** or **OpenCode**. Railnote runs the agent's command line in the vault folder, the agent searches and reads the notes itself, and it bills your existing plan, so no API key is needed. Out of the box Railnote uses the first one it finds on your login shell's `PATH` (in that order); pick another in Settings (⌘,).

- **Read-only by default.** Claude Code gets only its Read, Grep and Glob tools, Codex runs with `--sandbox read-only` and OpenCode with its `plan` agent.
- **Let it edit.** With "Let the agent create and edit notes" on in Settings, you can ask it to write or change notes ("add a summary to the caching note"). Claude Code may then use Edit and Write, Codex runs with `--sandbox workspace-write`, and OpenCode runs with its default agent. Version history keeps what it replaced, so any change can be undone.
- Agent sessions aren't saved to the agent's history, and Claude Code loads no MCP servers. An answer that takes longer than five minutes is stopped.

The phone can't run an agent, so there Ask and Organize use an API key.

### With an API key

Choose "Claude with an API key" in Settings and set the key (or `ANTHROPIC_API_KEY`). Only the passages Railnote's own search picks are sent. On a computer the key is stored in the app's data folder with owner-only permissions and never reaches the page. The default model is `claude-opus-5-5`, changeable in Settings. Requests enable the API's server-side fallback, so a request the primary model declines can be retried by a fallback model.

## Develop

```bash
npm install
npm run dev     # Vite + Electron with reload
npm start       # production build, then run
npm run package       # Railnote.app in release/, with its name and icon
npm run release:mac   # the release downloads: a .dmg and an update .zip for arm64 and x64
npm run build:web     # the phone app (src/web/host.ts stands in for Electron)
npm run sync-server   # a local sync server on :8787
```

Explainers play through [`@opencanviz/player`](https://www.npmjs.com/package/@opencanviz/player) from npm.

The renderer only talks to the host through the `HostApi` interface in `shared/types.ts`. The desktop host is the Electron preload; the phone host is `src/web/host.ts`, which keeps the vault in IndexedDB. Both sync through `shared/sync.ts`.

A signed, notarized release needs a Developer ID Application certificate in the keychain and, when running `release:mac`, `APPLE_SIGN_IDENTITY` set to it and `APPLE_KEYCHAIN_PROFILE` set to a profile saved with `xcrun notarytool store-credentials`. Upload the `.dmg` and `.zip` files to a GitHub release named for the version (`v0.1.0`); installed apps find it through update.electronjs.org.

## License

MIT
