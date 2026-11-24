import { assignSmoothWeighted, planChips, summarizeChipPlans } from './campaign-chip-planner';

const base = {
  windowStart: '09:00',
  windowEnd: '18:00',
  weekdays: [1, 2, 3, 4, 5],
  timezone: 'America/Sao_Paulo',
  delayMinSec: 30,
  delayMaxSec: 90,
  notBefore: new Date('2026-11-23T09:00:00Z'), // segunda 06:00 BRT
  random: () => 0.5,
};

describe('assignSmoothWeighted', () => {
  it('pesos iguais intercalam os chips (A B A B…), não em blocos', () => {
    expect(assignSmoothWeighted(6, [100, 100])).toEqual([0, 1, 0, 1, 0, 1]);
  });

  it('respeita a proporção dos pesos', () => {
    const out = assignSmoothWeighted(300, [200, 100]);
    expect(out.filter((i) => i === 0).length).toBe(200);
    expect(out.filter((i) => i === 1).length).toBe(100);
  });

  it('é intercalado mesmo com pesos diferentes (nunca um chip longe de receber)', () => {
    const out = assignSmoothWeighted(30, [2, 1]);
    // padrão 0 0 1 repetido: nenhum chip passa mais de 2 posições seguidas sem vez
    let run = 0;
    let maxRun = 0;
    for (let i = 1; i < out.length; i++) {
      run = out[i] === out[i - 1] ? run + 1 : 0;
      maxRun = Math.max(maxRun, run);
    }
    expect(maxRun).toBeLessThanOrEqual(1);
  });

  it('determinístico e soma = total', () => {
    expect(assignSmoothWeighted(17, [5, 3, 1])).toEqual(assignSmoothWeighted(17, [5, 3, 1]));
    expect(assignSmoothWeighted(17, [5, 3, 1])).toHaveLength(17);
  });

  it('um chip só recebe tudo; zero destinatários ou sem chips = vazio', () => {
    expect(assignSmoothWeighted(4, [200])).toEqual([0, 0, 0, 0]);
    expect(assignSmoothWeighted(0, [1, 1])).toEqual([]);
    expect(assignSmoothWeighted(5, [])).toEqual([]);
  });

  it('peso inválido (0/negativo) vira 1: nenhum chip é ignorado nem divide por zero', () => {
    const out = assignSmoothWeighted(6, [0, -5]);
    expect(out.filter((i) => i === 0).length).toBe(3);
    expect(out.filter((i) => i === 1).length).toBe(3);
  });
});

describe('planChips', () => {
  it('um chip = mesmo plano da campanha de um canal só', () => {
    const [only] = planChips([{ channelId: 'A', dailyLimit: 30 }], 70, { ...base, batchSize: 20, batchPauseMinSec: 60, batchPauseMaxSec: 60 });
    expect(only.recipientCount).toBe(70);
    expect(only.plan.batches.map((b) => b.size)).toEqual([20, 10, 20, 10, 10]);
  });

  it('divide entre chips pelo teto diário e cada chip tem a própria cadeia de lotes', () => {
    const plans = planChips(
      [
        { channelId: 'A', dailyLimit: 20 },
        { channelId: 'B', dailyLimit: 10 },
      ],
      60,
      { ...base, batchSize: 10, batchPauseMinSec: 60, batchPauseMaxSec: 60 },
    );
    expect(plans.map((p) => p.recipientCount)).toEqual([40, 20]);
    // A: 20/dia → 2 dias; B: 10/dia → 2 dias. Cada chip planeja o próprio calendário.
    expect(plans[0].plan.days).toBe(2);
    expect(plans[1].plan.days).toBe(2);
    expect(plans[0].plan.batches.reduce((n, b) => n + b.size, 0)).toBe(40);
    expect(plans[1].plan.batches.reduce((n, b) => n + b.size, 0)).toBe(20);
  });

  it('chips rodam em paralelo: o término é o do chip mais lento, não a soma', () => {
    const one = planChips([{ channelId: 'A', dailyLimit: 20 }], 40, { ...base, batchSize: 10, batchPauseMinSec: 60, batchPauseMaxSec: 60 });
    const two = planChips(
      [
        { channelId: 'A', dailyLimit: 20 },
        { channelId: 'B', dailyLimit: 20 },
      ],
      40,
      { ...base, batchSize: 10, batchPauseMinSec: 60, batchPauseMaxSec: 60 },
    );
    expect(summarizeChipPlans(one).days).toBe(2);
    expect(summarizeChipPlans(two).days).toBe(1); // 20 + 20 no mesmo dia
  });

  it('cada chip sorteia o próprio jitter de início (cadeias independentes)', () => {
    let i = 0;
    const seq = [0.1, 0.9]; // chip A sorteia 0,1×jitter; chip B 0,9×jitter
    const plans = planChips(
      [
        { channelId: 'A', dailyLimit: 10 },
        { channelId: 'B', dailyLimit: 10 },
      ],
      4,
      { ...base, batchSize: 10, startJitterMaxMin: 20, random: () => seq[i++ % 2] },
    );
    const a = plans[0].plan.batches[0].scheduledFor.getTime();
    const b = plans[1].plan.batches[0].scheduledFor.getTime();
    expect(a).not.toBe(b);
  });

  it('chip sem destinatários (mais chips que contatos) gera plano vazio sem erro', () => {
    const plans = planChips(
      [
        { channelId: 'A', dailyLimit: 10 },
        { channelId: 'B', dailyLimit: 10 },
        { channelId: 'C', dailyLimit: 10 },
      ],
      2,
      { ...base, batchSize: 10 },
    );
    expect(plans.map((p) => p.recipientCount)).toEqual([1, 1, 0]);
    expect(plans[2].plan.batches).toEqual([]);
    expect(summarizeChipPlans(plans).batches).toBe(2);
  });

  it('sem chips é erro; resumo agrega lotes, dias e primeiro/último horário', () => {
    expect(() => planChips([], 5, base)).toThrow();
    const plans = planChips(
      [
        { channelId: 'A', dailyLimit: 10 },
        { channelId: 'B', dailyLimit: 10 },
      ],
      30,
      { ...base, batchSize: 5, batchPauseMinSec: 60, batchPauseMaxSec: 60 },
    );
    const sum = summarizeChipPlans(plans);
    expect(sum.batches).toBe(plans[0].plan.batches.length + plans[1].plan.batches.length);
    expect(sum.firstBatchAt).toBeInstanceOf(Date);
    expect(sum.estimatedEnd!.getTime()).toBeGreaterThan(sum.firstBatchAt!.getTime());
    expect(sum.effectiveDailyCap).toBe(plans[0].plan.effectiveDailyCap + plans[1].plan.effectiveDailyCap);
  });
});
