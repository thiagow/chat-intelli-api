/**
 * Rodízio entre chips: distribui destinatários entre os canais participantes e planeja a cadeia de lotes
 * de cada chip de forma independente. Funções puras (sem Prisma, sem relógio implícito).
 */
import { BatchPlan, BatchPlanInput, planBatches } from './campaign-batch-planner';

export interface ChipSpec {
  channelId: string;
  /** Teto diário DESTE chip (também é o peso do rodízio). */
  dailyLimit: number;
}

/**
 * Round-robin ponderado "suave" (smooth weighted round-robin): intercala os chips em vez de entregar
 * todos os de um chip em sequência, e respeita os pesos (um chip com limite 2× recebe ~2× mais).
 * Determinístico: o resultado só depende de `total` e `weights`. Devolve, para cada posição, o índice do chip.
 */
export function assignSmoothWeighted(total: number, weights: number[]): number[] {
  const w = weights.map((x) => Math.max(1, Math.floor(x)));
  if (!w.length || total <= 0) return [];
  const sum = w.reduce((a, b) => a + b, 0);
  const current = w.map(() => 0);
  const out: number[] = [];
  for (let n = 0; n < total; n++) {
    let best = 0;
    for (let i = 0; i < w.length; i++) {
      current[i] += w[i];
      if (current[i] > current[best]) best = i;
    }
    current[best] -= sum;
    out.push(best);
  }
  return out;
}

export interface ChipPlan {
  channelId: string;
  /** Quantos destinatários ficaram com este chip. */
  recipientCount: number;
  /** Índices (na lista original de destinatários) atribuídos a este chip, em ordem. */
  recipientIndexes: number[];
  plan: BatchPlan;
}

/**
 * Divide `recipientCount` entre os chips (ponderado pelo teto diário) e planeja a cadeia de lotes de
 * cada um com o próprio teto, pausas e jitter de início (sorteios independentes por chip).
 */
export function planChips(
  chips: ChipSpec[],
  recipientCount: number,
  base: Omit<BatchPlanInput, 'recipientCount' | 'dailyCap'>,
): ChipPlan[] {
  if (!chips.length) throw new Error('Selecione ao menos um canal');
  const owner = assignSmoothWeighted(recipientCount, chips.map((c) => c.dailyLimit));
  const buckets: number[][] = chips.map(() => []);
  owner.forEach((chipIdx, recipientIdx) => buckets[chipIdx].push(recipientIdx));

  return chips.map((chip, i) => ({
    channelId: chip.channelId,
    recipientCount: buckets[i].length,
    recipientIndexes: buckets[i],
    plan: planBatches({ ...base, recipientCount: buckets[i].length, dailyCap: chip.dailyLimit }),
  }));
}

/** Resumo agregado das cadeias (para a estimativa exibida ao usuário). */
export function summarizeChipPlans(plans: ChipPlan[]) {
  const withBatches = plans.filter((p) => p.plan.batches.length > 0);
  const ends = withBatches.map((p) => p.plan.estimatedEnd).filter((d): d is Date => !!d);
  const firsts = withBatches.map((p) => p.plan.batches[0].scheduledFor);
  return {
    batches: plans.reduce((n, p) => n + p.plan.batches.length, 0),
    days: Math.max(0, ...plans.map((p) => p.plan.days)),
    estimatedEnd: ends.length ? new Date(Math.max(...ends.map((d) => d.getTime()))) : null,
    firstBatchAt: firsts.length ? new Date(Math.min(...firsts.map((d) => d.getTime()))) : null,
    effectiveDailyCap: plans.reduce((n, p) => n + p.plan.effectiveDailyCap, 0),
    capLimitedByWindow: plans.some((p) => p.plan.capLimitedByWindow),
  };
}
