# Railnote

Open-source Markdown notes that work the moment you open them.

Railnote keeps the part of Obsidian people love (a folder of plain `.md` files you own) and fixes the parts they complain about: the setup, the plugin hunt, the filing paralysis, and the missing AI. It opens an existing Obsidian vault as is.

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
- **The sidebar folds** to a slim rail by default, so the page has the window. Point at the folder lines to peek at every note; ⇧⌘\\ keeps it open.

## Plugins

A plugin claims a code-block language or a file type, and Railnote hands it an element to draw into. It can also add commands to the ⌘P palette and read and write vault files. The whole API is in [`src/plugins/api.ts`](src/plugins/api.ts).

**Explainers** is the built-in plugin: a ```` ```canviz ```` block or `![[file.canviz]]` embed plays an animated openCanviz explainer inline, and "Edit source" opens the `.canviz` file (needs the openCanviz engine checkout at build time; without it the block shows a notice). It can be switched off in Settings.

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
| ⌘J | Ask your notes |
| ⌘\\ | Split the view in two |
| ⇧⌘\\ | Fold or keep open the sidebar |
| ⌘1…9, Ctrl+Tab | Pick or step through the stops on the route |
| ⌥⌘G | Graph view |
| ⌥⌘P | Export to PDF |
| ⌘, | Settings |

## Claude

Set an Anthropic API key in Settings (or `ANTHROPIC_API_KEY`). The key is stored in the app's data folder with owner-only permissions and never reaches the page. The default model is `claude-opus-5-5`, changeable in Settings. Requests enable the API's server-side fallback, so a request the primary model declines can be retried by a fallback model.

## Develop

```bash
npm install
npm run dev     # Vite + Electron with reload
npm start       # production build, then run
```

Set `OPENCANVIZ_APP` to an openCanviz app checkout to build with explainer playback (defaults to `~/animated-diagram-editor-app`).

The renderer only talks to the host through the `HostApi` interface in `shared/types.ts`, so a web or sync build can supply its own host.

## License

MIT
