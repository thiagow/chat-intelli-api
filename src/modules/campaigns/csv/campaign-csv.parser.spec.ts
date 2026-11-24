import iconv from 'iconv-lite';
import { parseCampaignCsv } from './campaign-csv.parser';

const buf = (s: string) => Buffer.from(s, 'utf8');

describe('parseCampaignCsv', () => {
  it('vírgula, aliases e números de linha', () => {
    const rows = parseCampaignCsv(buf('telefone,empresa,mensagem\n11999998888,Acme,Oi {{empresa}}\n'));
    expect(rows).toEqual([
      { rowNumber: 2, rawPhone: '11999998888', companyName: 'Acme', messageText: 'Oi {{empresa}}', customData: {} },
    ]);
  });

  it('ponto e vírgula + BOM', () => {
    const rows = parseCampaignCsv(buf('﻿WhatsApp;Empresa;Mensagem\n11999998888;Acme;Olá'));
    expect(rows[0].messageText).toBe('Olá');
  });

  it('tab', () => {
    expect(parseCampaignCsv(buf('numero\tcompany\ttexto\n1\tA\tB'))[0].companyName).toBe('A');
  });

  it('win1252 com fallback', () => {
    const b = iconv.encode('whatsapp;empresa;mensagem\n11999998888;Pão & Cia;Olá, tudo bem?', 'win1252');
    const rows = parseCampaignCsv(b);
    expect(rows[0].companyName).toBe('Pão & Cia');
  });

  it('aspas com quebra de linha', () => {
    const rows = parseCampaignCsv(buf('whatsapp,empresa,mensagem\n1,A,"linha1\nlinha2, com vírgula"'));
    expect(rows[0].messageText).toBe('linha1\nlinha2, com vírgula');
  });

  it('marca mensagem vazia / longa', () => {
    const long = 'x'.repeat(4097);
    const rows = parseCampaignCsv(buf(`whatsapp,empresa,mensagem\n1,A,\n2,B,${long}`));
    expect(rows[0].error).toBe('MESSAGE_EMPTY');
    expect(rows[1].error).toBe('MESSAGE_TOO_LONG');
  });

  it('erros de estrutura', () => {
    expect(() => parseCampaignCsv(buf(''))).toThrow();
    expect(() => parseCampaignCsv(buf('a,b,c\n1,2,3'))).toThrow(/ausentes/);
    expect(() => parseCampaignCsv(buf('whatsapp,empresa,mensagem'))).toThrow();
  });

  it('limite de linhas', () => {
    const lines = Array.from({ length: 5001 }, (_, i) => `${i},A,m`).join('\n');
    expect(() => parseCampaignCsv(buf(`whatsapp,empresa,mensagem\n${lines}`))).toThrow(/5000/);
  });

  it('colunas extras viram customData com chave normalizada (variáveis da mensagem)', () => {
    const rows = parseCampaignCsv(
      buf('whatsapp;empresa;mensagem;Cidade;Instagram URL;Observação\n11999998888;Acme;Oi {{cidade}};Goiânia;https://instagram.com/acme;\n'),
    );
    expect(rows[0].customData).toEqual({ cidade: 'Goiânia', instagram_url: 'https://instagram.com/acme' });
    // valor vazio não vira chave (a importação invalida a linha se o modelo usar a variável)
    expect(rows[0].customData).not.toHaveProperty('observacao');
  });

  it('coluna extra repetida não sobrescreve; valores longos são cortados', () => {
    const long = 'x'.repeat(900);
    const rows = parseCampaignCsv(buf(`whatsapp,empresa,mensagem,cidade,cidade\n11999998888,Acme,Oi,${long},Outra\n`));
    expect(rows[0].customData.cidade).toHaveLength(500);
  });

  it('mais de 20 colunas extras é recusado', () => {
    const extra = Array.from({ length: 21 }, (_, i) => `c${i}`);
    const csv = `whatsapp,empresa,mensagem,${extra.join(',')}\n11999998888,A,B,${extra.map(() => 'v').join(',')}\n`;
    expect(() => parseCampaignCsv(buf(csv))).toThrow(/colunas extras/);
  });
});
