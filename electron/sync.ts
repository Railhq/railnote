import { execFile } from "child_process";
import { createHash } from "crypto";
import fs from "fs/promises";
import path from "path";
import { RoundLoop, SyncLoop, type SyncConfig, type SyncState, type SyncStatus, type SyncStore } from "../shared/sync";
import type { GitInfo } from "../shared/types";
import { userPath, which } from "./agents";
import { gitFor, gitSyncOnce, setUpGitSync, shortRemote, type GitTools } from "./gitsync";
import { IGNORED, type Vault } from "./vault";

export { setUpSync } from "../shared/sync";

/** Keeps a vault on disk in sync. */
export const syncVault = (vault: Vault, cfg: SyncConfig, emit: (s: SyncStatus, conflicts?: string[]) => void) => new SyncLoop(new VaultStore(vault), cfg, emit);

let tools: Promise<GitTools | null> | undefined;
/** git, and gh when it's signed in. Looked up once; a missing git is looked for again next time. */
async function gitTools(): Promise<GitTools | null> {
  const found = await (tools ??= (async () => {
    const env = { ...process.env, PATH: await userPath() };
    const git = await which("git");
    // On a Mac without the developer tools, /usr/bin/git is a stub that only offers to install them.
    if (!git || !(await gitFor(process.cwd(), { git, env })(["--version"]).then(() => true, () => false))) return null;
    const gh = await which("gh");
    const signedIn = gh && (await new Promise<boolean>((r) => execFile(gh, ["auth", "token"], { env }, (err) => r(!err))));
    return { git, env, gh: signedIn ? gh : undefined };
  })());
  if (!found) tools = undefined;
  return found;
}

const NO_GIT = "Install git to sync with GitHub (on a Mac, run xcode-select --install in Terminal).";

export async function gitInfo(root: string): Promise<GitInfo> {
  const t = await gitTools();
  if (!t) return { git: false, gh: false };
  const remote = (await gitFor(root, t)(["remote", "get-url", "origin"]).catch(() => "")).trim();
  return { git: true, gh: !!t.gh, remote: remote || undefined };
}

/** Points the vault at a repository and returns its address. */
export async function setUpGitHub(root: string, remote: string) {
  const t = await gitTools();
  if (!t) throw new Error(NO_GIT);
  return setUpGitSync(root, t, remote);
}

/** Keeps a vault in sync through its repository. */
export const gitSyncVault = (vault: Vault, remote: string, emit: (s: SyncStatus, conflicts?: string[]) => void) =>
  new RoundLoop(
    async () => {
      const t = await gitTools();
      if (!t) throw new Error(NO_GIT);
      return gitSyncOnce(vault.root, t);
    },
    { on: true, via: "github", remote: shortRemote(remote), state: "idle" },
    emit,
  );

const toPosix = (p: string) => p.split(path.sep).join("/");

/** The vault on disk as the sync engine sees it. Hashes are cached by size and mtime. */
class VaultStore implements SyncStore {
  private hashes = new Map<string, { size: number; mtime: number; hash: string }>();
  constructor(private vault: Vault) {}

  private stateFile() {
    return path.join(this.vault.root, ".railnote", "sync.json");
  }

  async list() {
    const out = new Map<string, string>();
    const walk = async (dir: string) => {
      for (const ent of await fs.readdir(dir, { withFileTypes: true })) {
        const abs = path.join(dir, ent.name);
        const rel = toPosix(path.relative(this.vault.root, abs));
        if (IGNORED.test(rel) || ent.name.startsWith(".")) continue;
        if (ent.isDirectory()) await walk(abs);
        else if (ent.isFile()) {
          const st = await fs.stat(abs);
          const hit = this.hashes.get(rel);
          if (hit && hit.size === st.size && hit.mtime === st.mtimeMs) out.set(rel, hit.hash);
          else {
            const hash = createHash("sha256").update(await fs.readFile(abs)).digest("hex");
            this.hashes.set(rel, { size: st.size, mtime: st.mtimeMs, hash });
            out.set(rel, hash);
          }
        }
      }
    };
    await walk(this.vault.root);
    return out;
  }

  async read(rel: string) {
    return new Uint8Array(await fs.readFile(this.vault.resolve(rel)));
  }

  write(rel: string, bytes: Uint8Array) {
    return this.vault.writeSynced(rel, bytes);
  }

  remove(rel: string) {
    return this.vault.remove(rel);
  }

  async loadState() {
    try {
      return JSON.parse(await fs.readFile(this.stateFile(), "utf8")) as SyncState;
    } catch {
      return null;
    }
  }

  async saveState(s: SyncState) {
    const file = this.stateFile();
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(`${file}.tmp`, JSON.stringify(s));
    await fs.rename(`${file}.tmp`, file);
  }
}

