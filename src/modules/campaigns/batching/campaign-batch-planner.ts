/**
 * Planejamento dos lotes diários de uma campanha. Função pura: sem Prisma,
 * sem relógio implícito — `notBefore` e `timezone` entram como parâmetro.
 */

export interface BatchPlanInput {
  recipientCount: number;
  dailyCap: number;
  /** "HH:mm" no timezone da org. */
  windowStart: string;
  windowEnd: string;
  /** 0 = domingo … 6 = sábado (Date#getDay). */
  weekdays: number[];
  timezone: string;
  delayMinSec: number;
  delayMaxSec: number;
  /** Início mais cedo permitido (agora ou `scheduledAt`). */
  notBefore: Date;
}

export interface PlannedBatch {
  batchIndex: number;
  scheduledFor: Date;
  size: number;
}

export interface BatchPlan {
  batches: PlannedBatch[];
  /** Teto diário efetivo: o que a janela comporta dado o intervalo médio. */
  effectiveDailyCap: number;
  capLimitedByWindow: boolean;
  estimatedEnd: Date | null;
}

const MAX_SCAN_DAYS = 400;

export function parseHm(hm: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hm);
  if (!m) throw new Error(`Horário inválido: ${hm}`);
  return Number(m[1]) * 60 + Number(m[2]);
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  weekday: number;
  minutes: number;
}

export function getZonedParts(date: Date, timeZone: string): ZonedParts {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    weekday: 'short',
  });
  const p: Record<string, string> = {};
  for (const part of f.formatToParts(date)) p[part.type] = part.value;
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday);
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    weekday: wd,
    minutes: Number(p.hour) * 60 + Number(p.minute),
  };
}

/** Converte "parede" (y-m-d + minutos) em um timezone para instante UTC. */
export function zonedToUtc(
  y: number,
  m: number,
  d: number,
  minutes: number,
  timeZone: string,
): Date {
  const guess = Date.UTC(y, m - 1, d, Math.floor(minutes / 60), minutes % 60);
  // Duas passadas resolvem a borda de DST.
  let ts = guess;
  for (let i = 0; i < 2; i++) {
    const z = getZonedParts(new Date(ts), timeZone);
    const asUtc = Date.UTC(z.year, z.month - 1, z.day, Math.floor(z.minutes / 60), z.minutes % 60);
    ts += guess - asUtc;
  }
  return new Date(ts);
}

export function effectiveDailyCap(
  dailyCap: number,
  windowStart: string,
  windowEnd: string,
  delayMinSec: number,
  delayMaxSec: number,
): { cap: number; limitedByWindow: boolean } {
  const windowSec = (parseHm(windowEnd) - parseHm(windowStart)) * 60;
  const avg = (delayMinSec + delayMaxSec) / 2;
  const fits = Math.max(1, Math.floor(windowSec / Math.max(avg, 1)));
  return fits < dailyCap ? { cap: fits, limitedByWindow: true } : { cap: dailyCap, limitedByWindow: false };
}

export function planBatches(input: BatchPlanInput): BatchPlan {
  const start = parseHm(input.windowStart);
  const end = parseHm(input.windowEnd);
  if (end <= start) throw new Error('A janela de envio precisa terminar depois de começar');
  if (!input.weekdays.length) throw new Error('Selecione ao menos um dia da semana');

  const { cap, limitedByWindow } = effectiveDailyCap(
    input.dailyCap,
    input.windowStart,
    input.windowEnd,
    input.delayMinSec,
    input.delayMaxSec,
  );
  const avgSec = (input.delayMinSec + input.delayMaxSec) / 2;

  const batches: PlannedBatch[] = [];
  let remaining = input.recipientCount;
  if (remaining <= 0) {
    return { batches, effectiveDailyCap: cap, capLimitedByWindow: limitedByWindow, estimatedEnd: null };
  }

  const first = getZonedParts(input.notBefore, input.timezone);
  // Cursor em dias de calendário no timezone da org.
  const baseDay = Date.UTC(first.year, first.month - 1, first.day);
  let lastEnd: Date | null = null;

  for (let offset = 0; offset < MAX_SCAN_DAYS && remaining > 0; offset++) {
    const dayUtc = new Date(baseDay + offset * 86_400_000);
    const y = dayUtc.getUTCFullYear();
    const m = dayUtc.getUTCMonth() + 1;
    const d = dayUtc.getUTCDate();
    if (!input.weekdays.includes(dayUtc.getUTCDay())) continue;

    let startMin = start;
    if (offset === 0) {
      // Hoje: só o que ainda cabe na janela, a partir de agora.
      if (first.minutes >= end) continue;
      startMin = Math.max(start, first.minutes);
    }
    const slotSec = (end - startMin) * 60;
    const fitsToday = Math.max(0, Math.floor(slotSec / Math.max(avgSec, 1)));
    const size = Math.min(cap, fitsToday, remaining);
    if (size <= 0) continue;

    const scheduledFor = zonedToUtc(y, m, d, startMin, input.timezone);
    batches.push({ batchIndex: batches.length, scheduledFor, size });
    remaining -= size;
    lastEnd = new Date(scheduledFor.getTime() + size * avgSec * 1000);
  }

  if (remaining > 0) throw new Error('Não foi possível encaixar a campanha nos próximos 400 dias');
  return { batches, effectiveDailyCap: cap, capLimitedByWindow: limitedByWindow, estimatedEnd: lastEnd };
}
