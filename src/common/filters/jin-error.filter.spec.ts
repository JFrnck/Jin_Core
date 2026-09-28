import { ArgumentsHost, BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { JinError } from '../errors/jin-error';
import { JinErrorFilter } from './jin-error.filter';

class NotFoundThing extends JinError {
  constructor() {
    super('no encontrado', { code: 'THING_NOT_FOUND', httpStatus: 404 });
  }
}

class NoStatusError extends JinError {
  constructor() {
    super('sin status declarado', { code: 'THING_BROKEN' });
  }
}

function buildHost(): {
  host: ArgumentsHost;
  status: ReturnType<typeof vi.fn>;
} {
  const json = vi.fn();
  const status = vi.fn().mockReturnValue({ json });
  const host = {
    switchToHttp: () => ({
      getResponse: () => ({ status }),
      getRequest: () => ({}),
    }),
  } as unknown as ArgumentsHost;
  return { host, status };
}

describe('JinErrorFilter', () => {
  it('traduce JinError.httpStatus al código HTTP real', () => {
    const filter = new JinErrorFilter();
    const { host, status } = buildHost();

    filter.catch(new NotFoundThing(), host);

    expect(status).toHaveBeenCalledWith(404);
  });

  it('usa 500 si el JinError no declara httpStatus', () => {
    const filter = new JinErrorFilter();
    const { host, status } = buildHost();

    filter.catch(new NoStatusError(), host);

    expect(status).toHaveBeenCalledWith(500);
  });

  it('reenvía status/body real de una HttpException de Nest', () => {
    const filter = new JinErrorFilter();
    const { host, status } = buildHost();

    filter.catch(new BadRequestException('payload inválido'), host);

    expect(status).toHaveBeenCalledWith(400);
  });

  it('devuelve 500 sin filtrar detalles internos para errores no-JinError', () => {
    const filter = new JinErrorFilter();
    const { host, status } = buildHost();

    filter.catch(new Error('detalle interno sensible'), host);

    expect(status).toHaveBeenCalledWith(500);
  });

  it('errores 4xx del parser de Express (413, JSON inválido) responden 4xx, no 500', () => {
    const filter = new JinErrorFilter();
    const tooLarge = Object.assign(new Error('request entity too large'), {
      status: 413,
      expose: true,
    });
    const badJson = Object.assign(new SyntaxError('Unexpected token'), {
      status: 400,
      expose: true,
    });
    const internal = Object.assign(new Error('boom'), {
      status: 500,
      expose: false,
    });

    const a = buildHost();
    filter.catch(tooLarge, a.host);
    expect(a.status).toHaveBeenCalledWith(413);

    const b = buildHost();
    filter.catch(badJson, b.host);
    expect(b.status).toHaveBeenCalledWith(400);

    const c = buildHost();
    filter.catch(internal, c.host);
    expect(c.status).toHaveBeenCalledWith(500);
  });
});
