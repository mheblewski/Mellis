export class PushNotificationProviderError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable: boolean) {
    super(message);
    this.name = 'PushNotificationProviderError';
    this.code = code;
    this.retryable = retryable;
  }
}
