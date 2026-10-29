import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { CodedError } from '@shared/errors/app-error';
import { PostgresGlucoMindRepository } from '@infra/db/postgres-glucomind.repository';
import type { RequestPrincipal } from './bearer-principal.guard';

/**
 * Patient routes a member with only "Glukoza i alarmy" may use; every other patient route (chats, meals, the Bolus tab,
 * remote commands, AI, sharing) needs "Rozmowy z AI i posiłki". Ported from sharing stage 2 (c6fe5a04) for the
 * self-hosted server, without the pause switch.
 */
const GLUCOSE_ROUTE_SUFFIXES = new Set([
  'capabilities',
  'dashboard',
  'dashboard/history',
  'dashboard/time-in-range',
  'notifications',
  'devices',
  'devices/:deviceId/notification-settings',
  'devices/:deviceId/live-activity',
  'events',
  // The Nightscout address and newest reading (Settings → the patient's page).
  'nightscout',
  // Leaving a patient and confirming one's own remote bolus are the member's own business.
  'people/:userId',
]);

export function patientRouteScope(routePath: string): 'glucose' | 'care' {
  const suffix = routePath.replace(/^\/?v1\/patients\/:patientId\/?/, '');
  return GLUCOSE_ROUTE_SUFFIXES.has(suffix) ? 'glucose' : 'care';
}

/**
 * Runs after BearerPrincipalGuard on /v1/patients/:patientId routes. Not a member: passes, the service answers 403 and
 * audits it as before. A member without the route's permission gets PERMISSION_DENIED.
 */
@Injectable()
export class PatientPermissionGuard implements CanActivate {
  constructor(@Inject(PostgresGlucoMindRepository) private readonly repository: PostgresGlucoMindRepository) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<{ principal?: RequestPrincipal; params?: Record<string, string>; route?: { path?: string } }>();
    const patientId = request.params?.patientId;
    if (!request.principal || !patientId) return true;
    const access = await this.repository.getMemberScopes(request.principal.user_id, patientId).catch(() => null);
    if (!access || access.is_owner) return true;
    const scope = patientRouteScope(request.route?.path ?? '');
    const allowed = scope === 'glucose' ? access.glucose_alerts || access.ai_chat_meals : access.ai_chat_meals;
    if (!allowed) throw new CodedError('PERMISSION_DENIED', 403, scope === 'care' ? 'This person may see glucose only' : 'No access to glucose');
    return true;
  }
}
