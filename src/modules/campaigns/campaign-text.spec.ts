import {
  extractVariables,
  isOptOutText,
  normalizeVarName,
  renderCampaignMessage,
  renderCampaignText,
  resolveSpintax,
  sameRenderedText,
  seededRandom,
} from './campaign-text';

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

  describe('variáveis', () => {
    it('normaliza nomes (acento, caixa, símbolos) e lista as usadas', () => {
      expect(normalizeVarName('Instagram URL')).toBe('instagram_url');
      expect(normalizeVarName('Cidade')).toBe('cidade');
      expect(extractVariables('Oi {{ Empresa }} de {{cidade}}, {{empresa}} {{Instagram URL}}')).toEqual(['empresa', 'cidade']);
    });

    it('usa colunas extras do CSV e {{empresa}}', () => {
      const r = renderCampaignMessage({
        template: 'Oi {{empresa}} de {{Cidade}}!',
        companyName: 'Acme',
        customData: { cidade: 'Goiânia' },
        seed: 's',
        appendOptOutFooter: false,
      });
      expect(r).toEqual({ text: 'Oi Acme de Goiânia!', missing: [] });
    });

    it('variável sem valor é reportada e nunca vaza a chave crua', () => {
      const r = renderCampaignMessage({ template: 'Oi {{empresa}} de {{cidade}}', companyName: 'Acme', customData: {}, seed: 's', appendOptOutFooter: false });
      expect(r.missing).toEqual(['cidade']);
      expect(r.text).not.toContain('{{');
    });
  });

  describe('spintax', () => {
    it('sorteia uma opção por grupo', () => {
      expect(resolveSpintax('{Olá|Oi|Tudo bem}, pessoal', () => 0)).toBe('Olá, pessoal');
      expect(resolveSpintax('{Olá|Oi|Tudo bem}', () => 0.99)).toBe('Tudo bem');
    });

    it('é recursivo (grupos aninhados)', () => {
      expect(resolveSpintax('{Oi|Olá {tudo bem|como vai}}', () => 0.99)).toBe('Olá como vai');
    });

    it('chaves sem | ficam literais', () => {
      expect(resolveSpintax('Código {A1} e {x|y}', () => 0)).toBe('Código {A1} e x');
    });

    it('variável dentro de uma opção funciona', () => {
      const r = renderCampaignMessage({ template: '{Olá {{empresa}}|Oi {{empresa}}}!', companyName: 'Acme', seed: 'abc', appendOptOutFooter: false });
      expect(['Olá Acme!', 'Oi Acme!']).toContain(r.text);
    });

    it('dados do CSV nunca são interpretados como spintax (sem injeção)', () => {
      const r = renderCampaignMessage({ template: 'Oi {{empresa}}', companyName: '{Acme|Evil}', seed: 's', appendOptOutFooter: false });
      expect(r.text).toBe('Oi {Acme|Evil}');
    });

    it('determinístico: a mesma semente gera sempre o mesmo texto (retry/eco)', () => {
      const input = { template: '{A|B|C|D|E|F} {1|2|3|4|5|6}', companyName: 'X', appendOptOutFooter: true };
      const a = renderCampaignMessage({ ...input, seed: 'camp:rec1' }).text;
      const b = renderCampaignMessage({ ...input, seed: 'camp:rec1' }).text;
      expect(a).toBe(b);
    });

    it('destinatários diferentes recebem textos variados', () => {
      const texts = new Set(
        Array.from({ length: 40 }, (_, i) =>
          renderCampaignMessage({ template: '{Olá|Oi|E aí|Bom dia} {1|2|3|4}', companyName: 'X', seed: `camp:r${i}`, appendOptOutFooter: false }).text,
        ),
      );
      expect(texts.size).toBeGreaterThan(4);
    });

    it('o PRNG semeado é estável e fica em [0,1)', () => {
      const r1 = seededRandom('x');
      const r2 = seededRandom('x');
      for (let i = 0; i < 20; i++) {
        const v = r1();
        expect(v).toBe(r2());
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThan(1);
      }
    });
  });
});
