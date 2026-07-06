// SQLite access for the persona service. Opens the shared agent-cc.db and owns
// the persona_* tables.

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { applyMigrations, type Persona, type ProjectOverlay } from "@agent-cc/shared";

export type DB = Database.Database;

export function openDb(path: string): DB {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("busy_timeout = 5000");
  db.pragma("journal_mode = WAL");
  applyMigrations(db);
  return db;
}

interface PersonaRow {
  id: string;
  role: string;
  base_prompt: string;
  toolset_json: string;
  default_model: string;
  created_at: string;
}

function rowToPersona(r: PersonaRow): Persona {
  return {
    id: r.id,
    role: r.role,
    basePrompt: r.base_prompt,
    toolset: JSON.parse(r.toolset_json) as string[],
    defaultModel: r.default_model,
    createdAt: r.created_at,
  };
}

export function insertPersona(db: DB, p: Persona): void {
  db.prepare(
    `INSERT INTO persona_personas (id, role, base_prompt, toolset_json, default_model, created_at)
     VALUES (@id, @role, @basePrompt, @toolsetJson, @defaultModel, @createdAt)`,
  ).run({
    id: p.id,
    role: p.role,
    basePrompt: p.basePrompt,
    toolsetJson: JSON.stringify(p.toolset),
    defaultModel: p.defaultModel,
    createdAt: p.createdAt,
  });
}

export function listPersonas(db: DB): Persona[] {
  return (db.prepare(`SELECT * FROM persona_personas ORDER BY role`).all() as PersonaRow[]).map(rowToPersona);
}

export function getPersona(db: DB, id: string): Persona | null {
  const r = db.prepare(`SELECT * FROM persona_personas WHERE id = ?`).get(id) as PersonaRow | undefined;
  return r ? rowToPersona(r) : null;
}

export function updatePersona(
  db: DB,
  id: string,
  patch: Partial<Pick<Persona, "role" | "basePrompt" | "toolset" | "defaultModel">>,
): Persona | null {
  const cur = getPersona(db, id);
  if (!cur) return null;
  const next: Persona = {
    ...cur,
    role: patch.role ?? cur.role,
    basePrompt: patch.basePrompt ?? cur.basePrompt,
    toolset: patch.toolset ?? cur.toolset,
    defaultModel: patch.defaultModel ?? cur.defaultModel,
  };
  db.prepare(
    `UPDATE persona_personas SET role=@role, base_prompt=@basePrompt,
       toolset_json=@toolsetJson, default_model=@defaultModel WHERE id=@id`,
  ).run({
    id,
    role: next.role,
    basePrompt: next.basePrompt,
    toolsetJson: JSON.stringify(next.toolset),
    defaultModel: next.defaultModel,
  });
  return next;
}

export function deletePersona(db: DB, id: string): void {
  db.prepare(`DELETE FROM persona_personas WHERE id = ?`).run(id);
}

interface OverlayRow {
  id: string;
  project_path: string;
  fragment: string;
  tags_json: string;
  created_at: string;
}

function rowToOverlay(r: OverlayRow): ProjectOverlay {
  return {
    id: r.id,
    projectPath: r.project_path,
    fragment: r.fragment,
    tags: JSON.parse(r.tags_json) as string[],
    createdAt: r.created_at,
  };
}

// One overlay per project. This is a genuine upsert: replace any existing rows
// for the project path, then insert. (The table keys on `id`, not
// `project_path`, so a bare INSERT would accumulate duplicate fragments — which
// compose() joins together — with no way to edit or remove them.)
export function upsertOverlay(db: DB, o: ProjectOverlay): void {
  const tx = db.transaction((ov: ProjectOverlay) => {
    db.prepare(`DELETE FROM persona_project_overlays WHERE project_path = ?`).run(ov.projectPath);
    db.prepare(
      `INSERT INTO persona_project_overlays (id, project_path, fragment, tags_json, created_at)
       VALUES (@id, @projectPath, @fragment, @tagsJson, @createdAt)`,
    ).run({
      id: ov.id,
      projectPath: ov.projectPath,
      fragment: ov.fragment,
      tagsJson: JSON.stringify(ov.tags),
      createdAt: ov.createdAt,
    });
  });
  tx(o);
}

export function overlaysForProject(db: DB, projectPath: string): ProjectOverlay[] {
  return (
    db.prepare(`SELECT * FROM persona_project_overlays WHERE project_path = ? ORDER BY created_at`).all(
      projectPath,
    ) as OverlayRow[]
  ).map(rowToOverlay);
}

export function setBinding(db: DB, workspaceId: string, personaId: string, createdAt: string): void {
  db.prepare(
    `INSERT INTO persona_workspace_bindings (workspace_id, persona_id, is_active, created_at)
     VALUES (?, ?, 1, ?)
     ON CONFLICT(workspace_id) DO UPDATE SET persona_id = excluded.persona_id, is_active = 1`,
  ).run(workspaceId, personaId, createdAt);
}

export function getBinding(db: DB, workspaceId: string): { personaId: string } | null {
  const r = db
    .prepare(`SELECT persona_id FROM persona_workspace_bindings WHERE workspace_id = ? AND is_active = 1`)
    .get(workspaceId) as { persona_id: string } | undefined;
  return r ? { personaId: r.persona_id } : null;
}
