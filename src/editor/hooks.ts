import { Facet } from "@codemirror/state";

/** What the editor's widgets may ask of the app. Each editor (pane) provides its own. */
export interface EditorHooks {
  /** Vault path of the note this editor shows. */
  notePath: string;
  /** Vault path of an attachment as a note wrote it, plus a counter that changes when the file does. */
  resolveFile(src: string): { path: string; version: number } | null;
  /** Vault path of the note a [[link]] points to. */
  resolveNote(target: string): string | null;
  noteContent(path: string): string | null;
  openLink(target: string, newPane: boolean): void;
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

/** railnote-file:// URL the page can load a vault file from. */
export const fileUrl = (path: string, version = 0) =>
  `railnote-file://vault/${path.split("/").map(encodeURIComponent).join("/")}${version ? `?v=${version}` : ""}`;
