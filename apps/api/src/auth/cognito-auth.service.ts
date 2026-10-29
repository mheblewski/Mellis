import { Inject, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { PostgresGlucoMindRepository } from '@infra/db/postgres-glucomind.repository';

export interface AuthenticatedPrincipal {
  userId: string;
  providerSubject: string;
}

@Injectable()
export class CognitoAuthService {
  private readonly logger = new Logger(CognitoAuthService.name);
  private verifier?: ReturnType<typeof CognitoJwtVerifier.create>;

  constructor(
    private readonly configService: ConfigService,
    @Inject(PostgresGlucoMindRepository) private readonly repository: PostgresGlucoMindRepository,
  ) {}

  async authenticateBearerToken(token: string, requestPath?: string): Promise<AuthenticatedPrincipal> {
    const payload = await this.verifyToken(token);

    const providerSubject = this.claimAsString(payload, 'sub');
    if (!providerSubject) {
      throw new UnauthorizedException('Invalid bearer token');
    }

    const email = this.claimAsString(payload, 'email');
    const username = this.claimAsString(payload, 'cognito:username') ?? this.claimAsString(payload, 'username');
    const name = this.claimAsString(payload, 'name');

    const resolved = await this.repository.resolveOrCreateUserByCognitoSubject({
      providerSubject,
      email,
      username,
      fullName: name,
    });

    // Throttled with last_seen_at: one sign-in row per identity and AUTH_IDENTITY_TOUCH_INTERVAL_MINUTES, not one per request.
    if (resolved.touched) {
      await this.repository.insertAuditEvent({
        eventType: 'AUTHENTICATE_BEARER_TOKEN',
        outcome: 'ALLOW',
        provider: 'COGNITO',
        providerSubject,
        userId: resolved.userId,
        requestPath: requestPath ?? null,
        metadata: {
          token_use: this.configService.get<string>('COGNITO_TOKEN_USE') ?? 'access',
        },
      });
    }

    return {
      userId: resolved.userId,
      providerSubject,
    };
  }

  private async verifyToken(token: string): Promise<Record<string, unknown>> {
    try {
      if (!this.verifier) {
        this.verifier = CognitoJwtVerifier.create({
          userPoolId: this.configService.getOrThrow<string>('COGNITO_USER_POOL_ID'),
          clientId: this.configService.getOrThrow<string>('COGNITO_CLIENT_ID'),
          tokenUse: this.configService.getOrThrow<'access' | 'id'>('COGNITO_TOKEN_USE'),
        });
      }

      return await this.verifier.verify(token);
    } catch (error) {
      // Logged only: anyone can send a malformed or expired token, so a database row per attempt would let
      // unauthenticated requests grow audit_events without bound.
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Bearer token verification failed: ${reason}`);
      throw new UnauthorizedException('Invalid bearer token');
    }
  }

  private claimAsString(payload: Record<string, unknown>, key: string): string | null {
    const value = payload[key];
    if (typeof value !== 'string') {
      return null;
    }

    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
}
