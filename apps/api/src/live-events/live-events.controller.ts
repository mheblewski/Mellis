import { Controller, Get, Inject, Param, Req, Res, UseFilters, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ApiService } from '../application/api.service';
import { PatientPermissionGuard } from '../auth/patient-permission.guard';
import { BearerPrincipalGuard, RequestPrincipal } from '../auth/bearer-principal.guard';
import { Principal } from '../auth/principal.decorator';
import { ProblemDetailsFilter } from '../common/problem.filter';
import { LiveEventsService } from './live-events.service';

@Controller('/v1/patients/:patientId')
@UseGuards(BearerPrincipalGuard, PatientPermissionGuard)
@UseFilters(ProblemDetailsFilter)
export class LiveEventsController {
  constructor(
    @Inject(ApiService) private readonly apiService: ApiService,
    @Inject(LiveEventsService) private readonly liveEvents: LiveEventsService,
  ) {}

  /** Server-Sent Events: what changed for this patient and the answers being written (see SseEventWriter). */
  @Get('events')
  async events(
    @Principal() principal: RequestPrincipal,
    @Param('patientId') patientId: string,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    // Refused access is answered as problem+json by the filter, before the stream starts.
    await this.apiService.authorizeLiveEvents(principal, patientId);
    this.liveEvents.stream(patientId, request, response);
  }
}
