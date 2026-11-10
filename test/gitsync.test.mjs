// GitHub sync against a local bare repository: two computers' vaults. `npm run test:gitsync`.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "railnote-gitsync-"));
await build({ entryPoints: [path.join(root, "electron/gitsync.ts")], bundle: true, format: "esm", platform: "node", outfile: path.join(tmp, "gitsync.mjs"), logLevel: "error" });
const { setUpGitSync, gitSyncOnce, normalizeRemote, shortRemote } = await import(path.join(tmp, "gitsync.mjs"));
// No user identity and no global config, as on a computer that has never committed.
const env = { PATH: process.env.PATH, HOME: tmp, GIT_CONFIG_NOSYSTEM: "1" };
const tools = { git: execFileSync("which", ["git"]).toString().trim(), env };
let fails = 0; const ok = (c, m) => { console.log((c ? "ok   " : "FAIL ") + m); if (!c) fails++; };
const remote = path.join(tmp, "notes.git");
execFileSync("git", ["init", "--quiet", "--bare", remote], { env });
const A = path.join(tmp, "A"), B = path.join(tmp, "B");
fs.mkdirSync(A); fs.mkdirSync(B);
const put = (v, p, t) => { fs.mkdirSync(path.dirname(path.join(v, p)), { recursive: true }); fs.writeFileSync(path.join(v, p), t); };
const get = (v, p) => { try { return fs.readFileSync(path.join(v, p), "utf8"); } catch { return undefined; } };
const ls = (v, d = "") => fs.readdirSync(path.join(v, d)).filter((n) => n !== ".git").flatMap((n) => fs.statSync(path.join(v, d, n)).isDirectory() ? ls(v, path.join(d, n)) : [path.join(d, n)]);

ok(normalizeRemote("me/notes") === "https://github.com/me/notes.git", "owner/repo becomes a GitHub address");
ok(normalizeRemote("https://github.com/me/notes/") === "https://github.com/me/notes.git", "a GitHub page address becomes a clone address");
ok(shortRemote("git@github.com:me/notes.git") === "me/notes" && shortRemote(remote) === remote, "short names for the settings line");

put(A, "Welcome.md", "# hi\n"); put(A, "Notes/a.md", "alpha\n"); fs.writeFileSync(path.join(A, "Attachments.png"), Buffer.from([0, 1, 2, 255, 128]));
put(A, ".railnote/history/x.json", "{}"); put(A, ".trash/old.md", "gone");
ok((await setUpGitSync(A, tools, remote)) === remote, "A set up against the remote");
ok(get(A, ".gitignore").includes(".railnote/"), "A got a .gitignore");
let c = await gitSyncOnce(A, tools); ok(c.length === 0, "A's first round pushed, no conflicts");

await setUpGitSync(B, tools, remote);
c = await gitSyncOnce(B, tools);
ok(get(B, "Notes/a.md") === "alpha\n" && fs.readFileSync(path.join(B, "Attachments.png"))[3] === 255, "B pulled the notes, binary intact");
ok(get(B, ".railnote/history/x.json") === undefined && get(B, ".trash/old.md") === undefined, "history and trash stayed on A");

put(B, "Notes/b.md", "from B\n"); await gitSyncOnce(B, tools); await gitSyncOnce(A, tools);
ok(get(A, "Notes/b.md") === "from B\n", "a new note on B reached A");

put(A, "Notes/a.md", "alpha, edited on A\n"); put(B, "Notes/a.md", "alpha, edited on B\n");
await gitSyncOnce(A, tools); c = await gitSyncOnce(B, tools);
ok(c.length === 1 && /^Notes\/a \(conflict \d{4}-\d\d-\d\d\)\.md$/.test(c[0]), `both edited: one conflict copy (${c})`);
ok(get(B, "Notes/a.md") === "alpha, edited on B\n" && get(B, c[0]) === "alpha, edited on A\n", "B kept its text, A's beside it");
await gitSyncOnce(A, tools);
ok(get(A, "Notes/a.md") === "alpha, edited on B\n" && get(A, c[0]) === "alpha, edited on A\n", "A ends up the same as B");

put(A, "Welcome.md", "# hi, edited\n"); fs.rmSync(path.join(B, "Welcome.md"));
await gitSyncOnce(A, tools); c = await gitSyncOnce(B, tools);
ok(c.length === 0 && get(B, "Welcome.md") === "# hi, edited\n", "edited on one, deleted on the other: the edit wins");
await gitSyncOnce(A, tools);

fs.rmSync(path.join(A, "Notes/b.md")); await gitSyncOnce(A, tools); await gitSyncOnce(B, tools);
ok(get(B, "Notes/b.md") === undefined, "a delete on A reached B");

ok(c.length === 0 && (await gitSyncOnce(A, tools)).length === 0, "a quiet round does nothing");
const log = execFileSync("git", ["log", "--format=%an <%ae>%n%s"], { cwd: A, env }).toString();
ok(log.includes("Railnote <railnote@users.noreply.github.com>") && log.includes("Railnote sync from"), "commits say where they came from, with a fallback name");
const same = JSON.stringify(ls(A).filter((p) => !/^\.(railnote|trash)/.test(p)).sort()) === JSON.stringify(ls(B).sort());
ok(same, "both vaults hold the same files");

const E = path.join(tmp, "E"); fs.mkdirSync(E); put(E, "Welcome.md", "# E's own welcome\n"); put(E, "Mine.md", "only on E\n");
await setUpGitSync(E, tools, remote); c = await gitSyncOnce(E, tools);
ok(get(E, "Notes/a.md") === "alpha, edited on B\n" && get(E, "Mine.md") === "only on E\n", "a vault with its own notes joins: it gets the repo's and keeps its own");
ok(c.length === 1 && get(E, "Welcome.md") === "# E's own welcome\n" && get(E, c[0]) === "# hi, edited\n", "a note both had: E keeps its text, the repo's beside it");
await gitSyncOnce(A, tools); ok(get(A, "Mine.md") === "only on E\n", "E's notes reached A");
fs.mkdirSync(path.join(tmp, "C")); await setUpGitSync(path.join(tmp, "C"), tools, "").then(() => ok(false, "no remote and no gh should fail"), (e) => ok(/Enter the repository/.test(e.message), "no remote and no gh: asks for an address"));
fs.mkdirSync(path.join(tmp, "D")); await setUpGitSync(path.join(tmp, "D"), tools, path.join(tmp, "missing.git"));
await gitSyncOnce(path.join(tmp, "D"), tools).then(() => ok(false, "missing remote should fail"), (e) => ok(e.message.length > 0, `a remote that isn't there fails with a message: ${e.message}`));

fs.rmSync(tmp, { recursive: true, force: true });
console.log(fails ? `${fails} failed` : "all passed");
process.exit(fails ? 1 : 0);
