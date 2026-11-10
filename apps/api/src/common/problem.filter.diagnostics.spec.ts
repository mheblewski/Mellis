import { HttpException, UnauthorizedException } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { diagnosticRecorder } from '@modules/diagnostics/application/diagnostic-recorder';
import { CodedError } from '@shared/errors/app-error';
import { ProblemDetailsFilter } from './problem.filter';

function run(exception: unknown, headers: Record<string, unknown>): void {
  const response = { status: () => response, setHeader: () => undefined, json: () => undefined };
  const request = { originalUrl: '/v1/patients/6f1c2c1e-3a53-4f4e-9c55-0c8f0d8a1b11/dashboard', method: 'GET', route: { path: '/v1/patients/:patientId/dashboard' }, headers };
  new ProblemDetailsFilter().catch(exception, { switchToHttp: () => ({ getResponse: () => response, getRequest: () => request }) } as never);
}

describe('ProblemDetailsFilter diagnostic events', () => {
  afterEach(() => vi.restoreAllMocks());

  it('does not record the healthcheck: a 401 with no token', () => {
    const record = vi.spyOn(diagnosticRecorder, 'record').mockImplementation(() => undefined);
    run(new UnauthorizedException(), {});
    expect(record).not.toHaveBeenCalled();
  });

  it('records a 401 with a token that was refused: a phone that lost its session', () => {
    const record = vi.spyOn(diagnosticRecorder, 'record').mockImplementation(() => undefined);
    run(new UnauthorizedException(), { authorization: 'Bearer secret-token' });
    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      level: 'warn',
      event: 'api_request_failed',
      fields: { code: 'UNAUTHENTICATED', method: 'GET', route: '/v1/patients/:patientId/dashboard', status: 401 },
    }));
    expect(JSON.stringify(record.mock.calls)).not.toContain('secret-token');
  });

  it('records other failures by the route template, not the address', () => {
    const record = vi.spyOn(diagnosticRecorder, 'record').mockImplementation(() => undefined);
    run(new CodedError('NOT_AN_OWNER', 403, 'no'), {});
    run(new HttpException('gone', 410), {});
    expect(record).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(record.mock.calls)).not.toContain('6f1c2c1e');
  });
});
