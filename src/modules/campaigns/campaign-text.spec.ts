import {
  detectNegativeReply,
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

  describe('detectNegativeReply (opt-out por conteúdo da resposta)', () => {
    it.each([
      // exemplos do requisito
      'Parar',
      'parar!',
      'Não tenho interesse',
      'nao tenho interesse, obrigado',
      'Por favor, tirar da lista',
      'me tire da lista',
      // variações comuns
      'Sem interesse.',
      'não me interessa',
      'Não temos interesse no momento',
      'pode remover da lista?',
      'me remova dessa lista',
      'Não quero receber mais mensagens',
      'não me envie mais nada',
      'parar de me mandar mensagem',
      'pare de enviar isso',
      'para de me ligar',
      'quero sair da lista',
      'Descadastrar',
      'quero me descadastrar',
      'unsubscribe',
      'isso é spam',
      'vou denunciar esse número',
      // existentes (match exato)
      'SAIR', 'stop', 'Cancelar', 'DESCADASTRAR',
    ])('detecta recusa: %s', (txt) => {
      expect(detectNegativeReply(txt)).not.toBeNull();
    });

    it.each([
      'Olá, tenho interesse! Pode me ligar?',
      'Posso parar na loja amanhã?',
      'Vou parar de comprar do fornecedor atual e fechar com vocês',
      'Quero cancelar o contrato com meu fornecedor atual',
      'não vou sair da lista de vocês, quero continuar recebendo',
      'nunca vou parar de receber as ofertas, adoro',
      'Pode enviar a proposta?',
      'Para receber a proposta, qual o e-mail?',
      'Qual o prazo para entrega?',
      'sim, pode mandar mais detalhes',
      'preciso sair para uma reunião, falo com você depois',
      '',
      '   ',
    ])('NÃO bloqueia lead legítimo: "%s"', (txt) => {
      expect(detectNegativeReply(txt)).toBeNull();
    });

    it('negação anula o pedido, mas pontuação separa as orações', () => {
      expect(detectNegativeReply('não vou sair da lista')).toBeNull();
      expect(detectNegativeReply('nunca me remova da lista, adoro as ofertas')).toBeNull();
      expect(detectNegativeReply('não me tire da lista')).toBeNull();
      // vírgula/ponto encerram a oração: aqui o "não" é a resposta e o pedido vem depois
      expect(detectNegativeReply('Não, pode tirar da lista')).toMatchObject({ kind: 'PHRASE' });
      expect(detectNegativeReply('Não. Me remova da lista')).toMatchObject({ kind: 'PHRASE' });
      // frases que já nascem negativas não são anuladas pelo "não" que fazem parte
      expect(detectNegativeReply('não tenho interesse')).toMatchObject({ kind: 'PHRASE' });
      expect(detectNegativeReply('sem interesse, obrigado')).toMatchObject({ kind: 'PHRASE' });
    });

    it('texto nulo/indefinido não detecta', () => {
      expect(detectNegativeReply(null)).toBeNull();
      expect(detectNegativeReply(undefined)).toBeNull();
    });

    it('ignora acento, caixa e pontuação', () => {
      expect(detectNegativeReply('NÃO TENHO INTERESSE!!!')).toMatchObject({ kind: 'PHRASE' });
      expect(detectNegativeReply('TIRAR   DA   LISTA!!!')).toMatchObject({ kind: 'PHRASE' });
    });

    it('informa o tipo e o trecho que disparou (auditoria)', () => {
      expect(detectNegativeReply('SAIR')).toMatchObject({ kind: 'EXACT' });
      expect(detectNegativeReply('não tenho interesse')).toEqual({ kind: 'PHRASE', term: 'nao tenho interesse' });
      expect(detectNegativeReply('pare de me mandar mensagem')).toMatchObject({ kind: 'VERB_TARGET' });
      expect(detectNegativeReply('quero me descadastrar')).toMatchObject({ kind: 'DESCADASTR' });
    });

    it('"para" só vale com "de" (senão é preposição)', () => {
      expect(detectNegativeReply('para de me enviar')).toMatchObject({ kind: 'VERB_TARGET' });
      expect(detectNegativeReply('para enviar o orçamento preciso do CNPJ')).toBeNull();
    });
  });
});
