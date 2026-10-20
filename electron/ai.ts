import Anthropic from "@anthropic-ai/sdk";
import type { AskSource, OrganizeRequest, OrganizeSuggestion } from "../shared/types";

export const DEFAULT_MODEL = "claude-opus-5-5";

// Refusals reroute server-side instead of failing the request.
const FALLBACK = { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const };

function client(apiKey?: string) {
  // No key in settings: the SDK falls back to ANTHROPIC_API_KEY or an `ant auth login` profile.
  return new Anthropic(apiKey ? { apiKey } : {});
}

export function describeError(e: unknown): string {
  if (e instanceof Anthropic.AuthenticationError) return "Claude rejected the API key. Check it in Settings.";
  if (e instanceof Anthropic.RateLimitError) return "Rate limited by the Claude API. Try again in a minute.";
  if (e instanceof Anthropic.APIError) return `Claude API error ${e.status ?? ""}: ${e.message}`;
  const msg = (e as Error)?.message ?? String(e);
  if (/Could not resolve authentication method/.test(msg)) return "Add your Anthropic API key in Settings (⌘,) to use Ask and Organize.";
  return msg;
}

const ASK_SYSTEM = `You answer questions using only the user's own notes, given below as <note> elements.
Cite the notes you used inline as wikilinks with the note's path minus ".md", e.g. [[Notes/Caching]].
If the notes don't contain the answer, say so plainly and suggest what note might be worth writing.
Keep answers short and concrete. Use Markdown.`;

export async function ask(
  apiKey: string | undefined,
  model: string,
  question: string,
  sources: AskSource[],
  onDelta: (text: string) => void,
) {
  const notes = sources
    .map((s) => `<note path="${s.path.replace(/"/g, "'")}">\n${s.text}\n</note>`)
    .join("\n\n");
  const stream = client(apiKey).beta.messages.stream({
    model,
    max_tokens: 64000,
    output_config: { effort: "low" },
    ...FALLBACK,
    system: ASK_SYSTEM,
    messages: [{ role: "user", content: `${notes || "(no matching notes)"}\n\nQuestion: ${question}` }],
  });
  for await (const event of stream) {
    if (event.type === "content_block_delta" && event.delta.type === "text_delta") onDelta(event.delta.text);
  }
  const final = await stream.finalMessage();
  if (final.stop_reason === "refusal") onDelta("\n\n_Claude declined to answer this one._");
}

const ORGANIZE_SCHEMA = {
  type: "object",
  properties: {
    folder: { type: "string", description: "Existing or new folder path for the note, no leading or trailing slash. Empty string for the vault root." },
    tags: { type: "array", items: { type: "string" }, description: "2-5 lowercase tags without #, reusing existing tags when they fit." },
    links: {
      type: "array",
      items: {
        type: "object",
        properties: { note: { type: "string" }, reason: { type: "string" } },
        required: ["note", "reason"],
        additionalProperties: false,
      },
      description: "Up to 5 existing notes worth linking, by exact name from the list.",
    },
    summary: { type: "string", description: "One sentence on what the note is about." },
  },
  required: ["folder", "tags", "links", "summary"],
  additionalProperties: false,
};

export async function organize(apiKey: string | undefined, model: string, req: OrganizeRequest): Promise<OrganizeSuggestion> {
  const prompt = `Suggest where this note belongs in my vault.

Existing folders:
${req.folders.map((f) => `- ${f || "(root)"}`).join("\n") || "(none)"}

Existing tags: ${req.tags.join(", ") || "(none)"}

Existing notes:
${req.noteNames.map((n) => `- ${n}`).join("\n")}

Prefer existing folders and tags. Only link notes that appear in the list and are genuinely related.

<note path="${req.path}">
${req.content.slice(0, 20000)}
</note>`;
  const res = await client(apiKey).beta.messages.create({
    model,
    max_tokens: 16000,
    output_config: { effort: "low", format: { type: "json_schema", schema: ORGANIZE_SCHEMA } },
    ...FALLBACK,
    messages: [{ role: "user", content: prompt }],
  });
  if (res.stop_reason === "refusal") throw new Error("Claude declined to organize this note.");
  const text = res.content.find((b) => b.type === "text");
  if (!text || text.type !== "text") throw new Error("Claude returned no suggestion.");
  const out = JSON.parse(text.text) as OrganizeSuggestion;
  const names = new Set(req.noteNames.map((n) => n.toLowerCase()));
  out.links = out.links.filter((l) => names.has(l.note.toLowerCase()));
  out.tags = out.tags.map((t) => t.replace(/^#/, "").trim().toLowerCase().replace(/\s+/g, "-")).filter(Boolean);
  out.folder = out.folder.replace(/^\/+|\/+$/g, "");
  return out;
}
