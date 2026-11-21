import { isOptOutText, renderCampaignText, sameRenderedText } from './campaign-text';

describe('campaign-text', () => {
  it('opt-out: match exato, ignora acento/caixa/pontuação final', () => {
    expect(isOptOutText('sair')).toBe(true);
    expect(isOptOutText('  PARAR! ')).toBe(true);
    expect(isOptOutText('Descadastrar')).toBe(true);
    expect(isOptOutText('quero parar de receber')).toBe(false);
    expect(isOptOutText('não quero sair daqui')).toBe(false);
    expect(isOptOutText(null)).toBe(false);
  });

  it('render: placeholder e rodapé', () => {
    expect(renderCampaignText('Oi {{empresa}}!', 'Acme', false)).toBe('Oi Acme!');
    expect(renderCampaignText('Oi {{ Empresa }}', 'Acme', true)).toContain('Responda SAIR');
  });

  it('sameRenderedText tolera espaços e quebras', () => {
    expect(sameRenderedText('a  b\n\nc', 'a b c')).toBe(true);
    expect(sameRenderedText('a b', 'a c')).toBe(false);
  });
});
