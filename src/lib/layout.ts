// Open notes: up to two panes side by side, each a route of stops (the notes you've travelled through) with one showing.

import type { OpenWhere } from "../editor/hooks";

export interface Pane {
  tabs: string[];
  active: string | null;
}

export interface Layout {
  panes: Pane[];
  /** Index of the pane in use: the one commands and the sidebar follow. */
  focus: number;
}

/** A route longer than this sheds the stops furthest from where you are. */
export const ROUTE_STOPS = 7;

export const emptyLayout = (): Layout => ({ panes: [{ tabs: [], active: null }], focus: 0 });

const copy = (l: Layout): Pane[] => l.panes.map((p) => ({ tabs: [...p.tabs], active: p.active }));

/** Drops the stops furthest from the one showing until the route fits, the earliest first on a tie. */
function trim(p: Pane) {
  while (p.tabs.length > ROUTE_STOPS) {
    const here = p.active ? p.tabs.indexOf(p.active) : 0;
    p.tabs.splice(here >= p.tabs.length - 1 - here ? 0 : p.tabs.length - 1, 1);
  }
}

/**
 * Shows `path` as the next stop after the current one ("here"), adds it as the next stop without
 * leaving ("tab"), or shows it in the other pane ("split"). A note already on the route isn't added twice.
 */
export function place(l: Layout, path: string, where: OpenWhere): Layout {
  const panes = copy(l);
  let focus = l.focus;
  if (where === "split") {
    if (panes.length < 2) panes.push({ tabs: [], active: null });
    focus = focus === 0 ? 1 : 0;
  }
  const p = panes[focus];
  if (!p.tabs.includes(path)) {
    const i = p.active ? p.tabs.indexOf(p.active) : -1;
    p.tabs.splice(i + 1, 0, path);
  }
  if (where !== "tab" || !p.active) p.active = path;
  trim(p);
  return { panes, focus };
}

/** Closes one tab. A pane left with no tabs goes away while another pane remains. */
export function closeTab(l: Layout, pane: number, path: string): Layout {
  const panes = copy(l);
  const p = panes[pane];
  const k = p?.tabs.indexOf(path) ?? -1;
  if (k < 0) return l;
  p.tabs.splice(k, 1);
  if (p.active === path) p.active = p.tabs[Math.min(k, p.tabs.length - 1)] ?? null;
  if (!p.tabs.length && panes.length > 1) {
    panes.splice(pane, 1);
    return { panes, focus: 0 };
  }
  return { panes, focus: pane };
}

/** Follows renames and deletions: `f` gives each path's new path, or null when the note is gone. */
export function retarget(l: Layout, f: (path: string) => string | null): Layout {
  let panes = l.panes.map((p) => {
    const tabs = [...new Set(p.tabs.map(f).filter((x): x is string => !!x))];
    const a = p.active ? f(p.active) : null;
    return { tabs, active: a && tabs.includes(a) ? a : (tabs[0] ?? null) };
  });
  if (panes.length > 1) panes = panes.filter((p) => p.tabs.length);
  if (!panes.length) return emptyLayout();
  return { panes, focus: Math.min(l.focus, panes.length - 1) };
}

/** Moves to the next or previous tab in the pane in use, wrapping around. */
export function cycle(l: Layout, step: number): Layout {
  const panes = copy(l);
  const p = panes[l.focus];
  if (p.tabs.length < 2) return l;
  const i = p.active ? p.tabs.indexOf(p.active) : 0;
  p.active = p.tabs[(i + step + p.tabs.length) % p.tabs.length];
  return { panes, focus: l.focus };
}

/** Joins the two panes into the one in use, keeping every tab. */
export function unsplit(l: Layout): Layout {
  if (l.panes.length < 2) return l;
  const keep = l.panes[l.focus];
  const other = l.panes[l.focus === 0 ? 1 : 0];
  return { panes: [{ tabs: [...new Set([...keep.tabs, ...other.tabs])], active: keep.active }], focus: 0 };
}

/** Moves a tab to another pane (or a new one at index 1), placing it before `before` if given. */
export function moveTab(l: Layout, from: number, path: string, to: number, before?: string): Layout {
  const panes = copy(l);
  if (to >= panes.length) panes.push({ tabs: [], active: null });
  const src = panes[from];
  const k = src.tabs.indexOf(path);
  if (k < 0) return l;
  src.tabs.splice(k, 1);
  if (src.active === path) src.active = src.tabs[Math.min(k, src.tabs.length - 1)] ?? null;
  const dst = panes[to];
  const had = dst.tabs.indexOf(path);
  if (had >= 0) dst.tabs.splice(had, 1);
  const at = before ? dst.tabs.indexOf(before) : -1;
  dst.tabs.splice(at < 0 ? dst.tabs.length : at, 0, path);
  dst.active = path;
  let focus = to;
  if (!src.tabs.length && panes.length > 1) {
    panes.splice(from, 1);
    if (to > from) focus = to - 1;
  }
  return { panes, focus };
}
