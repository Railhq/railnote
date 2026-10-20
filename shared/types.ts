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
  onVaultEvent(cb: (e: VaultEvent) => void): () => void;
  ask(id: string, question: string, sources: AskSource[]): Promise<void>;
  onAskEvent(cb: (e: { id: string; delta?: string; done?: boolean; error?: string }) => void): () => void;
  organize(req: OrganizeRequest): Promise<OrganizeSuggestion>;
  openExternal(url: string): Promise<void>;
}
