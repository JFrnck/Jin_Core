import type { BudgetConfig } from './budget.types';

export interface HourlyUsage {
  readonly hourBucket: Date;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/**
 * `true` si el consumo de la hora actual es "runaway" respecto al
 * promedio de las horas anteriores dentro de la ventana de lookback
 * (BLUEPRINT 9.6: "si en 1 hora se consumen >2× de lo consumido en las
 * 24h previas"). Interpretación explícita (el blueprint no lo desambigua
 * más): se compara contra el PROMEDIO por hora de las últimas
 * `runawayLookbackHours`, no contra el total crudo — comparar 1h contra
 * un total de 24h directamente no tendría sentido como detector de tasa.
 * Sin filas de lookback (arranque en frío, servicio recién desplegado)
 * no hay base de comparación → nunca dispara falsos positivos por falta
 * de historial.
 *
 * PISO ABSOLUTO (`runawayMinHourlyTokens`): la razón contra el promedio sola
 * NO basta. El promedio divide entre `runawayLookbackHours` aunque solo
 * existan una o dos horas de historial, así que en un sistema recién
 * desplegado sale minúsculo y cualquier conversación normal parece un
 * desastre. Visto en el primer uso real (2026-09-21): 5 487 tokens (~$0.02)
 * contra un promedio de ~208 tokens/h = 26x, y el kill switch pausó todo. El
 * comentario de arriba prometía "nunca falsos positivos por falta de
 * historial" pero solo cubría el caso de CERO filas, no el de una o dos.
 *
 * El mismo defecto afecta a los procesos por lotes legítimos (el análisis
 * nocturno de Canvas gasta en una hora lo que el resto del día no): el piso
 * los deja pasar. Un runaway real -- un agente en bucle -- supera el piso en
 * minutos, y lo que quede por debajo lo frena el tope diario.
 */
export function isRunawayDetected(
  currentHourUsage: number,
  lookbackHours: readonly HourlyUsage[],
  config: BudgetConfig,
): boolean {
  if (lookbackHours.length === 0) {
    return false;
  }

  // Por debajo del piso no es una emergencia, sea cual sea la razón.
  if (currentHourUsage < config.runawayMinHourlyTokens) {
    return false;
  }

  const lookbackTotal = lookbackHours.reduce(
    (sum, hour) => sum + hour.inputTokens + hour.outputTokens,
    0,
  );
  const avgHourlyUsage = lookbackTotal / config.runawayLookbackHours;

  if (avgHourlyUsage <= 0) {
    return false;
  }

  return currentHourUsage > avgHourlyUsage * config.runawayMultiplier;
}
