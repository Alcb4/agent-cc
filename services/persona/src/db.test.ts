import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, upsertOverlay, overlaysForProject, type DB } from "./db.js";

const PROJECT = "/repos/alpha";

function overlay(projectPath: string, fragment: string) {
  return {
    id: randomUUID(),
    projectPath,
    fragment,
    tags: [] as string[],
    createdAt: new Date().toISOString(),
  };
}

describe("upsertOverlay", () => {
  let dir: string;
  let db: DB;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agent-cc-persona-"));
    db = openDb(join(dir, "persona.db"));
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("replaces rather than appends for the same project", () => {
    upsertOverlay(db, overlay(PROJECT, "first"));
    upsertOverlay(db, overlay(PROJECT, "second"));
    const rows = overlaysForProject(db, PROJECT);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.fragment).toBe("second");
  });

  test("keeps overlays for other projects isolated", () => {
    upsertOverlay(db, overlay(PROJECT, "alpha-frag"));
    upsertOverlay(db, overlay("/repos/beta", "beta-frag"));
    upsertOverlay(db, overlay(PROJECT, "alpha-frag-2"));
    expect(overlaysForProject(db, PROJECT).map((o) => o.fragment)).toEqual(["alpha-frag-2"]);
    expect(overlaysForProject(db, "/repos/beta").map((o) => o.fragment)).toEqual(["beta-frag"]);
  });
});
