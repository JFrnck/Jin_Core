import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import { JinError } from '../errors/jin-error';

/**
 * Traduce `JinError.httpStatus` a la respuesta HTTP real (Fase 6.1,
 * hallazgo de la investigación: ningún controller existente propagaba un
 * `JinError` directo a un cliente HTTP — Telegram siempre lo atrapaba a
 * mano — así que este gap nunca se manifestó hasta los endpoints REST
 * nuevos). `JinError` extiende `Error`, no `HttpException`, por lo que
 * sin este filtro Nest lo trataría como error no manejado (500) sin
 * importar el `httpStatus` que la subclase declare.
 */
@Catch()
export class JinErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(JinErrorFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    if (exception instanceof JinError) {
      const status = exception.httpStatus ?? HttpStatus.INTERNAL_SERVER_ERROR;
      response.status(status).json({
        statusCode: status,
        code: exception.code,
        message: exception.message,
      });
      return;
    }

    // `HttpException` es la base de Nest (guards, `ValidationPipe`,
    // `ThrottlerException`, etc.) — `@Catch()` sin argumentos también las
    // captura acá, así que hay que reenviar su status/body reales en vez
    // de aplastarlas con 500.
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      response.status(status).json(exception.getResponse());
      return;
    }

    // Errores 4xx del parser de Express (body-parser / http-errors): cuerpo
    // demasiado grande (413), JSON mal formado (400)... Traen `status` y
    // `expose: true`. Sin esto salían como 500 y parecía un fallo del servidor.
    const parserStatus = exposedClientStatus(exception);
    if (parserStatus !== null) {
      response.status(parserStatus).json({
        statusCode: parserStatus,
        code: parserStatus === 413 ? 'PAYLOAD_TOO_LARGE' : 'BAD_REQUEST',
        message:
          parserStatus === 413
            ? 'La solicitud es demasiado grande.'
            : 'La solicitud no es válida.',
      });
      return;
    }

    this.logger.error(
      exception instanceof Error ? exception.stack : String(exception),
    );
    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      code: 'INTERNAL_ERROR',
      message: 'Error interno del servidor.',
    });
  }
}

/** `status` 4xx de un error de http-errors con `expose: true`, o null. */
function exposedClientStatus(exception: unknown): number | null {
  if (typeof exception !== 'object' || exception === null) return null;
  const { status, expose } = exception as {
    status?: unknown;
    expose?: unknown;
  };
  return expose === true &&
    typeof status === 'number' &&
    status >= 400 &&
    status < 500
    ? status
    : null;
}
