import type { PluginManifest, Settings } from "../../shared/types";
import type { PluginModule } from "./api";
import { builtinPlugins } from "./builtin";
import { plugins } from "./host";

export interface PluginEntry {
  id: string;
  name: string;
  description?: string;
  version?: string;
  author?: string;
  builtin: boolean;
  enabled: boolean;
  loaded: boolean;
  error?: string;
}

const errors = new Map<string, string>();

export const isEnabled = (s: Settings, id: string, builtin: boolean) => s.plugins?.[id] ?? builtin;

/** Load what Settings switches on and unload the rest. Returns every plugin it knows of, for Settings. */
export async function syncPlugins(s: Settings, vaultPlugins: PluginManifest[]): Promise<PluginEntry[]> {
  const trusted = !!s.vaultPath && !!s.trustedVaults?.includes(s.vaultPath);
  const builtinIds = new Set(builtinPlugins.map((p) => p.id));
  const out: PluginEntry[] = [];
  for (const p of builtinPlugins) {
    const on = isEnabled(s, p.id, true);
    if (on && !plugins.loaded(p.id)) {
      errors.delete(p.id);
      await plugins.load(p.id, p.name, p).catch((e) => errors.set(p.id, (e as Error).message));
    } else if (!on && plugins.loaded(p.id)) plugins.unload(p.id);
    out.push({ id: p.id, name: p.name, description: p.description, builtin: true, enabled: on, loaded: plugins.loaded(p.id), error: errors.get(p.id) });
  }
  const seen = new Set<string>();
  for (const m of vaultPlugins) {
    seen.add(m.id);
    let error = m.error ?? (builtinIds.has(m.id) ? "a built-in plugin already uses this id" : undefined);
    const on = isEnabled(s, m.id, false);
    if (!error && on && trusted) {
      if (!plugins.loaded(m.id)) {
        try {
          const mod = await import(/* @vite-ignore */ m.url!);
          const entry: PluginModule | undefined = typeof mod.default?.activate === "function" ? mod.default : typeof mod.activate === "function" ? mod : undefined;
          if (!entry) throw new Error("main.js must export an activate(railnote) function");
          await plugins.load(m.id, m.name, entry);
          errors.delete(m.id);
        } catch (e) {
          errors.set(m.id, (e as Error).message);
        }
      }
      error = errors.get(m.id);
    } else if (plugins.loaded(m.id) && !builtinIds.has(m.id)) plugins.unload(m.id);
    out.push({ id: m.id, name: m.name, description: m.description, version: m.version, author: m.author, builtin: false, enabled: on, loaded: plugins.loaded(m.id), error });
  }
  // A plugin folder that was deleted, or a vault that was switched away from.
  for (const id of plugins.ids()) if (!builtinIds.has(id) && !seen.has(id)) plugins.unload(id);
  return out;
}
