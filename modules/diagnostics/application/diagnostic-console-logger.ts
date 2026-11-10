import { ConsoleLogger } from '@nestjs/common';
import { diagnosticEventFromLog, type DiagnosticLevel } from './diagnostic-events';
import { diagnosticRecorder, type DiagnosticRecorder } from './diagnostic-recorder';

/**
 * The console logger the API and the worker always had, which also keeps the allowed part of each structured line for
 * the diagnostic report. What the console prints does not change. Nothing here can fail a log call.
 */
export class DiagnosticConsoleLogger extends ConsoleLogger {
  private recorder: DiagnosticRecorder = diagnosticRecorder;

  useRecorder(recorder: DiagnosticRecorder): this {
    this.recorder = recorder;
    return this;
  }

  override log(message: any, ...rest: any[]): void {
    super.log(message, ...rest);
    this.keep('info', message, rest);
  }

  override warn(message: any, ...rest: any[]): void {
    super.warn(message, ...rest);
    this.keep('warn', message, rest);
  }

  override error(message: any, ...rest: any[]): void {
    super.error(message, ...rest);
    this.keep('error', message, rest);
  }

  private keep(level: DiagnosticLevel, message: unknown, rest: unknown[]): void {
    try {
      const last = rest[rest.length - 1];
      const event = diagnosticEventFromLog(level, message, typeof last === 'string' ? last : null);
      if (event) this.recorder.record(event);
    } catch {
      // A diagnostic record is never worth a failed log call.
    }
  }
}
