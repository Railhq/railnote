import type { BlockRenderer, Cleanup, Command, EmbedRenderer, PluginModule, Railnote } from "./api";

/** What the app lends the plugin host. Installed once a vault is open. */
export interface AppBridge {
  resolve(src: string): Promise<string>;
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<void>;
  notes(): string[];
  activeNote(): string | null;
  open(path: string): void;
  openFile(path: string): void;
  insertText(text: string, cursor?: number): void;
  notice(message: string): void;
}

interface Owned<T> {
  plugin: string;
  name: string;
  fn: T;
}

/** Holds what each loaded plugin registered, so turning one off removes exactly its parts. */
class PluginHost {
  readonly blocks = new Map<string, Owned<BlockRenderer>>();
  readonly embeds = new Map<string, Owned<EmbedRenderer>>();
  readonly commands: (Command & { plugin: string })[] = [];
  /** Bumped on every load or unload; editors redraw their blocks when it changes. */
  version = 0;
  private cleanups = new Map<string, Cleanup[]>();
  private listeners = new Set<() => void>();
  // Blocks can start rendering before the app installs its bridge; they wait for it.
  private installBridge!: (b: AppBridge) => void;
  private bridgeReady = new Promise<AppBridge>((r) => (this.installBridge = r));
  private bridge: AppBridge | null = null;

  setBridge(b: AppBridge) {
    this.bridge = b;
    this.installBridge(b);
    this.bridgeReady = Promise.resolve(b);
  }

  app(): Promise<AppBridge> {
    return this.bridgeReady;
  }

  ids() {
    return [...this.cleanups.keys()];
  }

  loaded(id: string) {
    return this.cleanups.has(id);
  }

  async load(id: string, name: string, mod: PluginModule) {
    if (this.loaded(id)) this.unload(id);
    this.cleanups.set(id, []);
    const host = this;
    const rn: Railnote = {
      id,
      registerBlock(lang, render) {
        host.blocks.set(lang.toLowerCase(), { plugin: id, name, fn: render });
      },
      registerEmbed(extensions, render) {
        for (const ext of extensions) host.embeds.set(ext.replace(/^\./, "").toLowerCase(), { plugin: id, name, fn: render });
      },
      addCommand(command) {
        host.commands.push({ ...command, id: `${id}:${command.id}`, plugin: id });
      },
      onUnload(fn) {
        host.cleanups.get(id)?.push(fn);
      },
      vault: {
        read: async (src) => {
          const b = await host.app();
          return b.read(await b.resolve(src));
        },
        resolve: async (src) => (await host.app()).resolve(src),
        write: async (path, content) => (await host.app()).write(path, content),
        notes: () => host.bridge?.notes() ?? [],
      },
      workspace: {
        activeNote: () => host.bridge?.activeNote() ?? null,
        open: (path) => host.bridge?.open(path),
        insertText: (text, cursor) => host.bridge?.insertText(text, cursor),
      },
      notice: (message) => host.bridge?.notice(message),
    };
    try {
      await mod.activate(rn);
    } catch (e) {
      this.unload(id);
      throw e;
    }
    this.changed();
  }

  unload(id: string) {
    for (const fn of this.cleanups.get(id) ?? []) {
      try {
        fn();
      } catch (e) {
        console.error(`plugin ${id} cleanup`, e);
      }
    }
    this.cleanups.delete(id);
    for (const map of [this.blocks, this.embeds] as Map<string, Owned<unknown>>[]) for (const [k, v] of map) if (v.plugin === id) map.delete(k);
    for (let i = this.commands.length - 1; i >= 0; i--) if (this.commands[i].plugin === id) this.commands.splice(i, 1);
    this.changed();
  }

  unloadAll() {
    for (const id of [...this.cleanups.keys()]) this.unload(id);
  }

  subscribe(fn: () => void) {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  private changed() {
    this.version++;
    for (const fn of this.listeners) fn();
  }
}

export const plugins = new PluginHost();
