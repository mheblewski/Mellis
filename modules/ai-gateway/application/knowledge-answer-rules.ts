/**
 * The assistant's knowledge base in conversations (RAG stage 3): the search_knowledge tool, the answer rules for the
 * retrieved fragments and the extraction of the cited sources shown under the answer. The rules come from the knowledge
 * probe (2026-10-15/16): "use only the fragments" made the model withhold correct knowledge, a sick-day table was applied
 * outside its caption, alternative ketone dosing methods were summed (v3: "correction +10%" plus "10% TDD"), and adult
 * study numbers were transferred to the child.
 */
import type { AiRuntimeToolDefinition } from '@modules/ai-gateway/domain/ai-gateway';
import { KNOWLEDGE_CORPUS_SOURCES, chunkLabel } from '@modules/knowledge/application/knowledge-query';
import type { KnowledgeFragment, KnowledgeSearchOutcome } from '@modules/knowledge/application/knowledge-search';

export const SEARCH_KNOWLEDGE_TOOL_NAME = 'search_knowledge';
export const KNOWLEDGE_ANSWER_RULES_VERSION = 'knowledge-answer-rules.v5';
/** Knowledge searches per answer: one topic, plus one more for a clearly different one. */
export const MAX_KNOWLEDGE_SEARCHES_PER_ANSWER = 2;

export const SEARCH_KNOWLEDGE_TOOL_DEFINITION: AiRuntimeToolDefinition = {
  name: SEARCH_KNOWLEDGE_TOOL_NAME,
  description: `Search the diabetes knowledge base (${KNOWLEDGE_CORPUS_SOURCES}). Returns up to 6 source fragments numbered [S#] (numbers continue across searches of one answer), or UNAVAILABLE / NO_RESULTS.`,
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      query: {
        type: 'string',
        description: 'One focused question about the topic, in Polish or English (for example "ketony 1,2 mmol/L w czasie choroby na pompie z pętlą: ile dodatkowej insuliny" or "Dexcom G7 compression low at night"). Topic only: no names or dates.',
      },
    },
    required: ['query'],
  },
};

export function buildKnowledgeInstructions(args: { withEvidenceTools: boolean; directResponse: boolean; protocolCard: string | null; doseCardTools?: boolean }): string {
  return [
    'Knowledge base: search_knowledge returns fragments of guidelines and device manuals. Call it whenever the answer needs general diabetes knowledge: sick days and ketones, exercise, fat/protein and WBT/FPU, hypoglycaemia treatment, sensor, pump and loop behaviour (compression lows, warm-up, accuracy, loop settings), guideline thresholds and doses. Do not call it for greetings, thanks or questions the patient data alone answers. At most two searches per answer; search again only for a clearly different topic.',
    args.withEvidenceTools
      ? 'Glucose behaviour the caregiver does not understand (an anomaly): look at the data first with the evidence tools, then search the knowledge base for the mechanisms that could fit what the data shows (for example a compression low, sensor warm-up or error, dawn phenomenon, a late rise after fat and protein, exercise after-effects, illness, a cannula or site failure), and connect both: say which details in the data match or rule out each mechanism.'
      : 'Glucose behaviour the caregiver does not understand: explain the mechanisms that could fit from the knowledge base; the patient\'s data is not loaded in this reply, so say that a data analysis would show which one applies.',
    'Fragments marked "(summary)" are our summaries of a guideline or manual, not its wording: do not present them as quotes; the app shows the caregiver a link to the original under the answer.',
    'Fragments are numbered [S1], [S2], ... across all searches of this answer. Put the number right after the information taken from a fragment, e.g. "[S2]". Cite only fragments you actually used and only numbers you received.',
    'The fragments are chosen automatically and some may be off-topic: use those that address the question and ignore the rest.',
    'If the fragments do not answer the question or a part of it, do not refuse: answer from general medical knowledge and mark it, e.g. "(wiedza ogólna, nie ze źródeł)". This includes guideline numbers (doses, percentages, thresholds) the fragments do not give: give them from general knowledge, marked, instead of only saying that the fragments lack them.',
    'Alternative methods stay alternatives: when guidelines give several ways to calculate the same extra insulin (for ketones: correction dose +10–20%, 0.05–0.1 U/kg, or 10–20% of the total daily dose), present them as alternatives, use or name one, and never add their results together or combine them.',
    'Apply a table only to the situation in its caption and headers (a table for normoglycaemia says nothing about doses in hyperglycaemia).',
    'When a fragment comes from studies in another age group than the patient\'s (children or adults), another population, device or insulin, say so and do not transfer its numbers to this patient directly.',
    'search_knowledge status UNAVAILABLE: say in one short sentence that the knowledge base could not be searched this time and answer from general knowledge, marked as such. NO_RESULTS: say that no matching source was found.',
    args.directResponse && !args.doseCardTools
      ? 'Guideline numbers from the sources (thresholds, % of the total daily dose, g/kg) are general guidance, not a dose for this patient: a dose needs the patient\'s data, which is not loaded in this reply. Be conservative for the patient\'s age; the caregiver decides together with the diabetes team.'
      : args.directResponse
      ? 'Guideline numbers from the sources (thresholds, % of the total daily dose, g/kg) are general guidance, not a dose for this patient: a dose for this patient comes only from the card tools, which use the patient\'s data. Be conservative for the patient\'s age; the caregiver decides together with the diabetes team.'
      : 'The therapy suggestion rules still apply to anything taken from the sources: be conservative for the patient\'s age, guideline numbers are general guidance, a dose for this patient follows the therapy suggestion rules, and the caregiver decides together with the diabetes team.',
    ...(args.protocolCard
      ? [
        `Protocol card approved by this patient's diabetes team (takes precedence over general guidelines where they differ; cite it as [Karta]):\n"""\n${args.protocolCard}\n"""`,
      ]
      : []),
  ].join('\n');
}

/** Provider copy of one search outcome; fragments carry their global [S#] number. */
export function buildKnowledgeToolResult(args: {
  query: string;
  outcome: KnowledgeSearchOutcome;
  firstRefNumber: number;
}): Record<string, unknown> {
  const { outcome } = args;
  const note = outcome.status === 'FOUND'
    ? 'Automatically selected fragments; some may be off-topic. Cite the ones you use by their ref.'
    : outcome.status === 'NO_RESULTS'
      ? 'No matching source was found for this query.'
      : 'The knowledge base could not be searched now. Answer without sources and say so briefly; mark general knowledge.';
  return {
    tool: SEARCH_KNOWLEDGE_TOOL_NAME,
    status: outcome.status,
    query: args.query,
    corpus_version: outcome.corpus_version,
    fragments: outcome.fragments.map((fragment, offset) => ({
      ref: `S${args.firstRefNumber + offset}`,
      source: chunkLabel(fragment),
      ...(fragment.publisher ? { publisher: fragment.publisher } : {}),
      ...(fragment.kind === 'table' ? { kind: 'table' } : {}),
      text: fragment.text.trim(),
    })),
    note,
  };
}

/** One source shown under an answer (no fragment text: the corpus is copyrighted and stays in the database). */
export interface KnowledgeSourceCitation {
  ref: string;
  title: string;
  section: string | null;
  page: number | null;
  page_end: number | null;
  /** The original the reader can open (shipped knowledge base); absent for a corpus without links. */
  url?: string;
  chunk_id: string;
  corpus_version: string | null;
}

/** [S#] numbers cited in the answer, in order of first citation ("[S2]", "[S1, S3]", "[S1][S4]", "[S2, s. 5]"). */
export function extractCitedRefs(text: string): string[] {
  const refs: string[] = [];
  for (const group of text.matchAll(/\[([^\]\n]{1,60})\]/g)) {
    if (!/^\s*S\d+/i.test(group[1])) continue;
    for (const match of group[1].matchAll(/\bS(\d+)\b/gi)) {
      const ref = `S${Number(match[1])}`;
      if (!refs.includes(ref)) refs.push(ref);
    }
  }
  return refs;
}

/** The fragments the answer cites, in citation order; refs the answer cites but no search returned are ignored. */
export function citedKnowledgeSources(
  answer: string,
  fragmentsByRef: ReadonlyMap<string, { fragment: KnowledgeFragment; corpus_version: string | null }>,
): KnowledgeSourceCitation[] {
  return extractCitedRefs(answer)
    .filter((ref) => fragmentsByRef.has(ref))
    .map((ref) => {
      const { fragment, corpus_version } = fragmentsByRef.get(ref)!;
      return {
        ref,
        title: fragment.title,
        section: fragment.section,
        page: fragment.page,
        page_end: fragment.page_end,
        ...(safeSourceUrl(fragment.url) ? { url: safeSourceUrl(fragment.url) as string } : {}),
        chunk_id: fragment.chunk_id,
        corpus_version,
      };
    });
}

const MAX_SOURCES_PER_MESSAGE = 12;
const MAX_SOURCE_URL_CHARS = 500;

/** An http(s) link the app may open; anything else (javascript:, relative, too long) is dropped. */
export function safeSourceUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const url = value.trim();
  if (!url || url.length > MAX_SOURCE_URL_CHARS || /\s/.test(url)) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? url : null;
  } catch {
    return null;
  }
}

/**
 * Sources stored with an assistant message and returned by the API: well-formed entries only, at most 12, without the
 * chunk id and corpus version (kept in the AI execution audit). Anything malformed is dropped, never repaired.
 */
export function sanitizeKnowledgeSources(raw: unknown): Array<{ ref: string; title: string; section: string | null; page: number | null; page_end: number | null; url?: string }> {
  if (!Array.isArray(raw)) return [];
  const text = (value: unknown, max: number) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null);
  const pageNumber = (value: unknown) => (typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null);
  const result: Array<{ ref: string; title: string; section: string | null; page: number | null; page_end: number | null; url?: string }> = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const ref = text(record.ref, 8);
    const title = text(record.title, 300);
    if (!ref || !/^S\d{1,3}$/.test(ref) || !title || result.some((source) => source.ref === ref)) continue;
    const url = safeSourceUrl(record.url);
    result.push({ ref, title, section: text(record.section, 200), page: pageNumber(record.page), page_end: pageNumber(record.page_end), ...(url ? { url } : {}) });
    if (result.length === MAX_SOURCES_PER_MESSAGE) break;
  }
  return result;
}
