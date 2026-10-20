import { useEffect, useState } from "react";
import type { Settings } from "../../shared/types";
import { host } from "../workspace";
import type { PluginEntry } from "../plugins/loader";

export function Welcome({ settings, onOpened }: { settings: Settings; onOpened(dir: string, files: Awaited<ReturnType<typeof host.openVault>>): void }) {
  const [err, setErr] = useState<string | null>(null);
  const go = async (fn: () => Promise<[string, Awaited<ReturnType<typeof host.openVault>>] | null>) => {
    try {
      const r = await fn();
      if (r) onOpened(r[0], r[1]);
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <div className="welcome">
      <div className="drag-region" />
      <div className="welcome-card">
        <h1>Railnote</h1>
        <p className="muted">Plain Markdown notes that work the moment you open them. Your files stay yours, in a folder you can open with anything.</p>
        <button
          className="primary big"
          onClick={() =>
            go(async () => {
              const files = await host.createVault("");
              const s = await host.getSettings();
              return [s.vaultPath!, files];
            })
          }
        >
          Start a new vault
        </button>
        <div className="muted small">Creates Documents/Railnote with an inbox, daily notes, templates and a short welcome note.</div>
        <button
          className="big"
          onClick={() =>
            go(async () => {
              const dir = await host.chooseVault();
              return dir ? [dir, await host.openVault(dir)] : null;
            })
          }
        >
          Open a folder (works with an Obsidian vault)
        </button>
        {settings.recentVaults.length > 0 && (
          <>
            <h4>Recent</h4>
            {settings.recentVaults.map((v) => (
              <div key={v} className="recent" onClick={() => go(async () => [v, await host.openVault(v)])}>{v}</div>
            ))}
          </>
        )}
        {err && <div className="error">{err}</div>}
      </div>
    </div>
  );
}

export function SettingsDialog({ settings, plugins, onClose, onSaved, onPluginsChanged, onSwitchVault }: { settings: Settings; plugins: PluginEntry[]; onClose(): void; onSaved(s: Settings): void; onPluginsChanged(s: Settings): Promise<void>; onSwitchVault(): void }) {
  const [key, setKey] = useState("");
  const [model, setModel] = useState(settings.model);
  const [daily, setDaily] = useState(settings.dailyFolder);
  const [inbox, setInbox] = useState(settings.inboxFolder);
  const [templates, setTemplates] = useState(settings.templatesFolder);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const save = async () => {
    const patch: Partial<Settings> = { model: model.trim() || settings.model, dailyFolder: daily.trim(), inboxFolder: inbox.trim(), templatesFolder: templates.trim() };
    if (key) patch.anthropicApiKey = key.trim();
    onSaved(await host.setSettings(patch));
    onClose();
  };
  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="dialog" onMouseDown={(e) => e.stopPropagation()}>
        <h3>Settings</h3>
        <h4>Claude</h4>
        <label className="field">
          API key {settings.anthropicApiKey ? <span className="muted">(saved; type to replace)</span> : <span className="muted">(or set ANTHROPIC_API_KEY)</span>}
          <input type="password" value={key} placeholder={settings.anthropicApiKey ? "••••••••" : "sk-ant-…"} onChange={(e) => setKey(e.target.value)} />
        </label>
        {settings.anthropicApiKey && (
          <button className="mini" onClick={async () => { onSaved(await host.setSettings({ anthropicApiKey: "" })); }}>Remove saved key</button>
        )}
        <label className="field">
          Model
          <input value={model} onChange={(e) => setModel(e.target.value)} />
        </label>
        <p className="muted small">The key is stored on this machine only, readable by your user account. Ask and Organize send only the passages they need.</p>
        <h4>Folders</h4>
        <label className="field">Inbox<input value={inbox} onChange={(e) => setInbox(e.target.value)} /></label>
        <label className="field">Daily notes<input value={daily} onChange={(e) => setDaily(e.target.value)} /></label>
        <label className="field">Templates<input value={templates} onChange={(e) => setTemplates(e.target.value)} /></label>
        <PluginSettings settings={settings} plugins={plugins} onChanged={onPluginsChanged} />
        <h4>Vault</h4>
        <div className="muted small">{settings.vaultPath}</div>
        <button className="mini" onClick={onSwitchVault}>Switch vault…</button>
        <div className="dialog-foot">
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={save}>Save</button>
        </div>
      </div>
    </div>
  );
}

/** Toggles apply right away, like the rest of the app, rather than waiting for Save. */
function PluginSettings({ settings, plugins, onChanged }: { settings: Settings; plugins: PluginEntry[]; onChanged(s: Settings): Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const vault = settings.vaultPath ?? "";
  const trusted = !!settings.trustedVaults?.includes(vault);
  const apply = async (patch: Partial<Settings>) => {
    setBusy(true);
    try {
      await onChanged(await host.setSettings(patch));
    } finally {
      setBusy(false);
    }
  };
  const toggle = (id: string, on: boolean) => apply({ plugins: { ...settings.plugins, [id]: on } });
  const row = (p: PluginEntry, canToggle: boolean) => (
    <label key={p.id} className="plugin-row">
      <input type="checkbox" checked={p.enabled} disabled={busy || !canToggle} onChange={(e) => toggle(p.id, e.target.checked)} />
      <span className="plugin-text">
        <span className="plugin-name">
          {p.name}
          {p.version && <span className="muted"> {p.version}</span>}
        </span>
        {p.description && <span className="muted small">{p.description}</span>}
        {p.error && <span className="plugin-error small">{p.error}</span>}
      </span>
    </label>
  );
  const builtin = plugins.filter((p) => p.builtin);
  const local = plugins.filter((p) => !p.builtin);
  return (
    <>
      <h4>Plugins</h4>
      {builtin.map((p) => row(p, true))}
      <div className="plugin-vault">
        <div className="muted small">
          {local.length ? `In this vault's .railnote/plugins folder:` : "Add your own in this vault's .railnote/plugins folder, one folder per plugin with a manifest.json and main.js."}
        </div>
        {trusted ? (
          <>
            {local.map((p) => row(p, !p.error || p.enabled))}
            <div className="plugin-actions">
              <button className="mini" disabled={busy} onClick={() => apply({})}>Reload plugins</button>
              <button className="mini" disabled={busy} onClick={() => apply({ trustedVaults: settings.trustedVaults?.filter((v) => v !== vault) })}>Stop running this vault's plugins</button>
            </div>
          </>
        ) : (
          <>
            {local.map((p) => row(p, false))}
            <p className="muted small">Plugins run with the same access as Railnote: they can read and change every file in this vault. Only allow them if you wrote them or trust where they came from.</p>
            <button className="mini" disabled={busy} onClick={() => apply({ trustedVaults: [...(settings.trustedVaults ?? []), vault] })}>Allow plugins in this vault</button>
          </>
        )}
      </div>
    </>
  );
}
