import { effectiveDailyCap, fitCount, planBatches, randomPauseSec } from './campaign-batch-planner';

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

  describe('lotes dentro do dia com pausa aleatória', () => {
    const pace = { ...base, batchSize: 40, batchPauseMinSec: 300, batchPauseMaxSec: 300 };

    it('fatia o dia em lotes de até batchSize, com a pausa entre eles', () => {
      const plan = planBatches({ ...pace, recipientCount: 100, dailyCap: 100, notBefore: new Date('2026-11-23T09:00:00Z') });
      expect(plan.batches.map((b) => b.size)).toEqual([40, 40, 20]);
      // 40 × 60s = 2400s de envio + 300s de pausa = 45 min entre inícios
      expect(plan.batches[0].scheduledFor.toISOString()).toBe('2026-11-23T12:00:00.000Z');
      expect(plan.batches[1].scheduledFor.toISOString()).toBe('2026-11-23T12:45:00.000Z');
      expect(plan.batches[2].scheduledFor.toISOString()).toBe('2026-11-23T13:30:00.000Z');
      expect(plan.days).toBe(1);
    });

    it('batchSize maior que o teto diário não cria lote vazio', () => {
      const plan = planBatches({ ...pace, batchSize: 500, recipientCount: 30, dailyCap: 30, notBefore: new Date('2026-11-23T09:00:00Z') });
      expect(plan.batches.map((b) => b.size)).toEqual([30]);
    });

    it('o teto diário continua valendo e o resto vai para o próximo dia útil', () => {
      const plan = planBatches({
        ...base,
        batchSize: 20,
        batchPauseMinSec: 60,
        batchPauseMaxSec: 60,
        recipientCount: 70,
        dailyCap: 30,
        notBefore: new Date('2026-11-23T09:00:00Z'),
      });
      expect(plan.batches.map((b) => b.size)).toEqual([20, 10, 20, 10, 10]);
      expect(plan.days).toBe(3);
      expect(plan.batches[2].scheduledFor.toISOString()).toBe('2026-11-24T12:00:00.000Z');
    });

    it('as pausas contam na capacidade da janela (usa a pausa máxima)', () => {
      // 1h = 3600s; média 60s; lotes de 20; pausa máx 600s → cabem 40 (2400s + 600s), não 60
      expect(effectiveDailyCap(1000, '09:00', '10:00', 30, 90, 20, 600)).toEqual({ cap: 40, limitedByWindow: true });
      expect(fitCount(3600, 60, 20, 600)).toBe(40);
      expect(fitCount(3600, 60, 20, 0)).toBe(60);
    });

    it('a pausa sorteada fica dentro da faixa (aleatoriedade injetada)', () => {
      expect(randomPauseSec(300, 900, () => 0)).toBe(300);
      expect(randomPauseSec(300, 900, () => 0.5)).toBe(600);
      expect(randomPauseSec(300, 900, () => 1)).toBe(900);
      expect(randomPauseSec(900, 300, () => 0.5)).toBe(900); // max < min: usa o mínimo
    });

    it('com pausas diferentes entre lotes o início de cada lote respeita o sorteio', () => {
      const seq = [0, 1];
      let i = 0;
      const plan = planBatches({
        ...base,
        batchSize: 10,
        batchPauseMinSec: 300,
        batchPauseMaxSec: 900,
        recipientCount: 30,
        dailyCap: 30,
        notBefore: new Date('2026-11-23T09:00:00Z'),
        random: () => seq[i++ % 2],
      });
      const starts = plan.batches.map((b) => b.scheduledFor.getTime());
      // 10 × 60s = 600s de envio; pausa 300s (sorteio 0) e depois 900s (sorteio 1)
      expect(starts[1] - starts[0]).toBe((600 + 300) * 1000);
      expect(starts[2] - starts[1]).toBe((600 + 900) * 1000);
    });
  });

  it('valida entradas', () => {
    expect(() => planBatches({ ...base, windowEnd: '08:00', recipientCount: 1, dailyCap: 1, notBefore: new Date() })).toThrow();
    expect(() => planBatches({ ...base, weekdays: [], recipientCount: 1, dailyCap: 1, notBefore: new Date() })).toThrow();
  });

  it('zero destinatários = sem lotes', () => {
    expect(planBatches({ ...base, recipientCount: 0, dailyCap: 1, notBefore: new Date() }).batches).toEqual([]);
  });
});
