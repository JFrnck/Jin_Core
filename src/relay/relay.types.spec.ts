import { describe, expect, it } from 'vitest';
import {
  buildCallbackData,
  MAX_OPTIONS,
  parseCallbackData,
} from './relay.types';

const UUID = '6f1b6a0e-2b3c-4d5e-8f90-1a2b3c4d5e6f';

describe('callback_data de los botones', () => {
  it('ida y vuelta conserva la pregunta y la opción', () => {
    expect(parseCallbackData(buildCallbackData(UUID, 3))).toEqual({
      questionId: UUID,
      index: 3,
    });
  });

  it('cabe en los 64 bytes que impone Telegram', () => {
    const data = buildCallbackData(UUID, MAX_OPTIONS - 1);
    expect(Buffer.byteLength(data, 'utf-8')).toBeLessThanOrEqual(64);
  });

  it.each([
    ['vacío', ''],
    ['sin prefijo', `${UUID}:0`],
    ['prefijo ajeno', `x:${UUID}:0`],
    ['sin índice', `q:${UUID}`],
    ['con basura al final', `q:${UUID}:0:extra`],
    ['id vacío', 'q::0'],
    ['índice no numérico', `q:${UUID}:abc`],
    ['índice decimal', `q:${UUID}:1.5`],
    ['índice negativo', `q:${UUID}:-1`],
    ['índice fuera de rango', `q:${UUID}:${MAX_OPTIONS}`],
  ])('rechaza %s', (_caso, data) => {
    expect(parseCallbackData(data)).toBeNull();
  });

  it('rechaza un índice enorme: el atacante no elige fuera del teclado', () => {
    // El índice viene del cliente de Telegram y se usa para indexar `options`.
    // Que esté acotado es lo que impide leer fuera de las opciones ofrecidas.
    expect(parseCallbackData(`q:${UUID}:999999`)).toBeNull();
  });
});
