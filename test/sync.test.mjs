// Sync engine against a real sync server: two (and three) in-memory devices. `npm run test:sync`.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "railnote-sync-"));
await build({ entryPoints: [path.join(root, "shared/sync.ts")], bundle: true, format: "esm", platform: "neutral", outfile: path.join(tmp, "sync.mjs"), logLevel: "error" });
const { SyncClient, syncOnce, sha256, newSpaceId, SyncError } = await import(path.join(tmp, "sync.mjs"));
const DATA = path.join(tmp, "data");
const srv = spawn("node", [path.join(root, "server/sync-server.mjs")], { env: { ...process.env, PORT: "8799", DATA }, stdio: "ignore" });
await new Promise(r => setTimeout(r, 500));
const enc = new TextEncoder(), dec = new TextDecoder();
class Mem { constructor(){ this.files = new Map(); this.state = null; }
  async list(){ const m = new Map(); for (const [p,b] of this.files) m.set(p, await sha256(b)); return m; }
  async read(p){ return this.files.get(p); } async write(p,b){ this.files.set(p,b); } async remove(p){ this.files.delete(p); }
  async loadState(){ return this.state && structuredClone(this.state); } async saveState(s){ this.state = structuredClone(s); }
  set(p,t){ this.files.set(p, enc.encode(t)); } get(p){ const b=this.files.get(p); return b && dec.decode(b); } }
let fails = 0; const ok = (c, m) => { console.log((c ? "ok   " : "FAIL ") + m); if (!c) fails++; };
const cfg = { server: "http://127.0.0.1:8799", space: newSpaceId(), passphrase: "correct horse battery" };
const A = new Mem(), B = new Mem();
const ca = await SyncClient.connect(cfg); const cb = await SyncClient.connect(cfg);
ok(!(await ca.exists()), "space absent before create");
await ca.create(); ok(await cb.exists(), "space exists after create");
A.set("Welcome.md", "# hi\n"); A.set("Notes/a.md", "alpha\n"); A.files.set("Attachments/x.png", new Uint8Array([0,1,2,255]));
let r = await syncOnce(ca, cfg, A); ok(r.pushed === 3, `A pushed 3 (${r.pushed})`);
r = await syncOnce(cb, cfg, B); ok(r.pulled === 3 && B.get("Notes/a.md") === "alpha\n" && B.files.get("Attachments/x.png")[3] === 255, "B pulled all three, binary intact");
r = await syncOnce(cb, cfg, B); ok(r.pulled + r.pushed + r.removed === 0, "idle round does nothing");
B.set("Notes/a.md", "alpha\nbeta\n"); await syncOnce(cb, cfg, B); await syncOnce(ca, cfg, A);
ok(A.get("Notes/a.md") === "alpha\nbeta\n", "edit on B reaches A");
A.files.delete("Welcome.md"); await syncOnce(ca, cfg, A); r = await syncOnce(cb, cfg, B);
ok(!B.files.has("Welcome.md") && r.removed === 1, "delete on A removes on B");
A.set("Notes/a.md", "A version\n"); B.set("Notes/a.md", "B version\n");
await syncOnce(ca, cfg, A); r = await syncOnce(cb, cfg, B);
const copy = [...B.files.keys()].find(p => p.includes("conflict"));
ok(r.conflicts.length === 1 && B.get("Notes/a.md") === "B version\n" && B.get(copy) === "A version\n", `conflict: B keeps its text, A's beside it at ${copy}`);
await syncOnce(ca, cfg, A); ok(A.get("Notes/a.md") === "B version\n" && A.get(copy) === "A version\n", "A converges to B's text plus the copy");
B.files.delete("Notes/a.md"); A.set("Notes/a.md", "A edits after\n"); await syncOnce(cb, cfg, B); await syncOnce(ca, cfg, A); await syncOnce(cb, cfg, B);
ok(A.get("Notes/a.md") === "A edits after\n" && B.get("Notes/a.md") === "A edits after\n", "edit beats a concurrent delete");
A.set("New.md", "one"); B.set("New.md", "two"); await syncOnce(ca, cfg, A); r = await syncOnce(cb, cfg, B); await syncOnce(ca, cfg, A);
ok(A.get("New.md") === "two" && B.get("New.md") === "two" && [...A.files.keys()].filter(p=>p.startsWith("New (conflict")).length === 1, "same new path on both: one wins, other kept as copy");
// fresh device C joins later
const C = new Mem(); await syncOnce(await SyncClient.connect(cfg), cfg, C);
ok(JSON.stringify([...C.files.keys()].sort()) === JSON.stringify([...A.files.keys()].sort()), "a third device gets the same files");
try { await syncOnce(await SyncClient.connect({ ...cfg, passphrase: "wrong" }), cfg, new Mem()); ok(false, "wrong passphrase refused"); } catch (e) { ok(e instanceof SyncError && e.kind === "auth", "wrong passphrase refused: " + e.message); }
const stored = fs.readdirSync(`${DATA}/${cfg.space}/files`).map(f => fs.readFileSync(`${DATA}/${cfg.space}/files/${f}`, "latin1")).join("") + fs.readFileSync(`${DATA}/${cfg.space}/meta.json`, "utf8");
ok(!/alpha|version|Notes|Welcome|png/.test(stored), "server holds no names or text");
srv.kill(); fs.rmSync(tmp, { recursive: true, force: true }); console.log(fails ? `${fails} FAILED` : "all passed"); process.exit(fails ? 1 : 0);
