import { createParamDecorator, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { RequestPrincipal } from './bearer-principal.guard';

export const Principal = createParamDecorator((_: unknown, context: ExecutionContext): RequestPrincipal => {
  const request = context.switchToHttp().getRequest<{ principal?: RequestPrincipal }>();
  if (!request.principal) {
    throw new UnauthorizedException('Missing bearer token');
  }

  return request.principal;
});