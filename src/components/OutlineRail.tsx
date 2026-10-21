import { useEffect, useRef, useState } from "react";
import type { EditorView } from "@codemirror/view";

interface Heading {
  level: number;
  text: string;
  line: number;
}

interface Props {
  view: EditorView | null;
  headings: Heading[];
  /** The colour of the note's line, so its stops match the sidebar. */
  track: string;
  onJump(line: number): void;
}

/** The note's headings as stops down the margin; the one you're reading is lit. */
export function OutlineRail({ view, headings, track, onJump }: Props) {
  const [at, setAt] = useState(-1);
  // A jump lights its stop even when the note is too short to scroll that heading to the top.
  const jumped = useRef(0);
  const list = useRef(headings);
  list.current = headings;
  // A new array arrives on every render; only a real change of headings should re-place the light.
  const shape = headings.map((h) => `${h.line}:${h.level}`).join(" ");

  useEffect(() => {
    if (!view) return;
    const el = view.scrollDOM;
    const update = () => {
      if (Date.now() - jumped.current < 700) return;
      // The line just below the top of the window counts as where you are: a jump puts its heading there.
      const y = el.getBoundingClientRect().top + 96 - view.documentTop;
      const line = view.state.doc.lineAt(view.lineBlockAtHeight(Math.max(0, y)).from).number - 1;
      let cur = -1;
      for (const h of list.current) if (h.line <= line) cur = h.line;
      setAt(el.scrollTop < 4 ? (list.current[0]?.line ?? -1) : cur);
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    return () => el.removeEventListener("scroll", update);
  }, [view, shape]);

  if (headings.length < 2) return null;
  const top = Math.min(...headings.map((h) => h.level));
  return (
    <nav className="outline-rail" aria-label="Outline" style={{ "--track": track } as React.CSSProperties}>
      {headings.map((h) => (
        <button
          key={h.line}
          className={`stop${h.line === at ? " here" : ""}${h.level > top ? " sub" : ""}`}
          style={{ "--depth": Math.min(h.level - top, 2) } as React.CSSProperties}
          onClick={() => ((jumped.current = Date.now()), onJump(h.line), setAt(h.line))}
          title={h.text}
        >
          <span>{h.text}</span>
        </button>
      ))}
    </nav>
  );
}
