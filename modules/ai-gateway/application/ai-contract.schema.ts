import { z } from 'zod';

/**
 * Names of the strict JSON schemas the provider is asked for (openai-provider.ts), also the tasks'
 * output_schema_version: a change of a schema renames it. Both conversation tasks share one output schema.
 */
export const CONVERSATION_OUTPUT_SCHEMA_NAME = 'glucomind_conversation_direct_response_output_v6';

export const aiTaskSchema = z
  .object({
    task_id: z.string().min(1),
    task_type: z.enum(['CONVERSATION_DIRECT_RESPONSE', 'CONVERSATION_TIME_RANGE_ANALYSIS']),
    task_version: z.string().min(1),
    context_package_id: z.string().min(1),
    context_package_version: z.string().min(1),
    context_package_hash: z.string().min(1),
    prompt_version: z.string().min(1),
    output_schema_version: z.string().min(1),
    model_policy_version: z.string().min(1),
    correlation_id: z.string().min(1),
    created_at: z.string().min(1),
    patient_id: z.string().min(1).optional(),
    trigger_id: z.string().min(1).optional(),
    analysis_id: z.string().min(1).optional(),
  })
  .strict();

export const directResponseAiResultSchema = z
  .object({
    assistant_message: z.string().min(1),
    /** Older outputs only (before follow_up_candidates); kept so stored results still parse. */
    suggested_follow_ups: z.array(z.string()).optional(),
    /** Older outputs only (before follow_up_candidates); kept so stored results still parse. */
    hot_follow_up_index: z.number().int().nullable().optional(),
    /** Candidate questions with the model's own assessment; checked loosely, the worker's selection does the rest. */
    follow_up_candidates: z.array(z.unknown()).optional(),
    /** The conversation's name for the history list (first answer only); checked by the worker before it is saved. */
    conversation_title: z.string().nullable().optional(),
    /** Options shown as a picker (answer-options.v1); checked loosely, the worker sanitizes them. Older outputs omit it. */
    answer_options: z.array(z.unknown()).optional(),
  })
  .strict();
