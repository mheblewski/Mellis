import { CONVERSATION_STYLE_INSTRUCTIONS } from './conversation-style';
import { THERAPY_NOW_INSTRUCTIONS } from '@modules/context/application/therapy-now';
import { resolveHomeTimeZone } from '@shared/primitives/home-time-zone';
import { AiTask, DirectResponseContextRecord } from '@modules/ai-gateway/domain/ai-gateway';

/** Bump on any change of this prompt (the task's prompt_version and identity follow it). */
export const DIRECT_RESPONSE_PROMPT_VERSION = 'conversation-direct-response-prompt.v4';

export function buildDirectResponsePrompt(task: AiTask, context: DirectResponseContextRecord, options: {
  /** propose_bolus or propose_rescue_carbs is attached: a dose is given only on their cards, never in the text. */
  dose_card_tools?: boolean;
} = {}): {
  system_instructions: string;
  user_payload: string;
} {
  const therapySuggestions = options.dose_card_tools ? 'ONLY_ON_DOSE_CARDS_NOT_IN_TEXT' : 'NOT_IN_THIS_REPLY_NO_PATIENT_DATA_LOADED';
  const recentMessages = context.conversation_context.messages
    .slice(-12)
    .map((message) => ({
      role: message.role,
      message_type: message.message_type ?? 'OTHER',
      content: message.content,
      created_at: message.created_at,
    }));

  const userPayload = {
    task: {
      task_type: task.task_type,
      task_version: task.task_version,
      prompt_version: task.prompt_version,
      output_schema_version: task.output_schema_version,
      correlation_id: task.correlation_id,
    },
    patient_ref: context.patient_ref,
    direct_response_input: context.direct_response_input,
    conversation_context: {
      thread_id: context.conversation_context.thread_id,
      thread_state_version: context.conversation_context.thread_state_version,
      recent_messages: recentMessages,
      already_suggested_follow_ups: context.conversation_context.already_suggested_follow_ups ?? [],
      needs_title: context.conversation_context.needs_title ?? false,
    },
    current_state_snapshot: context.current_state_snapshot ?? null,
    therapy_now: context.therapy_now ?? null,
    // "Jutro o 7", "za godzinę": the patient's clock at the question (set_reminder's at_local is in this zone).
    patient_local_time: localTime(context.question_at ?? context.created_at, context.patient_time_zone),
    patient_facts: (context.patient_facts ?? []).slice(0, 20),
    provenance_summary: {
      source_refs: context.provenance.source_refs.slice(0, 50),
      selection_policy_version: 'direct-response-context.v1',
    },
    evidence_contract: {
      use_only_observed_and_deterministic_data: true,
      never_invent_patient_specific_events_or_values: true,
      explicitly_mark_missing_or_unknown_sections: true,
      therapy_suggestions: therapySuggestions,
      no_chain_of_thought: true,
    },
    allowed_response_contract: {
      require_single_message: true,
      no_investigation_question_generation: true,
      therapy_suggestions: therapySuggestions,
      no_chain_of_thought: true,
    },
  };

  return {
    system_instructions: [
      'You are a diabetes conversational assistant in a safety-first mode.',
      ...CONVERSATION_STYLE_INSTRUCTIONS,
      'Return one assistant response for the user message.',
      THERAPY_NOW_INSTRUCTIONS,
      ...(options.dose_card_tools
        ? [
          // With card tools the reply has the patient's current data: a "no data loaded" line would contradict the cards.
          'Your data in this reply: current_state_snapshot (glucose, trend, IOB, COB), the conversation and the card tools\' results; the card tools (propose_bolus, propose_rescue_carbs) read the patient\'s data themselves. A dose to give now goes only through them: follow their rules and results, and name a dose in the text only as they allow. Never write that data are missing or not loaded while you prepare cards: data never block a card, its warnings say what is uncertain.',
          'Settings changes (ICR, ISF, basal, targets) need the patient\'s history, which is not loaded here: give no settings numbers and say that they can be analysed with the data.',
          'Older history (past readings, insulin, meals before the current state) is not loaded for this reply: if asked, say it can be analysed on request; never say that it does not exist or that nothing was recorded.',
        ]
        : [
          'Dose and settings suggestions need the patient\'s data, which is not loaded in this reply: give no numbers here and say that the question can be analysed with the data.',
          'If context is insufficient, provide a brief general explanation and suggest discussing urgent treatment decisions with a clinician.',
          'No patient history (glucose readings, insulin, meals, activity) is loaded for this reply. If the user asks about it, say that this data was not loaded for this answer and can be analysed on request; never say that it does not exist or that nothing was recorded.',
        ]),
      'Do not ask follow-up investigation questions in this task.',
      'Do not expose chain-of-thought or internal reasoning.',
    ].join('\n'),
    user_payload: JSON.stringify(userPayload),
  };
}

/** The patient's local date and time at `iso` ("2026-10-23 07:46, Europe/Warsaw"). */
function localTime(iso: string, patientTimeZone?: string): { time_zone: string; local: string } | null {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  const timeZone = patientTimeZone || resolveHomeTimeZone();
  const parts = new Intl.DateTimeFormat('sv-SE', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'long' }).format(at);
  return { time_zone: timeZone, local: parts };
}
