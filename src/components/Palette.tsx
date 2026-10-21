import { useEffect, useMemo, useRef, useState } from "react";

export interface PaletteItem {
  id: string;
  label: string;
  hint?: string;
  run(): void;
}

/** Keyboard-first picker used for the quick switcher, the command palette and template insertion. */
export function Palette(props: { placeholder: string; items: (query: string) => PaletteItem[]; onClose(): void }) {
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);
  const items = useMemo(() => props.items(query), [query, props]);
  // The list redraws under a resting pointer, which can point past its end until the reset below runs.
  const at = Math.max(0, Math.min(sel, items.length - 1));
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => setSel(0), [query]);
  useEffect(() => {
    list.current?.children[at]?.scrollIntoView({ block: "nearest" });
  }, [at]);

  const choose = (i: number) => {
    const item = items[i];
    if (!item) return;
    props.onClose();
    item.run();
  };

  return (
    <div className="overlay" onMouseDown={props.onClose}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()}>
        <input
          autoFocus
          value={query}
          placeholder={props.placeholder}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") setSel(Math.min(at + 1, items.length - 1));
            else if (e.key === "ArrowUp") setSel(Math.max(at - 1, 0));
            else if (e.key === "Enter") choose(at);
            else if (e.key === "Escape") props.onClose();
            else return;
            e.preventDefault();
          }}
        />
        <div className="palette-list" ref={list}>
          {items.map((it, i) => (
            <div key={it.id} className={`palette-item${i === at ? " sel" : ""}`} onMouseMove={() => i !== at && setSel(i)} onClick={() => choose(i)}>
              <span>{it.label}</span>
              {it.hint && <span className="hint">{it.hint}</span>}
            </div>
          ))}
          {!items.length && <div className="palette-empty">No matches</div>}
        </div>
      </div>
    </div>
  );
}
