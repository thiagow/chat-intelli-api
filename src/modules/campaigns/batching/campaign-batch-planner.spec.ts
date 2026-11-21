import { effectiveDailyCap, planBatches } from './campaign-batch-planner';

const TZ = 'America/Sao_Paulo'; // UTC-3 (sem DST desde 2019)
const base = {
  windowStart: '09:00',
  windowEnd: '18:00',
  weekdays: [1, 2, 3, 4, 5],
  timezone: TZ,
  delayMinSec: 30,
  delayMaxSec: 90,
};

describe('planBatches', () => {
  it('divide pelo teto, um lote por dia útil, no início da janela', () => {
    // Segunda 2026-11-23 06:00 BRT = 09:00Z (antes da janela)
    const plan = planBatches({ ...base, recipientCount: 5, dailyCap: 2, notBefore: new Date('2026-11-23T09:00:00Z') });
    expect(plan.batches.map((b) => b.size)).toEqual([2, 2, 1]);
    expect(plan.batches[0].scheduledFor.toISOString()).toBe('2026-11-23T12:00:00.000Z'); // 09:00 BRT
    expect(plan.batches[1].scheduledFor.toISOString()).toBe('2026-11-24T12:00:00.000Z');
    expect(plan.batches[2].scheduledFor.toISOString()).toBe('2026-11-25T12:00:00.000Z');
  });

  it('pula fim de semana', () => {
    const plan = planBatches({ ...base, recipientCount: 4, dailyCap: 2, notBefore: new Date('2026-11-27T09:00:00Z') }); // sexta
    expect(plan.batches[0].scheduledFor.toISOString()).toBe('2026-11-27T12:00:00.000Z');
    expect(plan.batches[1].scheduledFor.toISOString()).toBe('2026-11-30T12:00:00.000Z'); // segunda
  });

  it('hoje: começa de agora dentro da janela e só enche o que cabe', () => {
    // Segunda 16:00 BRT = 19:00Z; restam 2h = 7200s / 60s = 120 envios
    const plan = planBatches({ ...base, recipientCount: 500, dailyCap: 1000, notBefore: new Date('2026-11-23T19:00:00Z') });
    expect(plan.batches[0].scheduledFor.toISOString()).toBe('2026-11-23T19:00:00.000Z');
    expect(plan.batches[0].size).toBe(120);
    expect(plan.batches[1].scheduledFor.toISOString()).toBe('2026-11-24T12:00:00.000Z');
  });

  it('depois do fim da janela vai para o próximo dia útil', () => {
    const plan = planBatches({ ...base, recipientCount: 1, dailyCap: 10, notBefore: new Date('2026-11-23T22:00:00Z') }); // 19:00 BRT
    expect(plan.batches[0].scheduledFor.toISOString()).toBe('2026-11-24T12:00:00.000Z');
  });

  it('respeita o timezone (domingo à noite local = segunda em UTC)', () => {
    // 23:30 BRT de domingo 22/11 = 02:30Z de 23/11 -> segunda 09:00 BRT
    const plan = planBatches({ ...base, recipientCount: 1, dailyCap: 10, notBefore: new Date('2026-11-23T02:30:00Z') });
    expect(plan.batches[0].scheduledFor.toISOString()).toBe('2026-11-23T12:00:00.000Z');
  });

  it('janela que não comporta o teto reduz o teto efetivo', () => {
    // 9h = 32400s; média 60s -> 540
    expect(effectiveDailyCap(1000, '09:00', '18:00', 30, 90)).toEqual({ cap: 540, limitedByWindow: true });
    const plan = planBatches({ ...base, recipientCount: 1000, dailyCap: 1000, notBefore: new Date('2026-11-23T09:00:00Z') });
    expect(plan.effectiveDailyCap).toBe(540);
    expect(plan.capLimitedByWindow).toBe(true);
    expect(plan.batches.map((b) => b.size)).toEqual([540, 460]);
  });

  it('valida entradas', () => {
    expect(() => planBatches({ ...base, windowEnd: '08:00', recipientCount: 1, dailyCap: 1, notBefore: new Date() })).toThrow();
    expect(() => planBatches({ ...base, weekdays: [], recipientCount: 1, dailyCap: 1, notBefore: new Date() })).toThrow();
  });

  it('zero destinatários = sem lotes', () => {
    expect(planBatches({ ...base, recipientCount: 0, dailyCap: 1, notBefore: new Date() }).batches).toEqual([]);
  });
});
