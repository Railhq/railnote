import { createHash } from "crypto";
import fs from "fs/promises";
import path from "path";
import { SyncLoop, type SyncConfig, type SyncState, type SyncStatus, type SyncStore } from "../shared/sync";
import { IGNORED, type Vault } from "./vault";

export { setUpSync } from "../shared/sync";

/** Keeps a vault on disk in sync. */
export const syncVault = (vault: Vault, cfg: SyncConfig, emit: (s: SyncStatus, conflicts?: string[]) => void) => new SyncLoop(new VaultStore(vault), cfg, emit);

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

