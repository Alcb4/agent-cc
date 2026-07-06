// Persona composition: persona.base_prompt + project_overlay[project] +
// task_context, layered in that order (per the design doc).

import type { ComposedPrompt } from "@agent-cc/shared";
import { type DB, getPersona, overlaysForProject } from "./db.js";

export function compose(
  db: DB,
  args: { workspaceId: string; personaId: string; taskContext: string; projectPath?: string },
): ComposedPrompt | null {
  const persona = getPersona(db, args.personaId);
  if (!persona) return null;

  const overlayText = args.projectPath
    ? overlaysForProject(db, args.projectPath)
        .map((o) => o.fragment)
        .filter(Boolean)
        .join("\n\n")
    : "";

  const layers = {
    persona: persona.basePrompt,
    overlay: overlayText,
    taskContext: args.taskContext,
  };
  const prompt = [layers.persona, layers.overlay, layers.taskContext]
    .map((s) => s.trim())
    .filter(Boolean)
    .join("\n\n");

  return { personaId: persona.id, workspaceId: args.workspaceId, prompt, layers };
}
