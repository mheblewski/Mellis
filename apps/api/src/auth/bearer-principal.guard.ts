import { CanActivate, ExecutionContext, Inject, Injectable, Optional, UnauthorizedException } from '@nestjs/common';
import { createHash, timingSafeEqual } from 'crypto';
import { validateLocalTokenAuth } from '@infra/config/environment';
import { CognitoAuthService } from './cognito-auth.service';
import { DeviceAuthService } from '../application/device-auth.service';

export interface RequestPrincipal {
  user_id: string;
  auth_provider?: 'COGNITO' | 'LOCAL_DEV' | 'LOCAL_TOKEN' | 'DEVICE';
  auth_subject?: string;
  /** AUTH_MODE=device: the paired device whose session this is. */
  device_id?: string;
}

@Injectable()
export class BearerPrincipalGuard implements CanActivate {
  constructor(
    private readonly cognitoAuthService: CognitoAuthService,
    // Only AUTH_MODE=device needs it; Cognito modules and tests do not provide it.
    @Optional() @Inject(DeviceAuthService) private readonly deviceAuthService?: DeviceAuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<{
      path?: string;
      url?: string;
      headers: Record<string, string | string[] | undefined>;
      principal?: RequestPrincipal;
    }>();

    const authMode = (process.env.AUTH_MODE ?? 'cognito').trim().toLowerCase();
    if (authMode === 'disabled') {
      const userId = (process.env.AUTH_DISABLED_USER_ID ?? '00000000-0000-4000-8000-000000000001').trim();
      request.principal = {
        user_id: userId,
        auth_provider: 'LOCAL_DEV',
        auth_subject: `local-dev:${userId}`,
      };

      return true;
    }

    const authorizationHeader = request.headers.authorization;
    const authorization = Array.isArray(authorizationHeader) ? authorizationHeader[0] : authorizationHeader;

    if (!authorization?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing bearer token');
    }

    const token = authorization.slice('Bearer '.length).trim();
    if (!token) {
      throw new UnauthorizedException('Missing bearer token');
    }

    if (authMode === 'local_token') {
      request.principal = authenticateLocalToken(token);
      return true;
    }

    if (authMode === 'device') {
      // A session token from a signed challenge (docs/device-auth-api.md); Cognito is never asked.
      const principal = this.deviceAuthService ? await this.deviceAuthService.resolveSessionToken(token) : null;
      if (!principal) throw new UnauthorizedException('Invalid bearer token');
      request.principal = principal;
      return true;
    }

    const authenticated = await this.cognitoAuthService.authenticateBearerToken(token, request.path ?? request.url);
    request.principal = {
      user_id: authenticated.userId,
      auth_provider: 'COGNITO',
      auth_subject: authenticated.providerSubject,
    };

    return true;
  }
}
/**
 * AUTH_MODE=local_token (development only, see validateLocalTokenAuth): the bearer token's SHA-256 must equal the
 * configured hash, compared in constant time; the principal comes only from LOCAL_AUTH_USER_ID. Invalid configuration
 * or a wrong token is a plain 401; neither the token nor the hash appears in errors or logs.
 */
function authenticateLocalToken(token: string): RequestPrincipal {
  let config: { userId: string; tokenSha256: string };
  try {
    config = validateLocalTokenAuth(process.env);
  } catch {
    throw new UnauthorizedException('Invalid bearer token');
  }
  const expected = Buffer.from(config.tokenSha256, 'hex');
  const presented = createHash('sha256').update(token, 'utf8').digest();
  if (expected.length !== presented.length || !timingSafeEqual(expected, presented)) {
    throw new UnauthorizedException('Invalid bearer token');
  }
  return {
    user_id: config.userId,
    auth_provider: 'LOCAL_TOKEN',
    auth_subject: `local-token:${config.userId}`,
  };
}
