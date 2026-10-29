import { Facet } from "@codemirror/state";

/** Where a followed link opens: in place, in a new tab, or in the other pane. */
export type OpenWhere = "here" | "tab" | "split";
/** Cmd/Ctrl+click opens a new tab, Cmd/Ctrl+Alt+click opens beside. */
export const whereFrom = (e: { metaKey: boolean; ctrlKey: boolean; altKey: boolean }): OpenWhere =>
  e.metaKey || e.ctrlKey ? (e.altKey ? "split" : "tab") : "here";

/** What the editor's widgets may ask of the app. Each editor (pane) provides its own. */
export interface EditorHooks {
  /** Vault path of the note this editor shows. */
  notePath: string;
  /** Vault path of an attachment as a note wrote it, plus a counter that changes when the file does. */
  resolveFile(src: string): { path: string; version: number } | null;
  /** Vault path of the note a [[link]] points to. */
  resolveNote(target: string): string | null;
  noteContent(path: string): string | null;
  openLink(target: string, where: OpenWhere): void;
  openUrl(url: string): void;
  /** Open a vault file in the system's default app. */
  openInSystem(path: string): void;
}

const none: EditorHooks = {
  notePath: "",
  resolveFile: () => null,
  resolveNote: () => null,
  noteContent: () => null,
  openLink: () => {},
  openUrl: () => {},
  openInSystem: () => {},
};

export const editorHooks = Facet.define<EditorHooks, EditorHooks>({ combine: (v) => v[0] ?? none });

/** URL the page can load a vault file from: railnote-file:// on desktop, the service worker's vault/ on a phone. */
export const fileUrl = (path: string, version = 0) =>
  `${(window as any).railnote?.kind === "phone" ? "vault/" : "railnote-file://vault/"}${path.split("/").map(encodeURIComponent).join("/")}${version ? `?v=${version}` : ""}`;
