import { BadRequestException } from '@nestjs/common';
import { parse } from 'csv-parse/sync';
import * as iconv from 'iconv-lite';
import { CAMPAIGN_LIMITS } from '../campaigns.constants';

export interface ParsedCsvRow {
  /** Número da linha no arquivo original (cabeçalho = 1). */
  rowNumber: number;
  rawPhone: string;
  companyName: string;
  messageText: string;
  /** Preenchido quando a linha já é inválida no parse (mensagem vazia/longa). */
  error?: string;
}

const ALIASES = {
  phone: ['whatsapp', 'telefone', 'numero', 'phone', 'celular', 'fone'],
  company: ['empresa', 'nome_empresa', 'company', 'nome'],
  message: ['mensagem', 'message', 'texto', 'msg'],
} as const;

function normHeader(h: string): string {
  return h
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}

/** UTF-8 estrito; se falhar, assume win1252 (Excel BR). */
export function decodeCsvBuffer(buf: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return iconv.decode(buf, 'win1252');
  }
}

/** Detecta `, ; \t` pela primeira linha (fora de aspas). */
export function detectDelimiter(text: string): string {
  const firstLine = text.replace(/^﻿/, '').split(/\r?\n/, 1)[0] ?? '';
  const counts = [',', ';', '\t'].map((d) => ({ d, n: firstLine.split(d).length - 1 }));
  counts.sort((a, b) => b.n - a.n);
  return counts[0].n > 0 ? counts[0].d : ',';
}

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

export function parseCampaignCsv(buf: Buffer): ParsedCsvRow[] {
  if (!buf?.length) throw new BadRequestException('Arquivo vazio');
  if (buf.length > CAMPAIGN_LIMITS.maxFileBytes) {
    throw new BadRequestException('Arquivo excede 5 MB');
  }

  const text = decodeCsvBuffer(buf);
  const delimiter = detectDelimiter(text);

  let records: string[][];
  try {
    records = parse(text, {
      bom: true,
      delimiter,
      relax_column_count: true,
      skip_empty_lines: true,
      trim: true,
    }) as string[][];
  } catch (e: any) {
    throw new BadRequestException(`CSV inválido: ${e.message}`);
  }
  if (records.length < 2) throw new BadRequestException('O CSV precisa de cabeçalho e ao menos uma linha');

  const header = records[0].map(normHeader);
  const idx = (names: readonly string[]) => header.findIndex((h) => names.includes(h));
  const phoneIdx = idx(ALIASES.phone);
  const companyIdx = idx(ALIASES.company);
  const messageIdx = idx(ALIASES.message);
  const missing = [
    phoneIdx < 0 && 'whatsapp',
    companyIdx < 0 && 'empresa',
    messageIdx < 0 && 'mensagem',
  ].filter(Boolean);
  if (missing.length) {
    throw new BadRequestException(`Colunas obrigatórias ausentes: ${missing.join(', ')}`);
  }

  const dataRows = records.slice(1);
  if (dataRows.length > CAMPAIGN_LIMITS.maxRows) {
    throw new BadRequestException(`O arquivo excede ${CAMPAIGN_LIMITS.maxRows} linhas`);
  }

  return dataRows.map((r, i): ParsedCsvRow => {
    const messageText = (r[messageIdx] ?? '').replace(CONTROL_CHARS, '').trim();
    const row: ParsedCsvRow = {
      rowNumber: i + 2,
      rawPhone: (r[phoneIdx] ?? '').trim(),
      companyName: (r[companyIdx] ?? '').replace(CONTROL_CHARS, '').trim(),
      messageText,
    };
    if (!messageText) row.error = 'MESSAGE_EMPTY';
    else if (messageText.length > CAMPAIGN_LIMITS.maxMessageChars) row.error = 'MESSAGE_TOO_LONG';
    return row;
  });
}
