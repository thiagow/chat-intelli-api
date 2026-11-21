import { normalizePhone } from './phone-normalizer';

describe('normalizePhone', () => {
  it.each([
    ['(11) 99999-8888', '5511999998888'],
    ['11999998888', '5511999998888'],
    ['+55 11 99999-8888', '5511999998888'],
    ['5511999998888', '5511999998888'],
    ['(62) 3255-1234', '556232551234'],
  ])('normaliza %s', (raw, expected) => {
    expect(normalizePhone(raw)).toEqual({ ok: true, e164: expected });
  });

  it('repara celular antigo de 8 dígitos inserindo o 9', () => {
    expect(normalizePhone('(11) 9999-8888')).toEqual({ ok: true, e164: '5511999998888' });
  });

  it('rejeita vazio e inválido', () => {
    expect(normalizePhone('')).toEqual({ ok: false, reason: 'EMPTY' });
    expect(normalizePhone('abc')).toEqual({ ok: false, reason: 'EMPTY' });
    expect(normalizePhone('123')).toEqual({ ok: false, reason: 'INVALID' });
  });
});
