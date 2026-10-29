import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { AppError } from '@shared/errors/app-error';
import { ProblemDetails, toProblemDetails } from '@shared/errors/problem-details';

/** RFC 9457 media type of every error body. */
export const PROBLEM_CONTENT_TYPE = 'application/problem+json; charset=utf-8';

interface ProblemResponse {
  status(code: number): ProblemResponse;
  setHeader(name: string, value: string): unknown;
  json(body: unknown): unknown;
}

@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemDetailsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<ProblemResponse>();
    const request = host.switchToHttp().getRequest<{ originalUrl?: string }>();

    if (exception instanceof AppError) {
      send(response, toProblemDetails({
        type: `https://mellis.invalid/problems/${exception.code.toLowerCase()}`,
        title: exception.message,
        status: exception.httpStatus,
        code: exception.code,
        instance: request.originalUrl,
      }));
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      // A missing or invalid bearer token (the guard's UnauthorizedException) has the code of the shared UnauthorizedError.
      const unauthenticated = status === HttpStatus.UNAUTHORIZED;
      const code = unauthenticated ? 'UNAUTHENTICATED' : 'HTTP_EXCEPTION';
      send(response, toProblemDetails({
        type: unauthenticated ? 'https://mellis.invalid/problems/unauthenticated' : `https://mellis.invalid/problems/http-${status}`,
        title: exception.message,
        status,
        code,
        instance: request.originalUrl,
      }));
      return;
    }

    this.logger.error('Unhandled exception', exception instanceof Error ? exception.stack : String(exception));

    send(response, toProblemDetails({
      type: 'https://mellis.invalid/problems/internal-error',
      title: 'Internal Server Error',
      status: 500,
      code: 'INTERNAL_ERROR',
      instance: request.originalUrl,
    }));
  }
}

function send(response: ProblemResponse, problem: ProblemDetails): void {
  // Set before json(): Express keeps a Content-Type that is already set.
  response.setHeader('Content-Type', PROBLEM_CONTENT_TYPE);
  response.status(problem.status).json(problem);
}
