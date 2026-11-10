/**
 * Sync between devices through a Railnote sync server, end-to-end encrypted.
 *
 * The passphrase never leaves the device. From it and the space id come three keys: one encrypts
 * every file (AES-GCM), one turns each path into an opaque file id (HMAC), and one is the token
 * the server checks. The server stores ciphertext under ids it can't read paths from, plus a
 * sequence number per change; it never sees a name, a word of a note, or the passphrase.
 *
 * The engine is the same on desktop and phone. A SyncStore adapts it to where files live.
 */

import type { SyncStatus } from "./types";

export type { SyncStatus };

export interface SyncConfig {
  /** Base URL of the sync server, such as https://sync.example.com */
  server: string;
  space: string;
  passphrase: string;
}

export interface SyncStore {
  /** Every file that syncs, with the SHA-256 hex of its bytes. */
  list(): Promise<Map<string, string>>;
  read(path: string): Promise<Uint8Array>;
  /** Writes a file that came from another device. */
  write(path: string, bytes: Uint8Array): Promise<void>;
  /** Removes a file another device deleted. */
  remove(path: string): Promise<void>;
  loadState(): Promise<SyncState | null>;
  saveState(state: SyncState): Promise<void>;
}

interface Known {
  fid: string;
  /** Server sequence of the version this device last had in common with the server. */
  seq: number;
  /** Hash of that version; null when the server's copy was deleted but this device kept editing. */
  hash: string | null;
}

export interface SyncState {
  server: string;
  space: string;
  cursor: number;
  known: Record<string, Known>;
}

export interface SyncResult {
  pulled: number;
  pushed: number;
  removed: number;
  /** Conflict copies made, by path. */
  conflicts: string[];
}

/** Largest file that syncs, before encryption. */
export const MAX_SYNC_BYTES = 50 * 1024 * 1024;

const subtle = globalThis.crypto.subtle;
const utf8 = new TextEncoder();
const hex = (b: ArrayBuffer | Uint8Array) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

export async function sha256(bytes: Uint8Array): Promise<string> {
  return hex(await subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>));
}

/** A new space id: 16 random bytes, hex. */
export function newSpaceId(): string {
  return hex(globalThis.crypto.getRandomValues(new Uint8Array(16)));
}

/** One string a second device needs, besides the passphrase. */
export const syncLink = (c: Pick<SyncConfig, "server" | "space">) => `${c.server.replace(/\/+$/, "")}#${c.space}`;

export function parseSyncLink(link: string): Pick<SyncConfig, "server" | "space"> | null {
  const m = link.trim().match(/^(https?:\/\/[^#\s]+)#([0-9a-f]{32})$/i);
  return m ? { server: m[1].replace(/\/+$/, ""), space: m[2].toLowerCase() } : null;
}

export interface SyncKeys {
  aes: CryptoKey;
  mac: CryptoKey;
  token: string;
}

/** Slow on purpose (PBKDF2, 310k rounds) so a stolen server copy can't be guessed at quickly. */
export async function deriveKeys(space: string, passphrase: string): Promise<SyncKeys> {
  const base = await subtle.importKey("raw", utf8.encode(passphrase.normalize("NFC")), "PBKDF2", false, ["deriveBits"]);
  const bits = new Uint8Array(await subtle.deriveBits({ name: "PBKDF2", salt: utf8.encode(`railnote-sync/${space}`), iterations: 310_000, hash: "SHA-256" }, base, 768));
  return {
    aes: await subtle.importKey("raw", bits.slice(0, 32), "AES-GCM", false, ["encrypt", "decrypt"]),
    mac: await subtle.importKey("raw", bits.slice(32, 64), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]),
    token: hex(bits.slice(64, 96)),
  };
}

async function fileId(keys: SyncKeys, path: string) {
  return hex(await subtle.sign("HMAC", keys.mac, utf8.encode(path))).slice(0, 40);
}

/** iv ‖ AES-GCM(len ‖ {path, hash} ‖ bytes), bound to the file id so a blob can't be moved to another. */
async function seal(keys: SyncKeys, fid: string, path: string, hash: string, bytes: Uint8Array) {
  const head = utf8.encode(JSON.stringify({ path, hash }));
  const plain = new Uint8Array(4 + head.length + bytes.length);
  new DataView(plain.buffer).setUint32(0, head.length);
  plain.set(head, 4);
  plain.set(bytes, 4 + head.length);
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv, additionalData: utf8.encode(fid) }, keys.aes, plain));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv);
  out.set(ct, 12);
  return out;
}

async function open(keys: SyncKeys, fid: string, sealed: Uint8Array) {
  let plain: Uint8Array;
  try {
    plain = new Uint8Array(await subtle.decrypt({ name: "AES-GCM", iv: sealed.slice(0, 12), additionalData: utf8.encode(fid) }, keys.aes, sealed.slice(12)));
  } catch {
    throw new SyncError("A file on the server can't be read with this passphrase.", "passphrase");
  }
  const n = new DataView(plain.buffer).getUint32(0);
  const { path, hash } = JSON.parse(new TextDecoder().decode(plain.slice(4, 4 + n))) as { path: string; hash: string };
  return { path, hash, bytes: plain.slice(4 + n) };
}

export class SyncError extends Error {
  constructor(message: string, readonly kind: "auth" | "missing" | "passphrase" | "network" | "server") {
    super(message);
  }
}

/** Where a file goes when this device and another both changed it: next to it, named for the clash. */
export function conflictPath(path: string, taken: (p: string) => boolean, now = new Date()) {
  const slash = path.lastIndexOf("/");
  const dot = path.lastIndexOf(".");
  const [base, ext] = dot > slash + 1 ? [path.slice(0, dot), path.slice(dot)] : [path, ""];
  const day = now.toISOString().slice(0, 10);
  for (let i = 1; ; i++) {
    const p = `${base} (conflict ${day}${i > 1 ? ` ${i}` : ""})${ext}`;
    if (!taken(p)) return p;
  }
}

/** Talks to the server for one space. */
export class SyncClient {
  private constructor(private cfg: SyncConfig, readonly keys: SyncKeys, private fetcher: typeof fetch) {}

  static async connect(cfg: SyncConfig, fetcher: typeof fetch = globalThis.fetch.bind(globalThis)) {
    return new SyncClient({ ...cfg, server: cfg.server.replace(/\/+$/, "") }, await deriveKeys(cfg.space, cfg.passphrase), fetcher);
  }

  private async call(method: string, rest: string, body?: Uint8Array, ok: number[] = [200]) {
    let res: Response;
    try {
      res = await this.fetcher(`${this.cfg.server}/v1/spaces/${this.cfg.space}${rest}`, {
        method,
        headers: { authorization: `Bearer ${this.keys.token}`, ...(body ? { "content-type": "application/octet-stream" } : {}) },
        body: body as Uint8Array<ArrayBuffer> | undefined,
      });
    } catch (e) {
      throw new SyncError(`Can't reach the sync server (${(e as Error).message}).`, "network");
    }
    if (res.status === 401) throw new SyncError("The sync server turned down this passphrase.", "auth");
    if (res.status === 404) throw new SyncError("The sync server has no space with this link.", "missing");
    if (!ok.includes(res.status)) {
      const text = (await res.text()).slice(0, 200);
      let said = text;
      try {
        said = JSON.parse(text).error ?? text;
      } catch {}
      throw new SyncError(`The sync server said: ${said} (${res.status}).`, "server");
    }
    return res;
  }

  /** Makes the space on the server. Only the first device does this. */
  async create() {
    await this.call("PUT", "", undefined, [200, 201]);
  }

  async exists() {
    try {
      await this.call("GET", "/changes?since=0&limit=1");
      return true;
    } catch (e) {
      if (e instanceof SyncError && e.kind === "missing") return false;
      throw e;
    }
  }

  async changes(since: number): Promise<{ seq: number; changes: { fid: string; seq: number; deleted: boolean }[] }> {
    return (await this.call("GET", `/changes?since=${since}`)).json();
  }

  async get(fid: string) {
    const res = await this.call("GET", `/files/${fid}`);
    return { seq: Number(res.headers.get("x-seq")), sealed: new Uint8Array(await res.arrayBuffer()) };
  }

  /** Stores a version if the server's latest is still `base`; otherwise null (someone got there first). */
  async put(fid: string, base: number, sealed: Uint8Array): Promise<number | null> {
    const res = await this.call("PUT", `/files/${fid}?base=${base}`, sealed, [200, 409]);
    return res.status === 409 ? null : (await res.json()).seq;
  }

  async del(fid: string, base: number): Promise<number | null> {
    const res = await this.call("DELETE", `/files/${fid}?base=${base}`, undefined, [200, 409]);
    return res.status === 409 ? null : (await res.json()).seq;
  }

  fid(path: string) {
    return fileId(this.keys, path);
  }
  seal(fid: string, path: string, hash: string, bytes: Uint8Array) {
    return seal(this.keys, fid, path, hash, bytes);
  }
  open(fid: string, sealed: Uint8Array) {
    return open(this.keys, fid, sealed);
  }
}

/**
 * One round: take what other devices sent, then send what changed here. A file changed on both
 * sides keeps this device's text in place and gets the other device's as a conflict copy beside
 * it, so nothing anyone wrote is lost and the copy syncs everywhere for someone to merge.
 */
export async function syncOnce(client: SyncClient, cfg: SyncConfig, store: SyncStore): Promise<SyncResult> {
  const result: SyncResult = { pulled: 0, pushed: 0, removed: 0, conflicts: [] };
  const saved = await store.loadState();
  const state: SyncState = saved && saved.space === cfg.space && saved.server === cfg.server ? saved : { server: cfg.server, space: cfg.space, cursor: 0, known: {} };
  const persist = () => store.saveState(state);

  for (let round = 0; round < 4; round++) {
    let retry = false;
    const local = await store.list();
    const byFid = new Map(Object.entries(state.known).map(([p, k]) => [k.fid, p]));

    // Take in what other devices sent.
    const { seq: head, changes } = await client.changes(state.cursor);
    for (const ch of changes) {
      const mine = byFid.get(ch.fid);
      const k = mine ? state.known[mine] : undefined;
      if (k && k.seq >= ch.seq) continue; // our own push coming back
      if (ch.deleted) {
        if (!mine || !k) continue;
        if (!local.has(mine)) delete state.known[mine];
        else if (local.get(mine) === k.hash) {
          await store.remove(mine);
          local.delete(mine);
          delete state.known[mine];
          result.removed++;
        } else state.known[mine] = { fid: ch.fid, seq: ch.seq, hash: null }; // edited here since: it comes back
        continue;
      }
      const got = await client.get(ch.fid);
      const remote = await client.open(ch.fid, got.sealed);
      const known = state.known[remote.path];
      const here = local.get(remote.path);
      if (here === remote.hash) {
        // Same text on both sides already.
      } else if (here === undefined || here === known?.hash) {
        await store.write(remote.path, remote.bytes);
        local.set(remote.path, remote.hash);
        result.pulled++;
      } else {
        // Changed here and there: theirs goes beside ours.
        const copy = conflictPath(remote.path, (p) => local.has(p));
        await store.write(copy, remote.bytes);
        local.set(copy, remote.hash);
        result.conflicts.push(copy);
      }
      state.known[remote.path] = { fid: ch.fid, seq: got.seq, hash: remote.hash };
    }
    state.cursor = Math.max(state.cursor, head);
    await persist();

    // Send what changed here.
    for (const [path, hash] of local) {
      const k = state.known[path];
      if (k?.hash === hash) continue;
      const bytes = await store.read(path);
      if (bytes.length > MAX_SYNC_BYTES) continue;
      const fid = k?.fid ?? (await client.fid(path));
      const now = await sha256(bytes); // the file may have moved on since list()
      const seq = await client.put(fid, k?.seq ?? 0, await client.seal(fid, path, now, bytes));
      if (seq === null) retry = true;
      else {
        state.known[path] = { fid, seq, hash: now };
        result.pushed++;
      }
    }
    for (const [path, k] of Object.entries(state.known)) {
      if (local.has(path)) continue;
      if (k.hash === null) {
        delete state.known[path];
        continue;
      }
      const seq = await client.del(k.fid, k.seq);
      if (seq === null) retry = true;
      else {
        delete state.known[path];
        result.removed++;
      }
    }
    await persist();
    if (!retry) break;
  }
  return result;
}

const EVERY = 30_000;
const AFTER_CHANGE = 2_000;

/**
 * Runs sync rounds for one vault: one when it opens, half a minute after the last one, and two
 * seconds after anything in the vault changes. Rounds never overlap; a change during one queues
 * another. `once` does the work of a round and returns the conflict copies it made.
 */
export class RoundLoop {
  private timer?: ReturnType<typeof setTimeout>;
  private running = false;
  private again = false;
  private stopped = false;
  status: SyncStatus;

  constructor(private once: () => Promise<string[]>, status: SyncStatus, private emit: (s: SyncStatus, conflicts?: string[]) => void) {
    this.status = status;
  }

  start() {
    this.schedule(0);
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
  }

  /** Something in the vault changed; send it soon. */
  poke() {
    this.schedule(AFTER_CHANGE);
  }

  now() {
    return this.round();
  }

  private schedule(ms: number) {
    if (this.stopped) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.round(), ms);
  }

  private set(s: Partial<SyncStatus>, conflicts?: string[]) {
    this.status = { ...this.status, ...s };
    this.emit(this.status, conflicts);
  }

  private async round(): Promise<SyncStatus> {
    if (this.running) {
      this.again = true;
      return this.status;
    }
    this.running = true;
    this.set({ state: "syncing" });
    try {
      const conflicts = await this.once();
      this.set({ state: "idle", last: Date.now(), error: undefined }, conflicts.length ? conflicts : undefined);
    } catch (e) {
      this.set({ state: "error", error: (e as Error).message });
    } finally {
      this.running = false;
      if (this.again) {
        this.again = false;
        this.schedule(0);
      } else this.schedule(EVERY);
    }
    return this.status;
  }
}

/** Keeps one vault in sync through a Railnote sync server, wherever its files live. */
export class SyncLoop extends RoundLoop {
  constructor(store: SyncStore, cfg: SyncConfig, emit: (s: SyncStatus, conflicts?: string[]) => void) {
    let client: SyncClient | undefined;
    super(
      async () => {
        client ??= await SyncClient.connect(cfg);
        return (await syncOnce(client, cfg, store)).conflicts;
      },
      { on: true, via: "server", link: syncLink(cfg), state: "idle" },
      emit,
    );
  }
}

/**
 * Turns sync on for a vault: with a server address, as the first device (making the space); with
 * a link from another device, joining its space. The passphrase must match the other devices'.
 */
export async function setUpSync(req: { server?: string; link?: string; passphrase: string }): Promise<SyncConfig> {
  if (req.passphrase.length < 8) throw new Error("Use a passphrase of at least 8 characters.");
  if (req.link) {
    const parsed = parseSyncLink(req.link);
    if (!parsed) throw new Error("That isn't a sync link. It looks like https://server#32-letter-code.");
    const cfg = { ...parsed, passphrase: req.passphrase };
    const client = await SyncClient.connect(cfg);
    if (!(await client.exists())) throw new SyncError("The sync server has no space with this link.", "missing");
    return cfg;
  }
  const server = (req.server ?? "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\/\S+$/.test(server)) throw new Error("Enter the sync server's address, starting with https://");
  const cfg = { server, space: newSpaceId(), passphrase: req.passphrase };
  await (await SyncClient.connect(cfg)).create();
  return cfg;
}
