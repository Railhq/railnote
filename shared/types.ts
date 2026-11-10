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
  /** What answers Ask and Organize: a coding agent on this computer, or Claude through an API key. Unset means the first agent installed. */
  ai?: AiChoice;
  /** Whether the agent may create and edit notes from Ask. Off by default. */
  agentEdits?: boolean;
  /** Model passed to the agent; empty uses the agent's own default. */
  agentModel?: string;
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

export type AgentId = "claude" | "codex" | "opencode";
export type AiChoice = AgentId | "api";

export interface AgentInfo {
  id: AgentId;
  name: string;
  installed: boolean;
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

/** Where a saved version came from. */
export type VersionSource = "original" | "app" | "outside" | "synced" | "before-restore" | "restored" | "deleted";

/** Where sync stands for the open vault. The passphrase never comes back from the host. */
export interface SyncStatus {
  on: boolean;
  /** Through a Railnote sync server, or through a GitHub (or any git) repository. */
  via?: "server" | "github";
  /** What another device enters, with the passphrase, to join. */
  link?: string;
  /** The repository, when syncing through one. */
  remote?: string;
  state?: "idle" | "syncing" | "error";
  /** When the last round finished. */
  last?: number;
  error?: string;
}

export interface SyncSetup {
  /** The server, to start a new space as the first device. */
  server?: string;
  /** Or a link from a device already syncing, to join its space. */
  link?: string;
  passphrase: string;
}

export interface GitInfo {
  git: boolean;
  /** The GitHub CLI, signed in, so Railnote can make the repository. */
  gh: boolean;
  /** The vault's origin, if it's already a repository with one. */
  remote?: string;
}

/** One saved version of a note, kept in the vault's .railnote/history. */
export interface NoteVersion {
  id: string;
  time: number;
  source: VersionSource;
  /** Lines added and removed against the version before it. */
  added: number;
  removed: number;
}

/** Everything the renderer may ask of the host. A web or sync build implements the same interface. */
export interface HostApi {
  /** The desktop app, or the web build a phone installs. */
  kind: "desktop" | "phone";
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
  /** Base64 of a file the export player build shipped (player.js, hand pictures), or null without one. */
  exportAsset(name: string): Promise<string | null>;
  saveExport(defaultName: string, kind: "html" | "pdf", html: string): Promise<boolean>;
  /** Writes the agent skills that ship with the app into the vault's .claude/skills; returns the paths. */
  installAgentSkills(): Promise<string[]>;
  /** Vault path of the first file with this name anywhere in the vault, for ![[embeds]]. */
  findByName(name: string): Promise<string | null>;
  /** Plugins installed in the open vault's .railnote/plugins folder. */
  listVaultPlugins(): Promise<PluginManifest[]>;
  /** Saved versions of a note, newest first. */
  history(path: string): Promise<NoteVersion[]>;
  readVersion(path: string, id: string): Promise<string>;
  /** Puts a version back as the note's text, keeping the text it replaces as a version; returns the text. */
  restoreVersion(path: string, id: string): Promise<string>;
  syncStatus(): Promise<SyncStatus>;
  turnOnSync(setup: SyncSetup): Promise<SyncStatus>;
  turnOffSync(): Promise<SyncStatus>;
  /** Whether git and the GitHub CLI are installed, and the vault's repository if it has one. Computers only. */
  gitInfo(): Promise<GitInfo>;
  /** Syncs the vault through a repository: the one given, the vault's own, or a new private one made with gh. */
  turnOnGitSync(remote: string): Promise<SyncStatus>;
  syncNow(): Promise<SyncStatus>;
  /** Each change of sync status, with any conflict copies the round made. */
  onSyncEvent(cb: (e: { status: SyncStatus; conflicts?: string[] }) => void): () => void;
  onVaultEvent(cb: (e: VaultEvent) => void): () => void;
  /** Menu items the renderer acts on, such as "close-tab". */
  onMenuCommand(cb: (cmd: string) => void): () => void;
  ask(id: string, question: string, sources: AskSource[]): Promise<void>;
  onAskEvent(cb: (e: { id: string; delta?: string; done?: boolean; error?: string }) => void): () => void;
  organize(req: OrganizeRequest): Promise<OrganizeSuggestion>;
  /** Coding agents Railnote can use, and whether each is installed. None on the phone. */
  listAgents(): Promise<AgentInfo[]>;
  openExternal(url: string): Promise<void>;
}
