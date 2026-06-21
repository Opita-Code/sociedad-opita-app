/**
 * ContextBuilder — composes the system + user prompts for POST /v1/dialogue.
 *
 * The dialogue handler feeds this:
 *   - the validated Persona (from TELLO_PERSONAS)
 *   - the Scene (time, place, weather?)
 *   - the top-k RAG results (already filtered/scored)
 *   - the user query
 *
 * And gets back a { system, user } pair ready for the LLM.
 *
 * System prompt layers (per .sdd/monumento-cultural-v2/design.md section 5/6):
 *   1. Persona identity (display_name, role, muletillas, archetype)
 *   2. Psychometric profile (Big Five, Lomnitz, Dunbar, network, motivations, fears)
 *   3. RAG context (top-k snippets with persona + topic headers) — optional
 *   4. Style guard: espanol colombiano rural del Huila, forbidden registers,
 *      no biographical invention, redirect when off-topic.
 *
 * User prompt: scene header + climate + visitor question + "que haces o dices?".
 *
 * RAG snippet truncation: 200 chars max + "..." — keeps the prompt bounded
 * (4 docs × ~200 chars ≈ 800 chars added) while leaving enough context for
 * the LLM to ground persona-specific facts.
 */
import type { Persona } from "../personas";
import type { RetrievalResult } from "../rag/types";

export interface DialogueContext {
  system: string;
  user: string;
}

export interface Scene {
  time: string;
  place: string;
  weather?: string;
}

const RAG_SNIPPET_MAX = 200;

function snippet(text: string, max: number = RAG_SNIPPET_MAX): string {
  if (text.length <= max) return text;
  return text.substring(0, max) + "...";
}

/**
 * Compose the system + user prompts for one dialogue turn.
 *
 * @param persona  Validated Tello persona (must come from TELLO_PERSONAS).
 * @param scene    Time + place (+ optional weather).
 * @param topK     Top-k RAG results (already retrieved for this query).
 *                 May be empty — the system prompt still composes correctly.
 * @param query    The visitor's question (may be empty).
 */
export function buildContext(
  persona: Persona,
  scene: Scene,
  topK: RetrievalResult[],
  query: string,
): DialogueContext {
  const systemParts: string[] = [];

  // 1. Persona identity
  systemParts.push(`Eres ${persona.display_name}, ${persona.role} de Tello, Huila (Colombia).`);
  systemParts.push(
    `Tu forma de hablar incluye muletillas como: ${persona.muletillas.slice(0, 3).join(", ")}.`,
  );
  systemParts.push(`Tu arquetipo es: ${persona.archetype}.`);

  // 2. Psychometric profile
  const bf = persona.big_five;
  systemParts.push(
    `Big Five: O=${bf.O}, C=${bf.C}, E=${bf.E}, A=${bf.A}, N=${bf.N}.`,
  );
  systemParts.push(`Motivaciones: ${persona.motivations.join("; ")}.`);
  systemParts.push(`Miedos: ${persona.fears.join("; ")}.`);
  systemParts.push(
    `Red social: betweenness=${persona.network.betweenness}, degree=${persona.network.degree}.`,
  );

  // 3. RAG context (only when retrieval returned something)
  if (topK.length > 0) {
    systemParts.push(
      `\nContexto del pueblo (top-${topK.length} documentos relevantes, score coseno):`,
    );
    topK.forEach((r, i) => {
      const md = r.doc.metadata;
      systemParts.push(
        `[${i + 1}] ${r.doc.id} (score ${r.score.toFixed(3)}) ${md.topic} (${md.personas.join(", ")}): ${snippet(r.doc.text)}`,
      );
    });
  }

  // 4. Style guard (spec REQ-3.x — anti-AI-slop, dialect preservation)
  systemParts.push(
    "\nResponde SIEMPRE en espanol colombiano rural del Huila, usando tus muletillas.",
  );
  systemParts.push(
    "NO uses registros neutro, argentino, mexicano, chileno ni espanol peninsular.",
  );
  systemParts.push(
    "NO inventes datos sobre tu biografia — lo que sabes esta aqui.",
  );
  systemParts.push(
    "Si la pregunta no es sobre tu biografia o tu pueblo, redirige amablemente al tema del pueblo.",
  );

  const system = systemParts.join("\n");

  // User prompt: scene + climate + visitor question + "que haces o dices?"
  const userParts: string[] = [];
  userParts.push(`Escena: ${scene.time} en ${scene.place}.`);
  if (scene.weather) userParts.push(`Clima: ${scene.weather}.`);
  userParts.push(`\nPregunta del visitante: ${query}`);
  userParts.push(`\n¿Que haces o dices?`);
  const user = userParts.join(" ");

  return { system, user };
}
