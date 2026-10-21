// Plays the explainers in an exported note. Built on its own (vite.export.config.ts) and inlined
// into the page, so the file works with no app and no network. Sets window.__railnoteReady once
// every explainer has drawn, which the PDF printer waits for.
import { CanvizPlayer, type DiagramData, type PlayerOptions } from "../plugins/canviz/player";

async function start() {
  const players: Promise<void>[] = [];
  // Printing shows each explainer's finished frame, since a page can't play.
  const still = document.documentElement.dataset.still === "end";
  for (const el of document.querySelectorAll<HTMLElement>(".rn-explainer")) {
    const json = el.querySelector("script[type='application/json']")?.textContent;
    if (!json) continue;
    try {
      const { data, opts } = JSON.parse(json) as { data: DiagramData; opts: PlayerOptions };
      const host = document.createElement("div");
      el.append(host);
      const player = new CanvizPlayer(host, data, still ? { ...opts, autoplay: false } : opts);
      players.push(player.ready.then(() => (still ? player.seek(Infinity) : undefined)));
    } catch (e) {
      el.textContent = `This explainer couldn't play: ${(e as Error).message}`;
    }
  }
  await Promise.all(players);
  requestAnimationFrame(() => requestAnimationFrame(() => ((window as { __railnoteReady?: boolean }).__railnoteReady = true)));
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
else start();
