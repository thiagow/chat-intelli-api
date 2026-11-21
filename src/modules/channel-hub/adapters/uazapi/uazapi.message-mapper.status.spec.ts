import { UazapiMessageMapper } from './uazapi.message-mapper';

describe('UazapiMessageMapper.normalizeStatus (lote)', () => {
  const mapper = new UazapiMessageMapper();

  it('Shape A: emite um StatusUpdate por MessageID', () => {
    const out = mapper.normalizeStatus({
      state: 'Delivered',
      event: { MessageIDs: ['A1', 'A2', 'A3'], Type: 'Delivered', Timestamp: 1760000000 },
    });
    expect(out.map((s) => s.externalMessageId)).toEqual(['A1', 'A2', 'A3']);
    expect(out.every((s) => s.status === 'delivered')).toBe(true);
    expect(out[0].timestamp.getTime()).toBe(1760000000 * 1000);
  });

  it('Shape A: ignora ids vazios e estado desconhecido', () => {
    expect(
      mapper.normalizeStatus({
        state: 'Delivered',
        event: { MessageIDs: ['A1', '', null], Timestamp: 1 },
      }).map((s) => s.externalMessageId),
    ).toEqual(['A1']);
    expect(
      mapper.normalizeStatus({ state: 'Whatever', event: { MessageIDs: ['A1'] } }),
    ).toEqual([]);
  });

  it('Shape B: um único update', () => {
    const out = mapper.normalizeStatus({
      message: { messageid: 'B1', status: 'read', timestamp: 1760000000 },
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ externalMessageId: 'B1', status: 'read' });
  });

  it('Shape C: emite todos os itens com ack, não só o primeiro', () => {
    const out = mapper.normalizeStatus({
      messages: [
        { id: 'C1', ack: 2 },
        { id: 'C2', ack: 3 },
        { id: 'C3', ack: 5 },
        { id: 'C4' }, // sem ack/status: ignorado
      ],
    });
    expect(out.map((s) => [s.externalMessageId, s.status])).toEqual([
      ['C1', 'delivered'],
      ['C2', 'read'],
      ['C3', 'failed'],
    ]);
  });

  it('payload vazio ou irreconhecível retorna lista vazia', () => {
    expect(mapper.normalizeStatus(null)).toEqual([]);
    expect(mapper.normalizeStatus({})).toEqual([]);
  });
});
