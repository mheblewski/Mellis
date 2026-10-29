import { Body, Controller, Delete, Get, Headers, HttpCode, Inject, Param, Post, Put, Req, UseFilters, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { DeviceAuthService } from '../application/device-auth.service';
import { BearerPrincipalGuard, RequestPrincipal } from '../auth/bearer-principal.guard';
import { PatientPermissionGuard } from '../auth/patient-permission.guard';
import { Principal } from '../auth/principal.decorator';
import { ProblemDetailsFilter } from '../common/problem.filter';

/**
 * Self-hosted Mellis (AUTH_MODE=device): setup, pairing, sessions, devices and people. Every route answers 404 in any
 * other auth mode. Endpoints and payloads: docs/device-auth-api.md.
 */

/** The address this request came to (the pairing QR's server when PUBLIC_BASE_URL is unset). */
function requestOrigin(request: Request): string | null {
  const forwarded = String(request.headers['x-forwarded-proto'] ?? '').split(',')[0]?.trim();
  const protocol = forwarded === 'https' || forwarded === 'http' ? forwarded : request.protocol;
  const host = request.headers['x-forwarded-host'] ?? request.headers.host;
  return typeof host === 'string' && host ? `${protocol}://${host.split(',')[0].trim()}` : null;
}

/** Public routes: setup (with the setup code), recovery, pairing and session challenges. */
@Controller('/v1')
@UseFilters(ProblemDetailsFilter)
export class DeviceSetupController {
  constructor(@Inject(DeviceAuthService) private readonly deviceAuth: DeviceAuthService) {}

  @Get('setup')
  async setupStatus(@Headers() headers: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.deviceAuth.setupStatus(headers);
  }

  @Post('setup/patients')
  @HttpCode(201)
  async setupPatient(@Headers() headers: Record<string, unknown>, @Body() body: unknown): Promise<Record<string, unknown>> {
    return this.deviceAuth.setupCreatePatient(headers, body ?? {});
  }

  @Post('setup/owner')
  @HttpCode(201)
  async setupOwner(@Headers() headers: Record<string, unknown>, @Body() body: unknown, @Req() request: Request): Promise<Record<string, unknown>> {
    return this.deviceAuth.setupFirstOwner(headers, body ?? {}, requestOrigin(request));
  }

  @Post('setup/ai')
  @HttpCode(200)
  async setupAi(@Headers() headers: Record<string, unknown>, @Body() body: unknown): Promise<Record<string, unknown>> {
    return this.deviceAuth.setupCheckAi(headers, body ?? {});
  }

  @Post('setup/nightscout-check')
  @HttpCode(200)
  async setupNightscoutCheck(@Headers() headers: Record<string, unknown>, @Body() body: unknown): Promise<Record<string, unknown>> {
    return this.deviceAuth.setupCheckNightscout(headers, body ?? {});
  }

  @Post('setup/pairing-code')
  @HttpCode(201)
  async setupPairingCode(@Headers() headers: Record<string, unknown>, @Req() request: Request): Promise<Record<string, unknown>> {
    return this.deviceAuth.setupPairingCode(headers, requestOrigin(request));
  }

  @Post('setup/recover')
  @HttpCode(201)
  async recover(@Body() body: unknown): Promise<Record<string, unknown>> {
    return this.deviceAuth.recover(body ?? {});
  }

  @Post('pair')
  @HttpCode(201)
  async pair(@Body() body: unknown): Promise<Record<string, unknown>> {
    return this.deviceAuth.pair(body ?? {});
  }

  @Post('auth/challenge')
  @HttpCode(200)
  async challenge(@Body() body: unknown): Promise<Record<string, unknown>> {
    return this.deviceAuth.sessionChallenge(body ?? {});
  }

  @Post('auth/session')
  @HttpCode(200)
  async session(@Body() body: unknown): Promise<Record<string, unknown>> {
    return { ...(await this.deviceAuth.createSession(body ?? {})) };
  }
}

/** The signed-in person's own devices, pairing codes and invitations; adding a patient. */
@Controller('/v1')
@UseGuards(BearerPrincipalGuard)
@UseFilters(ProblemDetailsFilter)
export class DeviceAccountController {
  constructor(@Inject(DeviceAuthService) private readonly deviceAuth: DeviceAuthService) {}

  @Get('me/devices')
  async listDevices(@Principal() principal: RequestPrincipal): Promise<Record<string, unknown>> {
    return this.deviceAuth.listOwnDevices(principal);
  }

  @Delete('me/devices/:deviceId')
  @HttpCode(204)
  async revokeDevice(@Principal() principal: RequestPrincipal, @Param('deviceId') deviceId: string): Promise<void> {
    await this.deviceAuth.revokeOwnDevice(principal, deviceId);
  }

  @Post('me/devices/bolus-key/challenge')
  @HttpCode(201)
  async bolusKeyChallenge(@Principal() principal: RequestPrincipal): Promise<Record<string, unknown>> {
    return this.deviceAuth.bolusKeyChallenge(principal);
  }

  @Post('me/devices/bolus-key')
  @HttpCode(200)
  async registerBolusKey(@Principal() principal: RequestPrincipal, @Body() body: unknown): Promise<Record<string, unknown>> {
    return this.deviceAuth.registerBolusKey(principal, body ?? {});
  }

  @Get('me/remote-settings-handoffs')
  async myHandoffs(@Principal() principal: RequestPrincipal): Promise<Record<string, unknown>> {
    return this.deviceAuth.listMyHandoffs(principal);
  }

  @Post('me/remote-settings-handoffs/:handoffId/consume')
  @HttpCode(200)
  async consumeHandoff(@Principal() principal: RequestPrincipal, @Param('handoffId') handoffId: string): Promise<Record<string, unknown>> {
    return this.deviceAuth.consumeHandoff(principal, handoffId);
  }

  @Delete('me/remote-settings-handoffs/:handoffId')
  @HttpCode(204)
  async rejectHandoff(@Principal() principal: RequestPrincipal, @Param('handoffId') handoffId: string): Promise<void> {
    await this.deviceAuth.rejectHandoff(principal, handoffId);
  }

  @Get('me/co-owners')
  async coOwners(@Principal() principal: RequestPrincipal): Promise<Record<string, unknown>> {
    return this.deviceAuth.listCoOwnerCandidates(principal);
  }

  @Post('me/pairing-codes')
  @HttpCode(201)
  async pairingCode(@Principal() principal: RequestPrincipal, @Req() request: Request): Promise<Record<string, unknown>> {
    return { ...(await this.deviceAuth.createOwnPairingCode(principal, requestOrigin(request))) };
  }

  @Post('me/invitations/accept')
  @HttpCode(200)
  async acceptInvitation(@Principal() principal: RequestPrincipal, @Body() body: unknown): Promise<Record<string, unknown>> {
    return this.deviceAuth.acceptInvitation(principal, body ?? {});
  }

  @Post('patients')
  @HttpCode(201)
  async createPatient(@Principal() principal: RequestPrincipal, @Body() body: unknown): Promise<Record<string, unknown>> {
    return this.deviceAuth.createPatient(principal, body ?? {});
  }
}

/** A patient's people (owners manage them), invitations by code and the signed remote bolus steps. */
@Controller('/v1/patients/:patientId')
@UseGuards(BearerPrincipalGuard, PatientPermissionGuard)
@UseFilters(ProblemDetailsFilter)
export class DevicePeopleController {
  constructor(@Inject(DeviceAuthService) private readonly deviceAuth: DeviceAuthService) {}

  @Get('people')
  async listPeople(@Principal() principal: RequestPrincipal, @Param('patientId') patientId: string): Promise<Record<string, unknown>> {
    return this.deviceAuth.listPeople(principal, patientId);
  }

  @Get('nightscout')
  async nightscout(@Principal() principal: RequestPrincipal, @Param('patientId') patientId: string): Promise<Record<string, unknown>> {
    return this.deviceAuth.nightscoutSummary(principal, patientId);
  }

  @Post('invitations')
  @HttpCode(201)
  async invite(@Principal() principal: RequestPrincipal, @Param('patientId') patientId: string, @Body() body: unknown, @Req() request: Request): Promise<Record<string, unknown>> {
    return this.deviceAuth.invite(principal, patientId, body ?? {}, requestOrigin(request));
  }

  @Delete('invitations/:invitationId')
  @HttpCode(204)
  async revokeInvitation(@Principal() principal: RequestPrincipal, @Param('patientId') patientId: string, @Param('invitationId') invitationId: string): Promise<void> {
    await this.deviceAuth.revokeInvitation(principal, patientId, invitationId);
  }

  @Put('people/:userId')
  async updatePerson(@Principal() principal: RequestPrincipal, @Param('patientId') patientId: string, @Param('userId') userId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    return { member: await this.deviceAuth.updatePerson(principal, patientId, userId, body ?? {}) };
  }

  @Delete('people/:userId')
  @HttpCode(204)
  async removePerson(@Principal() principal: RequestPrincipal, @Param('patientId') patientId: string, @Param('userId') userId: string): Promise<void> {
    await this.deviceAuth.removePerson(principal, patientId, userId);
  }

  @Delete('people/:userId/devices/:deviceId')
  @HttpCode(204)
  async revokeMemberDevice(@Principal() principal: RequestPrincipal, @Param('patientId') patientId: string, @Param('userId') userId: string, @Param('deviceId') deviceId: string): Promise<void> {
    await this.deviceAuth.revokeMemberDevice(principal, patientId, userId, deviceId);
  }

  @Get('people/:userId/handoff-devices')
  async handoffDevices(@Principal() principal: RequestPrincipal, @Param('patientId') patientId: string, @Param('userId') userId: string): Promise<Record<string, unknown>> {
    return this.deviceAuth.handoffDevices(principal, patientId, userId);
  }

  @Get('remote-settings-handoffs')
  async listHandoffs(@Principal() principal: RequestPrincipal, @Param('patientId') patientId: string): Promise<Record<string, unknown>> {
    return this.deviceAuth.listPatientHandoffs(principal, patientId);
  }

  @Post('remote-settings-handoffs')
  @HttpCode(201)
  async createHandoff(@Principal() principal: RequestPrincipal, @Param('patientId') patientId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    return this.deviceAuth.createHandoff(principal, patientId, body ?? {});
  }

  @Delete('remote-settings-handoffs/:handoffId')
  @HttpCode(204)
  async revokeHandoff(@Principal() principal: RequestPrincipal, @Param('patientId') patientId: string, @Param('handoffId') handoffId: string): Promise<void> {
    await this.deviceAuth.revokeHandoff(principal, patientId, handoffId);
  }

  @Post('signing-challenges')
  @HttpCode(201)
  async signingChallenge(@Principal() principal: RequestPrincipal, @Param('patientId') patientId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    return this.deviceAuth.signingChallenge(principal, patientId, body ?? {});
  }

  @Post('remote-bolus/confirm')
  @HttpCode(200)
  async confirmRemoteBolus(@Principal() principal: RequestPrincipal, @Param('patientId') patientId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    return { member: await this.deviceAuth.confirmRemoteBolus(principal, patientId, body ?? {}) };
  }
}
