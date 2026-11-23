import { describe, expect, it } from 'vitest';
import { SEARCH_FOOD_TOOL_DEFINITION } from '@modules/meal-chat/application/food-search-tool';
import { SEARCH_KNOWLEDGE_TOOL_DEFINITION } from '@modules/ai-gateway/application/knowledge-answer-rules';
import { GET_MEALS_TOOL_DEFINITION, PROPOSE_MEAL_CHANGE_TOOL_DEFINITION } from '@modules/meal-actions/application/meal-actions-tool';
import { ESTIMATE_WBT_TOOL_DEFINITION, PROPOSE_BOLUS_TOOL_DEFINITION } from '@modules/remote-commands/application/bolus-proposal-tool';
import { PROPOSE_RESCUE_CARBS_TOOL_DEFINITION } from '@modules/rescue-carbs/application/rescue-carb-proposal-tool';
import { PROPOSE_FOOD_NOTE_TOOL_DEFINITION, PROPOSE_MEAL_PLAN_TOOL_DEFINITION } from '@modules/meal-plan/application/meal-plan-proposal';
import { SET_REMINDER_TOOL_DEFINITION } from '@modules/care-reminders/application/care-reminders';
import { PROPOSE_WBT_DOSE_TOOL_DEFINITION } from '@modules/meal-wbt/application/wbt-dose-proposal-tool';
import { SIMULATION_TOOL_DEFINITIONS } from '@modules/chat-simulation/application/simulation-tools';

/**
 * OpenAI sends every tool with strict: true and refuses the whole request (400 invalid_function_parameters, also on the
 * input token count, so the cost guard refuses it as INPUT_TOKENS_UNCOUNTED) when a schema breaks the strict rules.
 * Claude does not check them, so a broken schema shows only on OpenAI servers: on 2026-11-23 propose_bolus listed
 * standard_plan in properties but not in required, and every dose question failed there.
 *
 * The provider fills `required` only when a schema has none (openai-provider ensureResponsesToolParametersRequired), so
 * a schema with its own `required` must list every property. A new tool belongs in this list.
 */
const TOOLS = [
  SEARCH_FOOD_TOOL_DEFINITION,
  SEARCH_KNOWLEDGE_TOOL_DEFINITION,
  GET_MEALS_TOOL_DEFINITION,
  PROPOSE_MEAL_CHANGE_TOOL_DEFINITION,
  PROPOSE_BOLUS_TOOL_DEFINITION,
  ESTIMATE_WBT_TOOL_DEFINITION,
  PROPOSE_RESCUE_CARBS_TOOL_DEFINITION,
  PROPOSE_MEAL_PLAN_TOOL_DEFINITION,
  PROPOSE_FOOD_NOTE_TOOL_DEFINITION,
  SET_REMINDER_TOOL_DEFINITION,
  PROPOSE_WBT_DOSE_TOOL_DEFINITION,
  ...SIMULATION_TOOL_DEFINITIONS,
];

/** Keywords strict mode does not accept. */
const UNSUPPORTED = ['allOf', 'oneOf', 'not', 'if', 'then', 'else', 'patternProperties', 'dependentRequired', 'dependentSchemas', 'unevaluatedProperties', 'propertyNames', 'minProperties', 'maxProperties', 'default'];

function strictViolations(node: unknown, path: string, root: boolean): string[] {
  if (!node || typeof node !== 'object') return [];
  if (Array.isArray(node)) return node.flatMap((item, index) => strictViolations(item, `${path}[${index}]`, false));
  const schema = node as Record<string, unknown>;
  const found = UNSUPPORTED.filter((keyword) => keyword in schema).map((keyword) => `${path}: ${keyword}`);
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (types.includes('object') || schema.properties) {
    const properties = (schema.properties ?? {}) as Record<string, unknown>;
    // The provider fills a missing top-level `required` with every property; nested objects get no such help.
    const required = Array.isArray(schema.required) ? schema.required as string[] : root ? Object.keys(properties) : [];
    for (const key of Object.keys(properties)) {
      if (!required.includes(key)) found.push(`${path}.${key}: not in required`);
      found.push(...strictViolations(properties[key], `${path}.${key}`, false));
    }
    if (schema.additionalProperties !== false) found.push(`${path}: additionalProperties is not false`);
  }
  if (schema.items) found.push(...strictViolations(schema.items, `${path}[]`, false));
  if (schema.anyOf) found.push(...strictViolations(schema.anyOf, `${path}.anyOf`, false));
  return found;
}

describe('tool schemas sent to OpenAI with strict: true', () => {
  it.each(TOOLS.map((tool) => [tool.name, tool] as const))('%s keeps the strict rules', (_name, tool) => {
    expect(strictViolations(tool.input_schema, tool.name, true)).toEqual([]);
  });
});
