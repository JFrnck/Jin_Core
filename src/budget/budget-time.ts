/**
 * Fecha local en formato 'YYYY-MM-DD' (BLUEPRINT 9.6: "reset a las 00:00
 * local"). Usa los getters locales de `Date` (no UTC) — depende de la TZ
 * del proceso: Jin_Infra la fija con `TZ=America/Lima` en el Deployment de
 * jin-core (Fase 9.4; sin eso el reset, el cron de las 00:00 y la alerta de
 * las 06:00 correrían en UTC).
 */
export function todayLocalDate(now: Date = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** Trunca a la hora en curso — bucket para el kill switch (BLUEPRINT 9.6). */
export function currentHourBucket(now: Date = new Date()): Date {
  const bucket = new Date(now);
  bucket.setMinutes(0, 0, 0);
  return bucket;
}
