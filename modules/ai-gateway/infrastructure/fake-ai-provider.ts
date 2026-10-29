import { AiProvider, AiProviderInput, AiProviderResponse } from '../domain/ai-gateway';

export class FakeAiProvider implements AiProvider {
  readonly providerName = 'fake';
  readonly model = 'deterministic-hypo-v1';

  /**
   * FAKE_AI_STREAM_DELAY_MS (local checks of live drafts): with a listener, the structured output is written to it in
   * about a dozen chunks this many ms apart, like a streamed model. Unset or 0: no delay and no streaming (tests).
   */
  async generate(input: AiProviderInput): Promise<AiProviderResponse> {
    const response = await this.respond(input);
    const delayMs = Number(process.env.FAKE_AI_STREAM_DELAY_MS ?? 0);
    if (input.on_output_text && Number.isFinite(delayMs) && delayMs > 0) {
      const text = JSON.stringify(response.raw_output);
      const chunk = Math.max(1, Math.ceil(text.length / 12));
      for (let end = chunk; ; end += chunk) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        input.on_output_text(text.slice(0, Math.min(end, text.length)));
        if (end >= text.length) break;
      }
    }
    return response;
  }

  private async respond(input: AiProviderInput): Promise<AiProviderResponse> {
    if (input.task.task_type === 'CONVERSATION_TIME_RANGE_ANALYSIS') {
      const context = input.context_package as {
        analysis_request_input?: { user_message_text?: string; range_start?: string; range_end?: string; range_type?: string };
        analytical_evidence?: { summaries?: { glucose_count?: number; insulin_treatment_count?: number; meal_count?: number; hypo_episode_count?: number; missing_sections?: string[] } };
      };
      const requestText = String(context.analysis_request_input?.user_message_text ?? '').trim();
      const rangeType = String(context.analysis_request_input?.range_type ?? 'TODAY');
      const rangeStart = String(context.analysis_request_input?.range_start ?? 'UNKNOWN');
      const rangeEnd = String(context.analysis_request_input?.range_end ?? 'UNKNOWN');
      const summaries = context.analytical_evidence?.summaries ?? {};
      const missing = Array.isArray(summaries.missing_sections) && summaries.missing_sections.length > 0
        ? ` Braki danych: ${summaries.missing_sections.join(', ')}.`
        : '';

      const assistantMessage = `Analiza zakresu ${rangeType} (${rangeStart} - ${rangeEnd}) dla pytania "${requestText}". Zdarzenia glukozy: ${Number(summaries.glucose_count ?? 0)}, insulinowo-leczeniowe: ${Number(summaries.insulin_treatment_count ?? 0)}, posiłki: ${Number(summaries.meal_count ?? 0)}, epizody hipo: ${Number(summaries.hypo_episode_count ?? 0)}.${missing}`;
      return {
        provider: 'fake',
        model: 'deterministic-hypo-v1',
        received_at: new Date().toISOString(),
        usage: buildDeterministicUsage(input, assistantMessage),
        raw_output: {
          assistant_message: assistantMessage,
          follow_up_candidates: FAKE_FOLLOW_UP_CANDIDATES,
          conversation_title: fakeConversationTitle(input.context_package, requestText),
          answer_options: [],
        },
      };
    }

    const context = input.context_package as {
      direct_response_input?: { user_message_text?: string };
      current_state_snapshot?: { current_glucose?: number | 'UNKNOWN' } | null;
    };
    const userText = String(context.direct_response_input?.user_message_text ?? '').trim();
    const glucoseValue = context.current_state_snapshot?.current_glucose;
    const glucoseFragment = typeof glucoseValue === 'number'
      ? ` Aktualny odczyt glukozy to około ${glucoseValue} mg/dL.`
      : '';

    const answer = userText.length > 0
      ? `Rozumiem Twoje pytanie: "${userText}".${glucoseFragment} Na podstawie dostępnych danych mogę podać ogólne wyjaśnienie bez zmiany terapii.`
      : 'Rozumiem Twoje pytanie i mogę podać ogólne wyjaśnienie na podstawie dostępnych danych, bez zmiany terapii.';

    return {
      provider: 'fake',
      model: 'deterministic-hypo-v1',
      received_at: new Date().toISOString(),
      usage: buildDeterministicUsage(input, answer),
      raw_output: {
        assistant_message: answer,
        follow_up_candidates: FAKE_FOLLOW_UP_CANDIDATES,
        conversation_title: fakeConversationTitle(input.context_package, userText),
        answer_options: [],
      },
    };
  }
}

/** Written after the answer, as a model writes them, so local runs show the suggestions arriving. */
const FAKE_FOLLOW_UP_CANDIDATES = [
  { question: 'Jak wyglądała noc?', kind: 'PATTERN', usefulness: 5, answerable: true, repeats_answer: false },
  { question: 'Czy bolus do obiadu był trafiony?', kind: 'NEXT_TIME', usefulness: 4, answerable: true, repeats_answer: false },
  { question: 'Ile było hipoglikemii w tym tygodniu?', kind: 'WHY', usefulness: 3, answerable: true, repeats_answer: false },
];

function buildDeterministicUsage(input: AiProviderInput, outputText: string): AiProviderResponse['usage'] {
  const inputBytes = Buffer.byteLength(`${input.prompt.system_instructions}\n${input.prompt.user_payload}`, 'utf8');
  const outputBytes = Buffer.byteLength(outputText, 'utf8');
  const inputTokens = Math.max(1, Math.round(inputBytes / 4));
  const outputTokens = Math.max(1, Math.round(outputBytes / 4));

  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: inputTokens + outputTokens,
    cached_input_tokens: null,
    reasoning_tokens: null,
  };
}

/** Deterministic name for local runs: the first words of the question, only when the conversation needs one. */
function fakeConversationTitle(contextPackage: unknown, questionText: string): string | null {
  const needsTitle = (contextPackage as { conversation_context?: { needs_title?: boolean } } | null)?.conversation_context?.needs_title === true;
  if (!needsTitle) return null;
  const words = questionText.replace(/[?!.]+/g, ' ').split(/\s+/).filter((word) => word.length > 0).slice(0, 5);
  return words.length > 0 ? words.join(' ') : null;
}
