"use client";

import { useCallback, useEffect, useState } from "react";
import type { Provider, Persona, OAuthConnection, ProjectSummary } from "@agent-cc/shared";
import {
  listProviders2,
  createProvider,
  deleteProvider,
  setProviderKey,
  listPersonas,
  createPersona,
  deletePersona,
  listConnections,
  createConnection,
  grantOps,
  deleteConnection,
  listProjects,
  listOverlays,
  saveOverlay,
} from "@/lib/api";
import { ModelSelect } from "@/components/ModelSelect";

export type ConfigTab = "providers" | "personas" | "oauth" | "overlays";

// Cmd-K config surface: providers (+ keys), personas, OAuth connections (+ scopes).
// Secrets (API keys, tokens) are write-only — entered here, sent to the vault,
// never displayed.
export function ConfigPanel({
  open,
  tab,
  onTab,
  onClose,
  onToast,
}: {
  open: boolean;
  tab: ConfigTab;
  onTab: (t: ConfigTab) => void;
  onClose: () => void;
  onToast: (m: string) => void;
}) {
  if (!open) return null;
  const tabBtn = (id: ConfigTab, label: string) => (
    <button className={`subtab${tab === id ? " active" : ""}`} onClick={() => onTab(id)}>
      {label}
    </button>
  );
  return (
    <div className="overlay" onClick={onClose}>
      <div className="config" onClick={(e) => e.stopPropagation()}>
        <div className="subtabs">
          {tabBtn("providers", "Providers")}
          {tabBtn("personas", "Personas")}
          {tabBtn("overlays", "Overlays")}
          {tabBtn("oauth", "OAuth")}
        </div>
        <div className="config-body">
          {tab === "providers" && <Providers onToast={onToast} />}
          {tab === "personas" && <Personas onToast={onToast} />}
          {tab === "overlays" && <Overlays onToast={onToast} />}
          {tab === "oauth" && <OAuth onToast={onToast} />}
        </div>
      </div>
    </div>
  );
}

function useList<T>(load: () => Promise<T[]>): [T[], () => void] {
  const [items, setItems] = useState<T[]>([]);
  const refresh = useCallback(() => {
    void load()
      .then(setItems)
      .catch(() => setItems([]));
  }, [load]);
  useEffect(() => refresh(), [refresh]);
  return [items, refresh];
}

function Providers({ onToast }: { onToast: (m: string) => void }) {
  const [providers, refresh] = useList<Provider>(listProviders2);
  const [name, setName] = useState("");
  const [type, setType] = useState("mock");
  const [model, setModel] = useState("");
  const [keys, setKeys] = useState<Record<string, string>>({});

  const create = async () => {
    if (!name) return;
    try {
      await createProvider({ name, type, defaultModel: model || undefined });
      setName("");
      setModel("");
      refresh();
    } catch (e) {
      onToast(String(e));
    }
  };
  const saveKey = async (id: string) => {
    const k = keys[id];
    if (!k) return;
    try {
      await setProviderKey(id, k);
      setKeys((s) => ({ ...s, [id]: "" }));
      onToast("key saved to vault");
    } catch (e) {
      onToast(String(e));
    }
  };

  return (
    <div>
      <div className="cfg-form">
        <input placeholder="name" value={name} onChange={(e) => setName(e.target.value)} />
        <select
          value={type}
          onChange={(e) => {
            setType(e.target.value);
            setModel("");
          }}
        >
          {["mock", "anthropic", "openai", "openrouter", "ollama"].map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <ModelSelect value={model} onChange={setModel} provider={type} allowEmpty placeholder="default model" />
        <button className="primary" onClick={() => void create()}>
          Add provider
        </button>
      </div>
      {providers.map((p) => (
        <div key={p.id} className="cfg-row">
          <div className="cfg-row-head">
            <span className="mono">{p.name}</span>
            <span className="palette-hint">{p.type}{p.defaultModel ? ` · ${p.defaultModel}` : ""}</span>
            <button onClick={() => void deleteProvider(p.id).then(refresh)}>Delete</button>
          </div>
          {p.authType === "api_key" && (
            <div className="cfg-form">
              <input
                type="password"
                placeholder="API key (write-only)"
                value={keys[p.id] ?? ""}
                onChange={(e) => setKeys((s) => ({ ...s, [p.id]: e.target.value }))}
              />
              <button onClick={() => void saveKey(p.id)}>Save key</button>
            </div>
          )}
        </div>
      ))}
      {providers.length === 0 && <div className="empty">No providers yet.</div>}
    </div>
  );
}

function Personas({ onToast }: { onToast: (m: string) => void }) {
  const [personas, refresh] = useList<Persona>(listPersonas);
  const [role, setRole] = useState("");
  const [prompt, setPrompt] = useState("");

  const create = async () => {
    if (!role) return;
    try {
      await createPersona({ role, basePrompt: prompt || undefined });
      setRole("");
      setPrompt("");
      refresh();
    } catch (e) {
      onToast(String(e));
    }
  };

  return (
    <div>
      <div className="cfg-form col">
        <input placeholder="role (e.g. Engineer)" value={role} onChange={(e) => setRole(e.target.value)} />
        <textarea
          placeholder="base system prompt"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={4}
        />
        <button className="primary" onClick={() => void create()}>
          Add persona
        </button>
      </div>
      {personas.map((p) => (
        <div key={p.id} className="cfg-row">
          <div className="cfg-row-head">
            <span className="mono">{p.role}</span>
            <button onClick={() => void deletePersona(p.id).then(refresh)}>Delete</button>
          </div>
          <div className="mem-body">{p.basePrompt || "(no base prompt)"}</div>
        </div>
      ))}
      {personas.length === 0 && <div className="empty">No personas yet.</div>}
    </div>
  );
}

function Overlays({ onToast }: { onToast: (m: string) => void }) {
  const [projects] = useList<ProjectSummary>(listProjects);
  const [projectId, setProjectId] = useState("");
  const [fragment, setFragment] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  // Default the selection to the first project once projects load.
  useEffect(() => {
    if (!projectId && projects.length > 0) setProjectId(projects[0]!.id);
  }, [projects, projectId]);

  const selected = projects.find((p) => p.id === projectId) ?? null;

  // Load the selected project's current overlay fragment (one per project).
  useEffect(() => {
    if (!selected) {
      setFragment("");
      return;
    }
    let live = true;
    setLoading(true);
    void listOverlays(selected.repoRoot)
      .then((os) => {
        if (live) setFragment(os[0]?.fragment ?? "");
      })
      .catch(() => live && setFragment(""))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [selected?.repoRoot, selected]);

  const save = async () => {
    if (!selected) return;
    setSaving(true);
    try {
      await saveOverlay({ projectPath: selected.repoRoot, fragment });
      onToast(`Overlay saved for ${selected.name}`);
    } catch (e) {
      onToast(String(e));
    } finally {
      setSaving(false);
    }
  };

  if (projects.length === 0) {
    return <div className="empty">No projects yet. Create a project first, then add its overlay here.</div>;
  }

  return (
    <div>
      <div className="cfg-form col">
        <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <span className="palette-hint">
          Prepended to every task in this project, after the bound persona&apos;s base prompt and before the
          task context. Applies only to tasks that have a persona bound.
        </span>
        <textarea
          placeholder={loading ? "loading…" : "project overlay fragment (e.g. house style, stack conventions)"}
          value={fragment}
          onChange={(e) => setFragment(e.target.value)}
          rows={6}
          disabled={loading}
        />
        <button className="primary" onClick={() => void save()} disabled={saving || loading}>
          {saving ? "Saving…" : "Save overlay"}
        </button>
      </div>
    </div>
  );
}

function OAuth({ onToast }: { onToast: (m: string) => void }) {
  const [conns, refresh] = useList<OAuthConnection>(() => listConnections());
  const [provider, setProvider] = useState("github");
  const [token, setToken] = useState("");
  const [scopes, setScopes] = useState("");
  const [grants, setGrants] = useState<Record<string, string>>({});

  const create = async () => {
    if (!provider || !token) return;
    try {
      await createConnection({
        provider,
        token,
        scopes: scopes.split(",").map((s) => s.trim()).filter(Boolean),
      });
      setToken("");
      setScopes("");
      refresh();
      onToast("connection saved (token in vault)");
    } catch (e) {
      onToast(String(e));
    }
  };
  const grant = async (id: string) => {
    const ops = (grants[id] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    if (ops.length === 0) return;
    try {
      await grantOps(id, ops);
      setGrants((s) => ({ ...s, [id]: "" }));
      refresh();
    } catch (e) {
      onToast(String(e));
    }
  };

  return (
    <div>
      <div className="cfg-form">
        <input placeholder="provider (github/slack)" value={provider} onChange={(e) => setProvider(e.target.value)} />
        <input type="password" placeholder="token / PAT" value={token} onChange={(e) => setToken(e.target.value)} />
        <input placeholder="granted ops (comma)" value={scopes} onChange={(e) => setScopes(e.target.value)} />
        <button className="primary" onClick={() => void create()}>
          Add connection
        </button>
      </div>
      {conns.map((c) => (
        <div key={c.id} className="cfg-row">
          <div className="cfg-row-head">
            <span className="mono">{c.provider}</span>
            <span className="palette-hint">{c.scopes.join(", ") || "no scopes (default-deny)"}</span>
            <button onClick={() => void deleteConnection(c.id).then(refresh)}>Revoke</button>
          </div>
          <div className="cfg-form">
            <input
              placeholder="grant ops (comma)"
              value={grants[c.id] ?? ""}
              onChange={(e) => setGrants((s) => ({ ...s, [c.id]: e.target.value }))}
            />
            <button onClick={() => void grant(c.id)}>Grant</button>
          </div>
        </div>
      ))}
      {conns.length === 0 && <div className="empty">No connections yet.</div>}
    </div>
  );
}
