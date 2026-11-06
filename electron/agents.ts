/**
 * Ask and Organize through a coding agent the user already has (Claude Code, Codex, OpenCode),
 * run in the vault folder. The agent searches and reads the notes itself, on the user's own
 * subscription, so Railnote needs no API key.
 */
import { execFile, spawn } from "child_process";
import fs from "fs/promises";
import path from "path";
import readline from "readline";
import type { AgentId, AgentInfo, OrganizeRequest, OrganizeSuggestion } from "../shared/types";
import { ORGANIZE_SCHEMA, organizePrompt, tidySuggestion } from "./ai";

const AGENTS: { id: AgentId; name: string; bin: string }[] = [
  { id: "claude", name: "Claude Code", bin: "claude" },
  { id: "codex", name: "Codex", bin: "codex" },
  { id: "opencode", name: "OpenCode", bin: "opencode" },
];

/** Five minutes is plenty for a question; a stuck agent shouldn't hang Ask forever. */
const TIMEOUT = 5 * 60_000;

let shellPath: Promise<string> | undefined;

/** An app opened from the Dock gets a bare PATH; the user's login shell knows where the agents live. */
function userPath(): Promise<string> {
  return (shellPath ??= new Promise((resolve) => {
    const shell = process.env.SHELL || "/bin/zsh";
    execFile(shell, ["-ilc", 'printf "\\n__RAILNOTE_PATH__%s" "$PATH"'], { timeout: 10_000 }, (_err, out) => {
      const found = /__RAILNOTE_PATH__(.*)$/m.exec(String(out ?? ""))?.[1];
      const extra = [path.join(process.env.HOME || "", ".local/bin"), "/opt/homebrew/bin", "/usr/local/bin"];
      resolve([found || process.env.PATH || "", ...extra].join(":"));
    });
  }));
}

async function which(bin: string): Promise<string | null> {
  for (const dir of (await userPath()).split(":")) {
    if (!dir) continue;
    const p = path.join(dir, bin);
    try {
      await fs.access(p, fs.constants.X_OK);
      return p;
    } catch {}
  }
  return null;
}

export async function listAgents(): Promise<AgentInfo[]> {
  return Promise.all(AGENTS.map(async (a) => ({ id: a.id, name: a.name, installed: !!(await which(a.bin)) })));
}

/** The agent to use when the user hasn't picked one: the first one installed. */
export async function defaultAgent(): Promise<AgentId | null> {
  return (await listAgents()).find((a) => a.installed)?.id ?? null;
}

export const agentName = (id: AgentId) => AGENTS.find((a) => a.id === id)!.name;

interface RunOptions {
  /** May the agent change files in the vault? Version history keeps what it replaced. */
  edit: boolean;
  /** Extra instructions, sent as a system prompt where the agent takes one. */
  system: string;
  onText?: (delta: string) => void;
  /** Claude Code only: the JSON schema its final answer must match. */
  schema?: object;
  /** The agent's model, when not its own default. */
  model?: string;
}

function args(id: AgentId, cwd: string, prompt: string, o: RunOptions): string[] {
  switch (id) {
    case "claude": {
      const tools = o.edit ? ["Read", "Grep", "Glob", "Edit", "Write"] : ["Read", "Grep", "Glob"];
      return [
        "-p", prompt,
        "--output-format", "stream-json", "--verbose", "--include-partial-messages",
        "--append-system-prompt", o.system,
        "--tools", tools.join(","), "--allowedTools", tools.join(","),
        "--permission-mode", o.edit ? "acceptEdits" : "default",
        "--no-session-persistence", "--strict-mcp-config",
        ...(o.schema ? ["--json-schema", JSON.stringify(o.schema)] : []),
        ...(o.model ? ["--model", o.model] : []),
      ];
    }
    case "codex":
      // Codex has no system prompt flag here; the instructions lead the prompt instead.
      return ["exec", ...(o.model ? ["-m", o.model] : []), "--json", "--skip-git-repo-check", "--ephemeral", "--sandbox", o.edit ? "workspace-write" : "read-only", "-C", cwd, `${o.system}\n\n${prompt}`];
    case "opencode":
      // The plan agent can read and search but not change files.
      return ["run", ...(o.model ? ["-m", o.model] : []), "--format", "json", "--dir", cwd, ...(o.edit ? [] : ["--agent", "plan"]), `${o.system}\n\n${prompt}`];
  }
}

/** Pulls a readable message out of an agent's error, which is sometimes JSON inside a string. */
function message(raw: unknown): string {
  let m: unknown = raw;
  for (let i = 0; i < 3 && typeof m === "string" && m.trim().startsWith("{"); i++) {
    try {
      const j = JSON.parse(m);
      m = j.error?.message ?? j.message ?? j.error ?? m;
    } catch {
      break;
    }
  }
  if (m && typeof m === "object") m = (m as { message?: string; data?: { message?: string } }).message ?? (m as { data?: { message?: string } }).data?.message ?? JSON.stringify(m);
  return String(m ?? "the agent failed");
}

/**
 * Runs one agent turn in the vault and resolves with its whole answer, streaming text as it comes.
 * Each agent prints JSON lines; only the parts that are the answer reach onText.
 */
export async function runAgent(id: AgentId, cwd: string, prompt: string, o: RunOptions): Promise<{ text: string; structured?: unknown }> {
  const bin = await which(AGENTS.find((a) => a.id === id)!.bin);
  if (!bin) throw new Error(`${agentName(id)} isn't installed, or isn't on your PATH. Install it or pick another agent in Settings (⌘,).`);
  const child = spawn(bin, args(id, cwd, prompt, o), { cwd, env: { ...process.env, PATH: await userPath() }, stdio: ["ignore", "pipe", "pipe"] });
  let text = "";
  let structured: unknown;
  let failure: string | undefined;
  let stderr = "";
  const say = (t: string) => {
    if (!t) return;
    text += t;
    o.onText?.(t);
  };
  // Separates what the agent says between tool calls ("Let me look…") from what follows.
  const block = () => text && !text.endsWith("\n\n") && say("\n\n");

  const lines = readline.createInterface({ input: child.stdout });
  const read = new Promise((r) => lines.once("close", r));
  lines.on("line", (line) => {
    let e: any;
    try {
      e = JSON.parse(line);
    } catch {
      return;
    }
    if (id === "claude") {
      if (e.type === "stream_event") {
        const ev = e.event;
        if (ev?.type === "content_block_start" && ev.content_block?.type === "text") block();
        else if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta") say(ev.delta.text);
      } else if (e.type === "result") {
        if (e.is_error || e.subtype !== "success") failure = message(e.result || e.errors?.join("; ") || e.subtype);
        structured = e.structured_output;
      }
    } else if (id === "codex") {
      if (e.type === "item.completed" && e.item?.type === "agent_message") (block(), say(e.item.text));
      else if (e.type === "turn.failed") failure = message(e.error?.message ?? e.error);
      else if (e.type === "error") failure = message(e.message);
    } else {
      if (e.type === "text" && e.part?.text) (block(), say(e.part.text));
      else if (e.type === "error") failure = message(e.error ?? e.part ?? e.message);
    }
  });
  child.stderr.on("data", (d) => (stderr = (stderr + d).slice(-4000)));

  const code = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      failure = `${agentName(id)} took longer than five minutes, so Railnote stopped it.`;
    }, TIMEOUT);
    child.on("error", (err) => (clearTimeout(timer), reject(err)));
    child.on("close", (c) => (clearTimeout(timer), resolve(c)));
  });
  await read;
  if (failure) {
    if (/requires a newer version of Codex/.test(failure)) failure += ` (Railnote runs ${bin}; update it with \`npm i -g @openai/codex\`.)`;
    else if (/not supported when using Codex with a ChatGPT account/.test(failure)) failure += " Set a model your plan includes, such as gpt-5.6-sol, under Agent model in Settings (⌘,).";
    throw new Error(`${agentName(id)}: ${failure}`);
  }
  if (code !== 0 && !text) {
    const last = stderr.trim().split("\n").filter((l) => !/^Restored session/.test(l)).pop();
    throw new Error(`${agentName(id)} stopped (exit ${code})${last ? `: ${last}` : "."}`);
  }
  return { text, structured };
}

const ASK_SYSTEM = (edit: boolean) => `You are answering inside Railnote, a Markdown notes app. The current directory is the user's notes vault.
Search and read the notes to answer. Cite the notes you used inline as wikilinks with the note's path minus ".md", e.g. [[Notes/Caching]].
If the notes don't contain the answer, say so plainly and suggest what note might be worth writing.
${edit ? "You may create and edit notes when the user asks you to; say which notes you changed." : "Don't change any files; this is read-only."}
Keep answers short and concrete. Use Markdown. Don't narrate your searching.`;

export async function askAgent(id: AgentId, vault: string, question: string, hints: string[], edit: boolean, model: string | undefined, onText: (t: string) => void) {
  const prompt = hints.length ? `${question}\n\n(Railnote's own search suggests these notes may be relevant: ${hints.join(", ")})` : question;
  await runAgent(id, vault, prompt, { edit, system: ASK_SYSTEM(edit), onText, model });
}

const ORGANIZE_SYSTEM = `You are filing a note inside Railnote, a Markdown notes app. The current directory is the user's notes vault.
Don't change any files. Reply with only a JSON object, no prose and no code fence, matching this schema:
${JSON.stringify(ORGANIZE_SCHEMA)}`;

export async function organizeWithAgent(id: AgentId, vault: string, req: OrganizeRequest, model?: string): Promise<OrganizeSuggestion> {
  const { text, structured } = await runAgent(id, vault, organizePrompt(req), { edit: false, model, system: ORGANIZE_SYSTEM, schema: id === "claude" ? ORGANIZE_SCHEMA : undefined });
  let out = structured as OrganizeSuggestion | undefined;
  if (!out || typeof out !== "object") {
    const json = /\{[\s\S]*\}/.exec(text)?.[0];
    try {
      out = JSON.parse(json ?? "");
    } catch {
      throw new Error(`${agentName(id)} didn't return a suggestion Railnote could read.`);
    }
  }
  return tidySuggestion(req, out!);
}
