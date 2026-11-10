#!/usr/bin/env node
/**
 * Railnote sync server. No dependencies; Node 18 or later.
 *
 * It keeps encrypted files for "spaces" (one per synced vault) and hands out changes by sequence
 * number. Everything it stores was encrypted on a device with a key it never sees: it knows how
 * many files a space has, how big they are and when they change, and nothing else.
 *
 *   PORT=8787 DATA=./sync-data WEB=./dist-web node server/sync-server.mjs
 *
 * WEB, when set, is the Railnote web app (npm run build:web), served at / so a phone can open
 * and install it from the same address it syncs with.
 *
 * API, all under /v1/spaces/<space id>, with "Authorization: Bearer <token>":
 *   PUT    ""                       make the space (the first device); the token becomes its key
 *   GET    /changes?since=N         latest change per file after sequence N
 *   GET    /files/<fid>             a file's sealed bytes, with its sequence in X-Seq
 *   PUT    /files/<fid>?base=N      store a version if the file's latest is still N (else 409)
 *   DELETE /files/<fid>?base=N      same, as a deletion
 */
import { createHash, timingSafeEqual } from "node:crypto";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import http from "node:http";
import path from "node:path";

const PORT = Number(process.env.PORT || 8787);
const DATA = path.resolve(process.env.DATA || "sync-data");
const WEB = process.env.WEB ? path.resolve(process.env.WEB) : null;
const MAX_BODY = Number(process.env.MAX_FILE_MB || 70) * 1024 * 1024;
const MAX_SPACE = Number(process.env.MAX_SPACE_MB || 2048) * 1024 * 1024;
/** Spaces anyone may create; set CREATE_KEY to require "X-Create-Key" when making one. */
const CREATE_KEY = process.env.CREATE_KEY || "";
/** How many spaces this server holds at most, and how many one address may make in a day. */
const MAX_SPACES = Number(process.env.MAX_SPACES || 1000);
const CREATES_PER_DAY = Number(process.env.CREATES_PER_DAY || 5);
/** Writes stop while the disk has less than this free, so a busy day can't fill a shared machine. */
const MIN_FREE = Number(process.env.MIN_FREE_MB || 10240) * 1024 * 1024;
/** Behind a reverse proxy, the client's address is in X-Real-IP (the proxy must overwrite it). */
const TRUST_PROXY = process.env.TRUST_PROXY === "1";

const SPACE = /^[0-9a-f]{32}$/;
const FID = /^[0-9a-f]{40}$/;
const sha = (s) => createHash("sha256").update(s).digest();

/** One space, loaded on first use and kept in memory. Changes run one at a time. */
class Space {
  constructor(id, meta) {
    this.id = id;
    this.dir = path.join(DATA, id);
    this.meta = meta; // { tokenHash, seq, files: { fid: { seq, deleted, size } } }
    this.queue = Promise.resolve();
  }
  run(fn) {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => {});
    return next;
  }
  used() {
    return Object.values(this.meta.files).reduce((n, f) => n + (f.deleted ? 0 : f.size), 0);
  }
  async save() {
    const file = path.join(this.dir, "meta.json");
    await fs.writeFile(`${file}.tmp`, JSON.stringify(this.meta));
    await fs.rename(`${file}.tmp`, file);
  }
}

const spaces = new Map();

async function load(id) {
  if (spaces.has(id)) return spaces.get(id);
  try {
    const meta = JSON.parse(await fs.readFile(path.join(DATA, id, "meta.json"), "utf8"));
    const s = new Space(id, meta);
    spaces.set(id, s);
    return s;
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}

function authorized(s, req) {
  const m = /^Bearer ([0-9a-f]{64})$/.exec(req.headers.authorization || "");
  if (!m) return false;
  return timingSafeEqual(sha(m[1]), Buffer.from(s.meta.tokenHash, "hex"));
}

function body(req, limit) {
  return new Promise((resolve, reject) => {
    const parts = [];
    let n = 0;
    req.on("data", (c) => {
      n += c.length;
      if (n > limit) {
        reject(Object.assign(new Error("too large"), { status: 413 }));
        req.destroy();
      } else parts.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(parts)));
    req.on("error", reject);
  });
}

const json = (res, status, obj) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
};

// Wrong tokens get slower answers, per address, so guessing is pointless as well as hopeless.
const misses = new Map();
const slow = (ip) => new Promise((r) => setTimeout(r, Math.min(5000, 250 * 2 ** Math.min(misses.get(ip) || 0, 5))));

/** Free bytes on the data disk, checked at most every few seconds. */
let disk = { at: 0, free: Infinity };
async function diskFull(adding = 0) {
  if (Date.now() - disk.at > 5000) {
    const st = await fs.statfs(DATA);
    disk = { at: Date.now(), free: st.bavail * st.bsize };
  }
  return disk.free - adding < MIN_FREE;
}

const creates = new Map();
/** Counts a new space against its address; false once the day's allowance is used. */
function made(ip) {
  const day = Math.floor(Date.now() / 86_400_000);
  const c = creates.get(ip);
  const n = c?.day === day ? c.n : 0;
  if (n >= CREATES_PER_DAY) return false;
  creates.set(ip, { day, n: n + 1 });
  return true;
}

async function api(req, res, url) {
  const [, , , id, kind, fid] = url.pathname.split("/"); // "", v1, spaces, id, kind, fid
  if (!SPACE.test(id || "")) return json(res, 404, { error: "no such space" });
  const ip = (TRUST_PROXY && req.headers["x-real-ip"]) || req.socket.remoteAddress || "";

  if (!kind && req.method === "PUT") {
    if (CREATE_KEY && req.headers["x-create-key"] !== CREATE_KEY) return json(res, 403, { error: "this server needs a create key" });
    const m = /^Bearer ([0-9a-f]{64})$/.exec(req.headers.authorization || "");
    if (!m) return json(res, 401, { error: "token required" });
    const have = await load(id);
    if (have) return authorized(have, req) ? json(res, 200, { seq: have.meta.seq }) : (await slow(ip), json(res, 401, { error: "wrong token" }));
    if (!made(ip)) return json(res, 429, { error: "too many new spaces from this address today" });
    if ((await diskFull()) || (await fs.readdir(DATA)).filter((d) => SPACE.test(d)).length >= MAX_SPACES)
      return json(res, 507, { error: "this server is full" });
    const s = new Space(id, { tokenHash: sha(m[1]).toString("hex"), seq: 0, files: {} });
    await fs.mkdir(path.join(s.dir, "files"), { recursive: true });
    await s.save();
    spaces.set(id, s);
    return json(res, 201, { seq: 0 });
  }

  const s = await load(id);
  if (!s) return json(res, 404, { error: "no such space" });
  if (!authorized(s, req)) {
    misses.set(ip, (misses.get(ip) || 0) + 1);
    await slow(ip);
    return json(res, 401, { error: "wrong token" });
  }
  misses.delete(ip);

  if (kind === "changes" && req.method === "GET") {
    const since = Number(url.searchParams.get("since") || 0);
    const changes = Object.entries(s.meta.files)
      .filter(([, f]) => f.seq > since)
      .map(([fid, f]) => ({ fid, seq: f.seq, deleted: !!f.deleted }))
      .sort((a, b) => a.seq - b.seq);
    return json(res, 200, { seq: s.meta.seq, changes });
  }

  if (kind !== "files" || !FID.test(fid || "")) return json(res, 404, { error: "not found" });
  const file = path.join(s.dir, "files", fid);

  if (req.method === "GET") {
    const f = s.meta.files[fid];
    if (!f || f.deleted) return json(res, 404, { error: "no such file" });
    res.writeHead(200, { "content-type": "application/octet-stream", "content-length": f.size, "x-seq": String(f.seq) });
    return void createReadStream(file).pipe(res);
  }

  if (req.method === "PUT" || req.method === "DELETE") {
    const base = Number(url.searchParams.get("base") || 0);
    const data = req.method === "PUT" ? await body(req, MAX_BODY) : null;
    return s.run(async () => {
      const f = s.meta.files[fid];
      // A new file may take the place of a deleted one without knowing its sequence.
      const current = f ? (f.deleted && base === 0 ? 0 : f.seq) : 0;
      if (base !== current) return json(res, 409, { seq: f?.seq ?? 0, deleted: !!f?.deleted });
      if (data && s.used() - (f && !f.deleted ? f.size : 0) + data.length > MAX_SPACE) return json(res, 507, { error: "space is full" });
      if (data && (await diskFull(data.length))) return json(res, 507, { error: "this server is full" });
      if (data) disk.free -= data.length;
      const seq = ++s.meta.seq;
      if (data) {
        await fs.writeFile(`${file}.tmp`, data);
        await fs.rename(`${file}.tmp`, file);
        s.meta.files[fid] = { seq, size: data.length };
      } else {
        await fs.rm(file, { force: true });
        s.meta.files[fid] = { seq, size: 0, deleted: true };
      }
      await s.save();
      json(res, 200, { seq });
    });
  }
  json(res, 405, { error: "method not allowed" });
}

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".woff": "font/woff", ".ico": "image/x-icon" };

async function web(req, res, url) {
  if (!WEB || (req.method !== "GET" && req.method !== "HEAD")) return json(res, 404, { error: "not found" });
  let rel = decodeURIComponent(url.pathname).replace(/^\/+/, "") || "index.html";
  let file = path.resolve(WEB, rel);
  if (file !== WEB && !file.startsWith(WEB + path.sep)) return json(res, 404, { error: "not found" });
  let stat = await fs.stat(file).catch(() => null);
  if (!stat?.isFile()) {
    file = path.join(WEB, "index.html");
    stat = await fs.stat(file).catch(() => null);
    if (!stat) return json(res, 404, { error: "not found" });
  }
  const ext = path.extname(file);
  res.writeHead(200, {
    "content-type": TYPES[ext] || "application/octet-stream",
    "content-length": stat.size,
    // Hashed build files never change; the page and the worker must always be fresh.
    "cache-control": /\/assets\//.test(file) ? "public, max-age=31536000, immutable" : "no-cache",
    "x-content-type-options": "nosniff",
  });
  if (req.method === "HEAD") return res.end();
  createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-headers", "authorization, content-type, x-create-key");
  res.setHeader("access-control-allow-methods", "GET, PUT, DELETE, OPTIONS");
  res.setHeader("access-control-expose-headers", "x-seq");
  if (req.method === "OPTIONS") return res.writeHead(204).end();
  const url = new URL(req.url || "/", "http://x");
  try {
    if (url.pathname === "/v1/health") return json(res, 200, { ok: true });
    if (url.pathname.startsWith("/v1/spaces/")) return await api(req, res, url);
    await web(req, res, url);
  } catch (e) {
    if (!res.headersSent) json(res, e.status || 500, { error: e.status ? e.message : "server error" });
    if (!e.status) console.error(e);
  }
});

await fs.mkdir(DATA, { recursive: true });
server.listen(PORT, () => console.log(`railnote sync on :${PORT}, data in ${DATA}${WEB ? `, web app from ${WEB}` : ""}`));
