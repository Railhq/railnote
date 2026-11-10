/**
 * Sync through a GitHub (or any git) repository, using the git and GitHub CLI logins the user
 * already has. Each round commits what changed here, merges what other computers pushed, and
 * pushes the result. When both sides changed a file, this computer's text stays and the other's
 * goes beside it as a conflict copy, the same as with a sync server.
 */
import { execFile } from "child_process";
import { existsSync } from "fs";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { conflictPath } from "../shared/sync";

export interface Git {
  (args: string[]): Promise<string>;
  /** The output as bytes, for file contents that may not be text. */
  bytes(args: string[]): Promise<Buffer>;
}

export interface GitTools {
  git: string;
  /** The GitHub CLI, when it's installed and signed in. */
  gh?: string;
  /** PATH for the commands, so credential helpers and ssh are found. */
  env: NodeJS.ProcessEnv;
}

/** Files that change all the time without being notes, or that stay on each computer. */
const IGNORE = [".railnote/", ".trash/", ".DS_Store", ".obsidian/workspace*.json"];
const MSG = `Railnote sync from ${os.hostname().replace(/\.local$/, "")}`;

function run(bin: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<string>;
function run(bin: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, bytes: true): Promise<Buffer>;
function run(bin: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, bytes = false): Promise<string | Buffer> {
  return new Promise((resolve, reject) =>
    execFile(bin, args, { cwd, env, maxBuffer: 256 * 1024 * 1024, timeout: 120_000, encoding: bytes ? "buffer" : "utf8" }, (err, out, errOut) => {
      if (!err) return resolve(out);
      const lines = String(errOut || err.message).trim().split("\n").filter(Boolean);
      const said = lines.find((l) => /^(fatal|error): /.test(l)) ?? lines.pop() ?? "git failed";
      reject(Object.assign(new Error(said.replace(/^(fatal|error): /, "")), { stderr: String(errOut) }));
    }),
  );
}

const isGitHub = (remote: string) => /github\.com[/:]/.test(remote);

/** owner/repo for the settings line; the address as given for anything else. */
export const shortRemote = (remote: string) => /github\.com[/:]([^/]+\/[^/]+?)(\.git)?\/?$/.exec(remote)?.[1] ?? remote;

/** Accepts owner/repo, a GitHub page address, or any git address. */
export function normalizeRemote(input: string) {
  const s = input.trim();
  if (/^[\w.-]+\/[\w.-]+$/.test(s)) return `https://github.com/${s.replace(/\.git$/, "")}.git`;
  if (/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/?$/.test(s)) return `${s.replace(/\/$/, "").replace(/\.git$/, "")}.git`;
  return s;
}

/** A git for one vault. It never asks for a password (that would hang), and signs in to GitHub through gh when it can. */
export function gitFor(root: string, tools: GitTools): Git {
  const env = { ...tools.env, GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: tools.env.GIT_SSH_COMMAND || "ssh -o BatchMode=yes", LC_ALL: "C" };
  const auth = tools.gh ? ["-c", `credential.https://github.com.helper=!"${tools.gh}" auth git-credential`] : [];
  return Object.assign((args: string[]) => run(tools.git, [...auth, ...args], root, env), {
    bytes: (args: string[]) => run(tools.git, [...auth, ...args], root, env, true),
  });
}

const ok = (p: Promise<unknown>) => p.then(() => true, () => false);

async function identity(git: Git) {
  const named = await ok(git(["config", "user.email"]));
  return named ? [] : ["-c", "user.name=Railnote", "-c", "user.email=railnote@users.noreply.github.com"];
}

/**
 * Makes the vault a repository pointed at its remote: the one given, the origin it already has,
 * or a new private GitHub repository named after the vault. Returns the remote.
 */
export async function setUpGitSync(root: string, tools: GitTools, given: string): Promise<string> {
  const git = gitFor(root, tools);
  if (!(await ok(fs.access(path.join(root, ".git"))))) {
    await git(["init", "--quiet"]);
    await git(["symbolic-ref", "HEAD", "refs/heads/main"]);
  }
  const ignore = path.join(root, ".gitignore");
  const had = await fs.readFile(ignore, "utf8").catch(() => "");
  const missing = IGNORE.filter((l) => !had.split(/\r?\n/).includes(l));
  if (missing.length) await fs.writeFile(ignore, `${had}${had && !had.endsWith("\n") ? "\n" : ""}${missing.join("\n")}\n`);

  const origin = (await git(["remote", "get-url", "origin"]).catch(() => "")).trim();
  const want = given.trim() ? normalizeRemote(given) : origin;
  if (want) {
    if (!origin) await git(["remote", "add", "origin", want]);
    else if (origin !== want) await git(["remote", "set-url", "origin", want]);
    return want;
  }
  if (!tools.gh) throw new Error("Enter the repository's address, or install the GitHub CLI and run gh auth login so Railnote can make one.");
  const name = path.basename(root).replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "notes";
  try {
    await run(tools.gh, ["repo", "create", name, "--private", "--source", root, "--remote", "origin"], root, tools.env);
  } catch (e) {
    throw new Error(`Couldn't make a GitHub repository called ${name}: ${(e as Error).message}`);
  }
  return (await git(["remote", "get-url", "origin"])).trim();
}

async function commitAll(git: Git, ident: string[]) {
  await git(["add", "--all"]);
  if (await ok(git(["diff", "--cached", "--quiet"]))) return;
  await git([...ident, "commit", "--quiet", "--no-verify", "-m", MSG]);
}

/** Settles every conflicted file: both changed it, so ours stays and theirs becomes a copy; one deleted it, so the edit wins. */
async function resolve(root: string, git: Git, ident: string[]): Promise<string[] | null> {
  const stages = new Map<string, Map<number, string>>();
  for (const line of (await git(["ls-files", "--unmerged", "-z"])).split("\0").filter(Boolean)) {
    const [meta, file] = line.split("\t");
    const [, sha, stage] = meta.split(" ");
    if (!stages.has(file)) stages.set(file, new Map());
    stages.get(file)!.set(Number(stage), sha);
  }
  if (!stages.size) return null;
  const copies: string[] = [];
  for (const [file, s] of stages) {
    const ours = s.get(2), theirs = s.get(3);
    if (ours && theirs) {
      const copy = conflictPath(file, (p) => stages.has(p) || copies.includes(p) || existsSync(path.join(root, p)));
      const bytes = await git.bytes(["cat-file", "blob", theirs]);
      await fs.mkdir(path.dirname(path.join(root, copy)), { recursive: true });
      await fs.writeFile(path.join(root, copy), bytes);
      await git(["checkout", "--ours", "--", file]);
      await git(["add", "--", file, copy]);
      copies.push(copy);
    } else if (ours || theirs) {
      await git(["checkout", ours ? "--ours" : "--theirs", "--", file]);
      await git(["add", "--", file]);
    } else await git(["rm", "--quiet", "--cached", "--", file]);
  }
  await git([...ident, "commit", "--quiet", "--no-verify", "--no-edit"]);
  return copies;
}

/** One round: commit, fetch, merge, push. Returns the conflict copies it made. */
export async function gitSyncOnce(root: string, tools: GitTools): Promise<string[]> {
  const git = gitFor(root, tools);
  const ident = await identity(git);
  // A round that stopped mid-merge (the app quit) leaves the merge open; start that one again.
  if (await ok(git(["rev-parse", "--verify", "--quiet", "MERGE_HEAD"]))) await git(["merge", "--abort"]).catch(() => "");
  await commitAll(git, ident);
  const branch = (await git(["symbolic-ref", "--short", "HEAD"])).trim();
  await git(["fetch", "--quiet", "origin"]);
  const theirs = `refs/remotes/origin/${branch}`;
  const remoteHas = await ok(git(["rev-parse", "--verify", "--quiet", theirs]));
  const localHas = await ok(git(["rev-parse", "--verify", "--quiet", "HEAD"]));
  let copies: string[] = [];
  if (remoteHas) {
    const merge = () => git([...ident, "merge", "--quiet", "--no-edit", "--no-verify", "--allow-unrelated-histories", theirs]);
    try {
      await merge();
    } catch (e) {
      const settled = await resolve(root, git, ident);
      if (settled) copies = settled;
      else {
        // A note saved between the commit and the merge; commit it and try again.
        if (!/overwritten/.test(String((e as Error).message) + ((e as { stderr?: string }).stderr ?? ""))) throw e;
        await commitAll(git, ident);
        await merge().catch(async (again) => {
          const later = await resolve(root, git, ident);
          if (!later) throw again;
          copies = later;
        });
      }
    }
  }
  if (!(await ok(git(["rev-parse", "--verify", "--quiet", "HEAD"])))) return copies;
  const ahead = remoteHas ? Number((await git(["rev-list", "--count", `${theirs}..HEAD`])).trim()) : localHas ? 1 : 0;
  if (ahead > 0) await git(["push", "--quiet", "-u", "origin", `HEAD:refs/heads/${branch}`]);
  return copies;
}
