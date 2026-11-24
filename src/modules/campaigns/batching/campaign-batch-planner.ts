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
  /** Máximo de mensagens por lote. Ausente = um lote por dia (comportamento antigo). */
  batchSize?: number;
  /** Pausa aleatória entre lotes do mesmo dia (segundos). Ausente = 0. */
  batchPauseMinSec?: number;
  batchPauseMaxSec?: number;
  /** Tamanho mínimo do lote: cada lote é sorteado entre `batchSizeMin` e `batchSize`. Ausente = `batchSize` fixo. */
  batchSizeMin?: number;
  /** Variação (min) no início do dia: o 1º lote começa em janela + sorteio(0, jitter). Ausente = 0. */
  startJitterMaxMin?: number;
  /** Fonte de aleatoriedade (injetável nos testes). */
  random?: () => number;
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
  /** Dias distintos (no fuso da org) com envio. */
  days: number;
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

/**
 * Quantas mensagens cabem em `slotSec`, contando o intervalo médio entre mensagens e as pausas
 * entre lotes. Usa a pausa MÁXIMA: o sorteio nunca empurra o último lote para fora da janela.
 */
export function fitCount(slotSec: number, avgDelaySec: number, batchSize: number, pauseMaxSec: number): number {
  const avg = Math.max(avgDelaySec, 1);
  const bs = Math.max(1, batchSize);
  const timeFor = (n: number) => n * avg + (Math.ceil(n / bs) - 1) * pauseMaxSec;
  let lo = 0;
  let hi = Math.floor(slotSec / avg);
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (timeFor(mid) <= slotSec) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export function effectiveDailyCap(
  dailyCap: number,
  windowStart: string,
  windowEnd: string,
  delayMinSec: number,
  delayMaxSec: number,
  batchSize: number = Number.MAX_SAFE_INTEGER,
  pauseMaxSec = 0,
  startJitterMaxSec = 0,
): { cap: number; limitedByWindow: boolean } {
  // O jitter de início consome parte da janela: reserva o pior caso.
  const windowSec = Math.max(0, (parseHm(windowEnd) - parseHm(windowStart)) * 60 - startJitterMaxSec);
  const avg = (delayMinSec + delayMaxSec) / 2;
  const fits = Math.max(1, fitCount(windowSec, avg, batchSize, pauseMaxSec));
  return fits < dailyCap ? { cap: fits, limitedByWindow: true } : { cap: dailyCap, limitedByWindow: false };
}

/** Sorteia uma pausa (segundos) entre `min` e `max`. */
export function randomPauseSec(min: number, max: number, random: () => number = Math.random): number {
  const lo = Math.max(0, min);
  const hi = Math.max(lo, max);
  if (hi === lo) return Math.round(lo); // sem faixa: não gasta sorteio
  return Math.round(lo + random() * (hi - lo));
}

/** Inteiro sorteado em [min, max] (inclusivo). */
export function randomInt(min: number, max: number, random: () => number = Math.random): number {
  const lo = Math.ceil(Math.min(min, max));
  const hi = Math.floor(Math.max(min, max));
  if (hi === lo) return lo; // sem faixa: não gasta sorteio
  return lo + Math.floor(random() * (hi - lo + 1));
}

export function planBatches(input: BatchPlanInput): BatchPlan {
  const start = parseHm(input.windowStart);
  const end = parseHm(input.windowEnd);
  if (end <= start) throw new Error('A janela de envio precisa terminar depois de começar');
  if (!input.weekdays.length) throw new Error('Selecione ao menos um dia da semana');

  const batchSize = Math.max(1, input.batchSize ?? Number.MAX_SAFE_INTEGER);
  // Piso do sorteio do tamanho do lote (nunca acima do máximo).
  const batchSizeMin = Math.min(batchSize, Math.max(1, input.batchSizeMin ?? batchSize));
  const jitterMaxSec = Math.max(0, (input.startJitterMaxMin ?? 0) * 60);
  const pauseMin = Math.max(0, input.batchPauseMinSec ?? 0);
  const pauseMax = Math.max(pauseMin, input.batchPauseMaxSec ?? pauseMin);
  const random = input.random ?? Math.random;

  const { cap, limitedByWindow } = effectiveDailyCap(
    input.dailyCap,
    input.windowStart,
    input.windowEnd,
    input.delayMinSec,
    input.delayMaxSec,
    batchSizeMin,
    pauseMax,
    jitterMaxSec,
  );
  const avgSec = (input.delayMinSec + input.delayMaxSec) / 2;

  const batches: PlannedBatch[] = [];
  let remaining = input.recipientCount;
  if (remaining <= 0) {
    return { batches, effectiveDailyCap: cap, capLimitedByWindow: limitedByWindow, estimatedEnd: null, days: 0 };
  }

  const first = getZonedParts(input.notBefore, input.timezone);
  // Cursor em dias de calendário no timezone da org.
  const baseDay = Date.UTC(first.year, first.month - 1, first.day);
  let lastEnd: Date | null = null;
  let days = 0;

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
    // Jitter só no dia que abre na hora cheia da janela (não "hoje, a partir de agora").
    const jitterSec = startMin === start ? randomPauseSec(0, jitterMaxSec, random) : 0;
    const slotSec = Math.max(0, (end - startMin) * 60 - (startMin === start ? jitterMaxSec : 0));
    const fitsToday = fitCount(slotSec, avgSec, batchSizeMin, pauseMax);
    let dayTotal = Math.min(cap, fitsToday, remaining);
    if (dayTotal <= 0) continue;
    days++;

    // Fatia o dia em lotes de até `batchSize`, com pausa aleatória entre eles.
    let cursor = zonedToUtc(y, m, d, startMin, input.timezone).getTime() + jitterSec * 1000;
    while (dayTotal > 0) {
      // Tamanho sorteado por lote (o último leva o que sobrar): lotes sempre iguais são um padrão detectável.
      const size = Math.min(randomInt(batchSizeMin, batchSize, random), dayTotal);
      batches.push({ batchIndex: batches.length, scheduledFor: new Date(cursor), size });
      const runMs = size * avgSec * 1000;
      lastEnd = new Date(cursor + runMs);
      dayTotal -= size;
      remaining -= size;
      cursor += runMs + randomPauseSec(pauseMin, pauseMax, random) * 1000;
    }
  }

  if (remaining > 0) throw new Error('Não foi possível encaixar a campanha nos próximos 400 dias');
  return { batches, effectiveDailyCap: cap, capLimitedByWindow: limitedByWindow, estimatedEnd: lastEnd, days };
}
