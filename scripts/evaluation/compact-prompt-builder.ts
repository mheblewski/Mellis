import type { AiTask, TimeRangeAnalysisContextRecord } from '@modules/ai-gateway/domain/ai-gateway';

/**
 * generate-evidence-payload-inspection.ts and offline-time-range-token-minimization-benchmark.ts were written against
 * `buildCompactTimeRangeAnalysisPrompt` from modules/ai-gateway/application/time-range-analysis-prompt.ts. That builder
 * is not defined anywhere: not in the module, not in any reachable Git history, and not in any other checkout. Its
 * system instructions and payload layout are unknown, so it cannot be restored without inventing a prompt.
 *
 * Until it is restored from its original source or the tools are retired, both tools fail closed through this module,
 * before any capture is read. Nothing here builds a prompt.
 */
export class CompactPromptBuilderUnavailableError extends Error {
  constructor() {
    super(
      'buildCompactTimeRangeAnalysisPrompt is not defined in this repository (no definition in the prompt module or its history); '
        + 'this tool is disabled until the compact time-range prompt builder is restored or the tool is retired.',
    );
    this.name = 'CompactPromptBuilderUnavailableError';
  }
}

/** Throws before the tool reads any capture. */
export function assertCompactPromptBuilderAvailable(): void {
  throw new CompactPromptBuilderUnavailableError();
}

/** Same signature as the scripts' call sites expect; always throws, never builds a prompt. */
export function buildCompactTimeRangeAnalysisPrompt(
  _task: AiTask,
  _context: TimeRangeAnalysisContextRecord,
  _compactArtifact: Record<string, unknown>,
): { system_instructions: string; user_payload: string } {
  throw new CompactPromptBuilderUnavailableError();
}
