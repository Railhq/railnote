// The surface every plugin gets, built-in or loaded from a vault. Plugins never import the app;
// everything they can do goes through the `Railnote` object passed to `activate`.

/** What a renderer is told about where it is drawing. */
export interface RenderInfo {
  /** Vault path of the note the block sits in. */
  notePath: string | null;
  /** Make the block's "Edit source" button open this file instead of revealing the block's text. */
  setEditFile(src: string): void;
  /** Call after the rendered content changes height. */
  requestMeasure(): void;
}

/** Runs when the block is torn down: the note closed, the cursor moved in, or the plugin unloaded. */
export type Cleanup = () => void;

/** Draws a ```lang fenced block into `el`. `source` is the text between the fences. */
export type BlockRenderer = (source: string, el: HTMLElement, info: RenderInfo) => void | Cleanup | Promise<void | Cleanup>;

/** Draws an ![[name.ext]] embed into `el`. `target` is the file name as written; read it with `vault.read`. */
export type EmbedRenderer = (target: string, el: HTMLElement, info: RenderInfo) => void | Cleanup | Promise<void | Cleanup>;

export interface BlockOptions {
  /**
   * The vault file a block draws from, when its data lives in a file of its own. The block redraws
   * whenever that file changes on disk, so an agent editing the file shows up live.
   */
  sourceFile?(source: string): string | null;
}

export interface Command {
  id: string;
  label: string;
  hint?: string;
  run(): void;
}

export interface Railnote {
  /** The plugin's id, as declared in its manifest. */
  readonly id: string;
  /** Render ```lang blocks. One plugin owns each language. */
  registerBlock(lang: string, render: BlockRenderer, options?: BlockOptions): void;
  /** Render ![[file.ext]] embeds for these extensions (without the dot). */
  registerEmbed(extensions: string[], render: EmbedRenderer): void;
  /** Add a command to the ⌘P palette. */
  addCommand(command: Command): void;
  /** Called when the plugin is turned off or reloaded. */
  onUnload(fn: Cleanup): void;
  vault: {
    /** Read a vault file. Accepts a path, a path relative to the open note, or a bare file name. */
    read(src: string): Promise<string>;
    /** Turn what a note wrote (path, relative path or bare name) into a vault path. */
    resolve(src: string): Promise<string>;
    write(path: string, content: string): Promise<void>;
    /** Every note, as vault paths. */
    notes(): string[];
  };
  workspace: {
    activeNote(): string | null;
    open(path: string): void;
    /** Insert at the cursor of the open note. The cursor ends at `cursor` characters into the text, or after it. */
    insertText(text: string, cursor?: number): void;
  };
  /** Show a short message at the bottom of the window. */
  notice(message: string): void;
}

/** What a plugin's main.js exports as default (or an `activate` function on its own). */
export interface PluginModule {
  activate(rn: Railnote): void | Promise<void>;
}

export interface BuiltinPlugin extends PluginModule {
  id: string;
  name: string;
  description: string;
}
