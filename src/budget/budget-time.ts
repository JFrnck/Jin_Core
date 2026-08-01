/**
 * Fecha local en formato 'YYYY-MM-DD' (BLUEPRINT 9.6: "reset a las 00:00
 * local"). Usa los getters locales de `Date` (no UTC) — asume que la TZ
 * del pod está configurada correctamente; configurar esa TZ es un
 * detalle de despliegue (Jin_Infra), no de este módulo.
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
