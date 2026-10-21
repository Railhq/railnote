// Types shared by the Electron main process and the renderer.

export interface NoteFile {
  /** Vault-relative POSIX path, e.g. "Notes/Caching.md". */
  path: string;
  content: string;
  mtime: number;
}

export type VaultEvent =
  | { type: "upsert"; file: NoteFile }
  | { type: "delete"; path: string }
  /** An attachment (any file that isn't a note) appeared, changed or went away. */
  | { type: "file"; path: string; exists: boolean }
  | { type: "folder"; path: string; exists: boolean };

export interface VaultListing {
  /** Vault paths of every file that isn't a note. */
  files: string[];
  folders: string[];
}

export interface Settings {
  vaultPath?: string;
  recentVaults: string[];
  anthropicApiKey?: string;
  model: string;
  dailyFolder: string;
  inboxFolder: string;
  templatesFolder: string;
  /** Where pasted and dropped files go. "./" means next to the note. */
  attachmentsFolder?: string;
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
  /** Base64 contents of any vault file, for exports that inline images. */
  readBase64(path: string): Promise<string>;
  /** Attachments and folders; notes come from openVault. */
  listFiles(): Promise<VaultListing>;
  /** Saves bytes under a free name in `folder` and returns the vault path used. */
  saveAttachment(folder: string, name: string, bytes: Uint8Array): Promise<string>;
  mkdir(path: string): Promise<void>;
  /** Opens a vault file in the system's default app. */
  openInSystem(path: string): Promise<void>;
  revealInFinder(path: string): Promise<void>;
  /** Asks where to save, then writes `content` there. False if the user cancelled. */
  saveExport(defaultName: string, kind: "html" | "pdf", html: string): Promise<boolean>;
  /** Vault path of the first file with this name anywhere in the vault, for ![[embeds]]. */
  findByName(name: string): Promise<string | null>;
  /** Plugins installed in the open vault's .railnote/plugins folder. */
  listVaultPlugins(): Promise<PluginManifest[]>;
  onVaultEvent(cb: (e: VaultEvent) => void): () => void;
  /** Menu items the renderer acts on, such as "close-tab". */
  onMenuCommand(cb: (cmd: string) => void): () => void;
  ask(id: string, question: string, sources: AskSource[]): Promise<void>;
  onAskEvent(cb: (e: { id: string; delta?: string; done?: boolean; error?: string }) => void): () => void;
  organize(req: OrganizeRequest): Promise<OrganizeSuggestion>;
  openExternal(url: string): Promise<void>;
}
