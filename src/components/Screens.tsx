import { useEffect, useState } from "react";
import type { Settings, SyncStatus } from "../../shared/types";
import { host } from "../workspace";
import type { PluginEntry } from "../plugins/loader";

export function Welcome({ settings, onOpened }: { settings: Settings; onOpened(dir: string, files: Awaited<ReturnType<typeof host.openVault>>): void }) {
  if (host.kind === "phone") return <PhoneWelcome onOpened={onOpened} />;
  return <DesktopWelcome settings={settings} onOpened={onOpened} />;
}

/** The phone's first run: bring the vault over from a computer, or start one here. */
function PhoneWelcome({ onOpened }: { onOpened(dir: string, files: Awaited<ReturnType<typeof host.openVault>>): void }) {
  // Opening the sync link itself on the phone lands here with the link in the address bar.
  const here = location.hash.length === 33 ? `${location.origin}${location.pathname.replace(/\/(index\.html)?$/, "")}${location.hash}` : "";
  const [link, setLink] = useState(here);
  const [pass, setPass] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const open = async () => {
    const s = await host.getSettings();
    onOpened(s.vaultPath!, await host.openVault(s.vaultPath!));
  };
  const join = async () => {
    setBusy(true);
    setErr(null);
    try {
      const status = await host.turnOnSync({ link: link.trim(), passphrase: pass });
      if (status.state === "error") throw new Error(status.error ?? "Couldn't sync");
      history.replaceState(null, "", location.pathname);
      await open();
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <div className="welcome phone">
      <div className="welcome-card">
        <h1>Railnote</h1>
        <p className="muted">Your notes from your computer, on this phone. Changes go both ways.</p>
        <h4>Join your vault</h4>
        <div className="muted small">On your computer, open Settings, then Sync, and copy the sync link.</div>
        <input placeholder="Sync link" value={link} onChange={(e) => setLink(e.target.value)} autoCapitalize="off" autoCorrect="off" spellCheck={false} />
        <input type="password" placeholder="Passphrase" value={pass} onChange={(e) => setPass(e.target.value)} onKeyDown={(e) => e.key === "Enter" && link && pass && join()} />
        <button className="primary big" disabled={busy || !link.trim() || !pass} onClick={join}>
          {busy ? "Bringing your notes over…" : "Join and sync"}
        </button>
        {err && <div className="error">{err}</div>}
        <div className="or muted small">or</div>
        <button
          className="big"
          disabled={busy}
          onClick={async () => {
            try {
              const files = await host.createVault("");
              const s = await host.getSettings();
              onOpened(s.vaultPath!, files);
            } catch (e) {
              setErr((e as Error).message);
            }
          }}
        >
          Start a vault on this phone
        </button>
        <div className="muted small">Notes stay on this phone until you turn on sync in Settings.</div>
      </div>
    </div>
  );
}

function DesktopWelcome({ settings, onOpened }: { settings: Settings; onOpened(dir: string, files: Awaited<ReturnType<typeof host.openVault>>): void }) {
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
  const [attachments, setAttachments] = useState(settings.attachmentsFolder ?? "Attachments");
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const save = async () => {
    const patch: Partial<Settings> = { model: model.trim() || settings.model, dailyFolder: daily.trim(), inboxFolder: inbox.trim(), templatesFolder: templates.trim(), attachmentsFolder: attachments.trim() };
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
        <label className="field">Pasted and dropped files<input value={attachments} placeholder="./ keeps them next to the note" onChange={(e) => setAttachments(e.target.value)} /></label>
        <SyncSettings />
        <PluginSettings settings={settings} plugins={plugins} onChanged={onPluginsChanged} />
        {host.kind !== "phone" && (
          <>
            <h4>Vault</h4>
            <div className="muted small">{settings.vaultPath}</div>
            <button className="mini" onClick={onSwitchVault}>Switch vault…</button>
          </>
        )}
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

/** How long ago, in words, for the sync line. */
export function agoText(t: number, now = Date.now()) {
  const s = Math.round((now - t) / 1000);
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h} h ago` : new Date(t).toLocaleDateString([], { month: "short", day: "numeric" });
}

export function syncLine(s: SyncStatus | null) {
  if (!s?.on) return null;
  if (s.state === "syncing") return "Syncing…";
  if (s.state === "error") return "Sync stopped";
  return s.last ? `Synced ${agoText(s.last)}` : "Sync on";
}

/** Sync applies right away too: turning it on talks to the server, so it can't wait for Save. */
function SyncSettings() {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [mode, setMode] = useState<"start" | "join">("start");
  const [server, setServer] = useState("");
  const [link, setLink] = useState("");
  const [pass, setPass] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    host.syncStatus().then(setStatus);
    return host.onSyncEvent((e) => setStatus(e.status));
  }, []);
  const act = async (fn: () => Promise<SyncStatus>) => {
    setBusy(true);
    setError(null);
    try {
      setStatus(await fn());
      setPass("");
      setAgain("");
    } catch (e) {
      setError((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ""));
    } finally {
      setBusy(false);
    }
  };
  if (!status) return null;
  if (status.on)
    return (
      <>
        <h4>Sync</h4>
        <p className="muted small">
          {syncLine(status)}
          {status.state === "error" && status.error ? `: ${status.error}` : "."} Notes are encrypted here before they leave; the server can't read them.
        </p>
        <label className="field">
          Link for your other devices
          <span className="sync-link">
            <input readOnly value={status.link} onFocus={(e) => e.target.select()} />
            <button className="mini" onClick={async () => { await navigator.clipboard.writeText(status.link!); setCopied(true); }}>{copied ? "Copied" : "Copy"}</button>
          </span>
        </label>
        <p className="muted small">On your phone, open this link in the browser and enter the same passphrase. Add it to your home screen to use it like an app.</p>
        <div className="sync-actions">
          <button className="mini" disabled={busy} onClick={() => act(() => host.syncNow())}>Sync now</button>
          <button className="mini" disabled={busy} onClick={() => act(() => host.turnOffSync())}>Turn off sync on this {host.kind === "phone" ? "phone" : "computer"}</button>
        </div>
      </>
    );
  const short = pass.length > 0 && pass.length < 8;
  const mismatch = mode === "start" && again.length > 0 && again !== pass;
  const ready = pass.length >= 8 && (mode === "join" ? link.trim() : server.trim() && again === pass);
  return (
    <>
      <h4>Sync</h4>
      <div className="seg sync-mode" role="tablist">
        <button role="tab" aria-selected={mode === "start"} className={mode === "start" ? "on" : ""} onClick={() => setMode("start")}>Start syncing this vault</button>
        <button role="tab" aria-selected={mode === "join"} className={mode === "join" ? "on" : ""} onClick={() => setMode("join")}>Join from another device</button>
      </div>
      {mode === "start" ? (
        <label className="field">Sync server<input value={server} placeholder="https://sync.example.com" onChange={(e) => setServer(e.target.value)} /></label>
      ) : (
        <label className="field">Link from the other device<input value={link} placeholder="https://sync.example.com#…" onChange={(e) => setLink(e.target.value)} /></label>
      )}
      <label className="field">
        Passphrase {short && <span className="muted">(at least 8 characters)</span>}
        <input type="password" value={pass} onChange={(e) => setPass(e.target.value)} />
      </label>
      {mode === "start" && (
        <label className="field">
          Passphrase again {mismatch && <span className="muted">(doesn't match)</span>}
          <input type="password" value={again} onChange={(e) => setAgain(e.target.value)} />
        </label>
      )}
      <p className="muted small">
        {mode === "start"
          ? "Notes are encrypted on each device with this passphrase. The server can't read them, and nobody can recover them if it's lost, so keep it somewhere safe."
          : "Join into an empty vault if you can. Notes already here that differ from the other device's are kept, with the other device's text beside them as a conflict copy."}
      </p>
      {error && <p className="sync-error" role="alert">{error}</p>}
      <button className="mini" disabled={busy || !ready} onClick={() => act(() => host.turnOnSync(mode === "join" ? { link: link.trim(), passphrase: pass } : { server: server.trim(), passphrase: pass }))}>
        {busy ? "Connecting…" : mode === "start" ? "Start syncing" : "Join"}
      </button>
    </>
  );
}
