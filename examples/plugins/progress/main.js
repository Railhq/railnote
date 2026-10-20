// A complete Railnote plugin. Copy this folder into <vault>/.railnote/plugins/progress,
// allow plugins for the vault in Settings, and switch it on.
//
// ```progress
// Chapters drafted: 7/12
// Figures: 3/5
// ```

export default {
  activate(railnote) {
    railnote.registerBlock("progress", (source, el) => {
      const rows = source.split("\n").map((line) => /^(.*?):\s*(\d+)\s*\/\s*(\d+)\s*$/.exec(line.trim())).filter(Boolean);
      if (!rows.length) throw new Error("write one `label: done/total` per line");
      el.style.cssText = "display:grid;gap:8px;padding:12px 14px;border:1px solid var(--line);border-radius:8px;font:13px var(--sans)";
      for (const [, label, done, total] of rows) {
        const pct = Math.min(100, Math.round((Number(done) / Math.max(1, Number(total))) * 100));
        const row = document.createElement("div");
        row.innerHTML = `<div style="display:flex;justify-content:space-between;margin-bottom:4px"><span></span><span style="color:var(--muted)">${done}/${total}</span></div>` +
          `<div style="height:6px;border-radius:3px;background:var(--paper-2)"><div style="height:100%;width:${pct}%;border-radius:3px;background:var(--signal)"></div></div>`;
        row.querySelector("span").textContent = label;
        el.appendChild(row);
      }
    });

    railnote.addCommand({
      id: "insert",
      label: "Insert progress block",
      run: () => railnote.workspace.insertText("```progress\nDone: 0/10\n```\n", "```progress\n".length),
    });
  },
};
