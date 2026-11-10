import { Controller, Get, Inject, UseFilters, UseGuards } from '@nestjs/common';
import type { Pool } from 'pg';
import { DATABASE_POOL } from '@infra/db/database.tokens';
import { buildDiagnosticReport } from '@modules/diagnostics/application/diagnostic-report';
import { serverDiagnosticStore } from '@modules/diagnostics/infrastructure/start-diagnostic-events';
import { CodedError } from '@shared/errors/app-error';
import { BearerPrincipalGuard, RequestPrincipal } from '../auth/bearer-principal.guard';
import { Principal } from '../auth/principal.decorator';
import { ProblemDetailsFilter } from '../common/problem.filter';

@Controller('/v1/me/diagnostic-report')
@UseGuards(BearerPrincipalGuard)
@UseFilters(ProblemDetailsFilter)
export class DiagnosticsController {
  constructor(@Inject(DATABASE_POOL) private readonly pool: Pool) {}

  /**
   * "Zgłoś problem": the server's half of the report. It covers the whole server, so only an owner gets it; another
   * caregiver's report has the phone's half alone (403 NOT_AN_OWNER).
   */
  @Get()
  async getReport(@Principal() principal: RequestPrincipal): Promise<{ text: string }> {
    const owns = (await this.pool.query('SELECT 1 FROM caregiver_relationships WHERE user_id = $1::uuid AND is_owner LIMIT 1', [principal.user_id])).rowCount;
    if (!owns) throw new CodedError('NOT_AN_OWNER', 403, 'Only an owner gets the server report');
    return { text: await buildDiagnosticReport(serverDiagnosticStore(this.pool), process.env) };
  }
}
