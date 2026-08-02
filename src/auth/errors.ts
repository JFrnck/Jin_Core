import { JinError } from '../common/errors/jin-error';

export class InvalidCredentialsError extends JinError {
  constructor() {
    super('Contraseña incorrecta.', {
      code: 'AUTH_INVALID_CREDENTIALS',
      httpStatus: 401,
    });
  }
}
