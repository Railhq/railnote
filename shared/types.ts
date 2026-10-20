// Types shared by the Electron main process and the renderer.

export interface NoteFile {
  /** Vault-relative POSIX path, e.g. "Notes/Caching.md". */
  path: string;
  content: string;
  mtime: number;
}

export type VaultEvent =
  | { type: "upsert"; file: NoteFile }
  | { type: "delete"; path: string };

export interface Settings {
  vaultPath?: string;
  recentVaults: string[];
  anthropicApiKey?: string;
  model: string;
  dailyFolder: string;
  inboxFolder: string;
  templatesFolder: string;
  /** Plugins switched on or off by id. Built-in plugins are on unless listed false; vault plugins are off unless listed true. */
  plugins?: Record<string, boolean>;
  /** Vaults whose own plugins may run. Code in a vault you didn't write could do anything Railnote can. */
  trustedVaults?: string[];
}

export interface AskSource {
  path: string;
  text: string;
}

export interface OrganizeRequest {
  path: string;
  content: string;
  folders: string[];
  tags: string[];
  noteNames: string[];
}

export interface OrganizeSuggestion {
  folder: string;
  tags: string[];
  links: { note: string; reason: string }[];
  summary: string;
}

/** .railnote/plugins/<id>/manifest.json */
export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  /** Entry file inside the plugin folder, an ES module. Defaults to main.js. */
  main?: string;
  /** Where Railnote loads the entry from; filled in by the host. */
  url?: string;
  /** Why the manifest couldn't be used, if it couldn't. */
  error?: string;
}

/** Everything the renderer may ask of the host. A web or sync build implements the same interface. */
export interface HostApi {
  getSettings(): Promise<Settings>;
  setSettings(patch: Partial<Settings>): Promise<Settings>;
  chooseVault(): Promise<string | null>;
  openVault(dir: string): Promise<NoteFile[]>;
  createVault(dir: string): Promise<NoteFile[]>;
  write(path: string, content: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
  readRaw(path: string): Promise<string>;
  /** Vault path of the first file with this name anywhere in the vault, for ![[embeds]]. */
  findByName(name: string): Promise<string | null>;
  /** Plugins installed in the open vault's .railnote/plugins folder. */
  listVaultPlugins(): Promise<PluginManifest[]>;
  onVaultEvent(cb: (e: VaultEvent) => void): () => void;
  ask(id: string, question: string, sources: AskSource[]): Promise<void>;
  onAskEvent(cb: (e: { id: string; delta?: string; done?: boolean; error?: string }) => void): () => void;
  organize(req: OrganizeRequest): Promise<OrganizeSuggestion>;
  openExternal(url: string): Promise<void>;
}
