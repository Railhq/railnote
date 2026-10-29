import { createHash } from "crypto";
import fs from "fs/promises";
import path from "path";
import { diffStat } from "../shared/diff";
import type { NoteVersion, VersionSource } from "../shared/types";

interface Entry extends NoteVersion {
  hash: string;
  /** When the run of saves this entry stands for began; a run folds into one version. */
  start: number;
}

interface NoteLog {
  path: string;
  versions: Entry[];
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** Saves from the app fold into one version while they keep coming, up to half an hour of them. */
const APP_QUIET = 5 * MIN;
const APP_RUN = 30 * MIN;
/** An agent or another app saves in bursts too; theirs fold over a shorter span. */
const OUTSIDE_QUIET = 2 * MIN;
const OUTSIDE_RUN = 10 * MIN;
const CAP = 500;

const sha1 = (s: string) => createHash("sha1").update(s).digest("hex");

/**
 * Saved versions of every note, kept in the vault at .railnote/history so they travel with it.
 * Texts are stored once each, by hash, in blobs/; each note has a small log in notes/ naming
 * its versions. Older versions thin out: all of the last day, then one an hour for a week, one a
 * day for three months, and one a week before that.
 */
export class History {
  private dir: string;
  private logs?: Map<string, NoteLog>;
  private refs = new Map<string, number>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(root: string) {
    this.dir = path.join(root, ".railnote", "history");
  }

  /** Runs `fn` after every earlier history change, so two saves never interleave their writes. */
  private run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => {});
    return next;
  }

  private logFile(note: string) {
    return path.join(this.dir, "notes", `${sha1(note)}.json`);
  }

  private blobFile(hash: string) {
    return path.join(this.dir, "blobs", `${hash}.md`);
  }

  private async load(): Promise<Map<string, NoteLog>> {
    if (this.logs) return this.logs;
    const logs = new Map<string, NoteLog>();
    let names: string[] = [];
    try {
      names = await fs.readdir(path.join(this.dir, "notes"));
    } catch {
      /* no history yet */
    }
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      try {
        const log = JSON.parse(await fs.readFile(path.join(this.dir, "notes", name), "utf8")) as NoteLog;
        if (typeof log.path === "string" && Array.isArray(log.versions)) logs.set(log.path, log);
      } catch {
        // A log cut short by a crash loses that note's history, not everyone's.
      }
    }
    for (const log of logs.values()) for (const v of log.versions) this.refs.set(v.hash, (this.refs.get(v.hash) ?? 0) + 1);
    return (this.logs = logs);
  }

  private async save(log: NoteLog) {
    const file = this.logFile(log.path);
    if (!log.versions.length) return void (await fs.rm(file, { force: true }));
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(log));
    await fs.rename(tmp, file);
  }

  private async keepBlob(hash: string, text: string) {
    const n = this.refs.get(hash) ?? 0;
    this.refs.set(hash, n + 1);
    if (n) return;
    await fs.mkdir(path.join(this.dir, "blobs"), { recursive: true });
    try {
      await fs.writeFile(this.blobFile(hash), text, { flag: "wx" });
    } catch (e: any) {
      if (e.code !== "EEXIST") throw e;
    }
  }

  private async dropBlob(hash: string) {
    const n = (this.refs.get(hash) ?? 1) - 1;
    if (n > 0) return void this.refs.set(hash, n);
    this.refs.delete(hash);
    await fs.rm(this.blobFile(hash), { force: true });
  }

  private readBlob(hash: string) {
    return fs.readFile(this.blobFile(hash), "utf8");
  }

  /**
   * Keeps `text` as a version of `note`. Text the note already had as its latest version is
   * skipped, and a save that follows closely on one from the same place replaces it.
   */
  record(note: string, text: string, source: VersionSource, now = Date.now()): Promise<void> {
    return this.run(async () => {
      const logs = await this.load();
      const log = logs.get(note) ?? { path: note, versions: [] };
      const hash = sha1(text);
      const vs = log.versions;
      const last = vs[vs.length - 1];
      if (last?.hash === hash) return;
      // The watcher can report an outside save after the app has saved over it; it's already kept.
      if ((source === "outside" || source === "synced") && vs.slice(-3).some((v) => v.hash === hash)) return;
      const [quiet, span] = source === "app" ? [APP_QUIET, APP_RUN] : source === "outside" || source === "synced" ? [OUTSIDE_QUIET, OUTSIDE_RUN] : [0, 0];
      const fold = last && last.source === source && now - last.time < quiet && now - last.start < span;
      if (fold) vs.pop();
      const prev = vs[vs.length - 1];
      const before = prev ? await this.readBlob(prev.hash).catch(() => "") : "";
      await this.keepBlob(hash, text);
      vs.push({
        id: `${now.toString(36)}${hash.slice(0, 6)}`,
        time: now,
        start: fold ? last.start : now,
        source,
        hash,
        ...diffStat(before, text),
      });
      if (fold) await this.dropBlob(last.hash);
      for (const gone of thin(vs, now)) await this.dropBlob(gone.hash);
      logs.set(note, log);
      await this.save(log);
    });
  }

  /**
   * Called with what's on disk just before the app saves over it. The first time, that's the note
   * as it was before Railnote touched it; later, a difference means it changed while nobody was
   * watching (the app was closed, or the watcher hadn't caught up).
   */
  async observe(note: string, onDisk: string) {
    const logs = await this.run(() => this.load());
    const vs = logs.get(note)?.versions;
    if (!vs?.length) return this.record(note, onDisk, "original");
    if (vs[vs.length - 1].hash !== sha1(onDisk)) return this.record(note, onDisk, "outside");
  }

  /** Moves the history of a note, or of every note in a folder, to its new path. */
  move(from: string, to: string): Promise<void> {
    return this.run(async () => {
      const logs = await this.load();
      for (const log of [...logs.values()]) {
        if (log.path !== from && !log.path.startsWith(from + "/")) continue;
        const dest = to + log.path.slice(from.length);
        // A note deleted from the new path earlier still has a history there; the two merge.
        const there = logs.get(dest);
        const moved: NoteLog = { path: dest, versions: [...(there?.versions ?? []), ...log.versions].sort((a, b) => a.time - b.time) };
        logs.delete(log.path);
        logs.set(dest, moved);
        await fs.rm(this.logFile(log.path), { force: true });
        await this.save(moved);
      }
    });
  }

  async list(note: string): Promise<NoteVersion[]> {
    const logs = await this.run(() => this.load());
    return (logs.get(note)?.versions ?? []).map(({ id, time, source, added, removed }) => ({ id, time, source, added, removed })).reverse();
  }

  async read(note: string, id: string): Promise<string> {
    const logs = await this.run(() => this.load());
    const v = logs.get(note)?.versions.find((x) => x.id === id);
    if (!v) throw new Error("That version is no longer kept.");
    return this.readBlob(v.hash);
  }
}

/** Takes out versions the retention schedule no longer keeps, and returns them. */
function thin(vs: Entry[], now: number): Entry[] {
  const seen = new Set<string>();
  const keep: Entry[] = [];
  const gone: Entry[] = [];
  for (let i = vs.length - 1; i >= 0; i--) {
    const v = vs[i];
    const age = now - v.time;
    const bucket = age < DAY ? v.id : age < 7 * DAY ? `h${Math.floor(v.time / HOUR)}` : age < 90 * DAY ? `d${Math.floor(v.time / DAY)}` : `w${Math.floor(v.time / (7 * DAY))}`;
    if (keep.length < CAP && !seen.has(bucket)) {
      seen.add(bucket);
      keep.push(v);
    } else gone.push(v);
  }
  vs.splice(0, vs.length, ...keep.reverse());
  return gone;
}
