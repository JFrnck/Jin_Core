import { z } from 'zod';

// Zod v4 no puede representar `z.date()` en JSON Schema ("Date cannot be
// represented in JSON Schema" — revienta `pnpm run generate:contract`).
// Pero el valor real que `ZodSerializerInterceptor` ve en runtime para
// columnas `timestamp` de Drizzle ES un `Date` (Express recién lo vuelve
// ISO string al serializar la respuesta a JSON, un paso después). El
// codec resuelve la tensión: el lado "input"/documentado es un string
// ISO (representable en JSON Schema), `encode` es lo que
// `nestjs-zod` usa para responses cuando el DTO se crea con
// `{ codec: true }` (ver README de nestjs-zod, sección Codecs).
export const dateCodec = z.codec(z.iso.datetime(), z.date(), {
  decode: (iso) => new Date(iso),
  encode: (date) => date.toISOString(),
});

export const nullableDateCodec = z.codec(
  z.iso.datetime().nullable(),
  z.date().nullable(),
  {
    decode: (iso) => (iso === null ? null : new Date(iso)),
    encode: (date) => (date === null ? null : date.toISOString()),
  },
);
