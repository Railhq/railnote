// `node check.mjs <file>...`: checks explainer files (.canviz or .json) and notes with ```canviz
// blocks, printing the message Railnote would show. Built into each vault's agent skill.

import fs from "fs";
import { parseExplainer } from "../src/plugins/canviz/check";

let failed = false;
for (const file of process.argv.slice(2)) {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    console.log(`${file}: can't read it (${(e as Error).message})`);
    failed = true;
    continue;
  }
  const inline: string[] = [];
  if (file.endsWith(".md"))
    for (const m of text.matchAll(/^(`{3,})canviz[^\n]*\n([\s\S]*?)^\1\s*$/gm)) if (m[2].trim().startsWith("{")) inline.push(m[2]);
  const docs = file.endsWith(".md") ? inline.map((t, i) => [t, `${file}, explainer block ${i + 1}`]) : [[text, file]];
  if (file.endsWith(".md") && !docs.length) console.log(`${file}: no inline explainer blocks (src: files are checked on their own)`);
  for (const [t, where] of docs) {
    try {
      parseExplainer(t, where);
      console.log(`${where}: ok`);
    } catch (e) {
      console.log((e as Error).message);
      failed = true;
    }
  }
}
process.exit(failed ? 1 : 0);
