import type { ProviderDiagnosticSnapshot } from '@modules/ai-gateway/domain/ai-gateway';

export class AiProviderError extends Error {
  public readonly httpStatus: number | null;
  public readonly errorName: string | null;
  public readonly errorType: string | null;
  public readonly stage: string | null;
  public readonly responseId: string | null;
  public readonly outputItemTypes: string[];
  public readonly functionCallNames: string[];
  public readonly functionCallArguments: Array<Record<string, unknown>>;
  public readonly functionCallCount: number;
  public readonly hasOutputText: boolean;

  constructor(
    message: string,
    public readonly retryable: boolean,
    public readonly code?: string,
    diagnostics?: Partial<ProviderDiagnosticSnapshot>,
  ) {
    super(message);
    this.name = 'AiProviderError';
    this.httpStatus = diagnostics?.http_status ?? null;
    this.errorName = diagnostics?.error_name ?? null;
    this.errorType = diagnostics?.error_type ?? null;
    this.stage = diagnostics?.stage ?? null;
    this.responseId = diagnostics?.response_id ?? null;
    this.outputItemTypes = diagnostics?.output_item_types ?? [];
    this.functionCallNames = diagnostics?.function_call_names ?? [];
    this.functionCallArguments = diagnostics?.function_call_arguments ?? [];
    this.functionCallCount = diagnostics?.function_call_count ?? 0;
    this.hasOutputText = diagnostics?.has_output_text ?? false;
  }
}
