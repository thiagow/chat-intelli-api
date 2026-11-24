import { OPT_OUT_FOOTER, OPT_OUT_KEYWORDS } from './campaigns.constants';

/** Normaliza para comparação: trim, colapsa espaços/quebras, sem acento, maiúsculo. */
export function normalizeForMatch(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

/** Match EXATO (evita falso positivo em "não quero parar de comprar"). */
export function isOptOutText(text: string | null | undefined): boolean {
  if (!text) return false;
  const n = normalizeForMatch(text).replace(/[.!?]+$/g, '');
  return (OPT_OUT_KEYWORDS as readonly string[]).includes(n);
}

// ─── Resposta negativa (opt-out por conteúdo) ────────────────────────

/** Minúsculo, sem acento nem pontuação, espaços colapsados — base da detecção de resposta negativa. */
export function normalizeReply(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    // pontuação separa orações: "não, pode tirar da lista" ≠ "não vou sair da lista"
    .replace(/[,.;:!?()\-–—]+/g, ' | ')
    .replace(/[^a-z0-9|]+/g, ' ')
    .replace(/ +/g, ' ')
    .trim();
}

/** Frases explícitas de recusa: valem em qualquer posição da mensagem (com limite de palavra). */
const NEGATIVE_PHRASES = [
  // desinteresse
  'nao tenho interesse', 'nao temos interesse', 'nao tenho mais interesse', 'sem interesse',
  'nao me interessa', 'nao estou interessado', 'nao estou interessada',
  // sair da lista
  'tirar da lista', 'tira da lista', 'tire da lista', 'me tire da lista', 'me tira da lista', 'tirem da lista',
  'remover da lista', 'remova da lista', 'retirar da lista', 'retire da lista', 'excluir da lista', 'exclua da lista',
  'sair da lista', 'saia da lista', 'me remova', 'me remove', 'me exclua', 'me tire',
  // não quer receber
  'nao quero receber', 'nao quero mais receber', 'nao me envie', 'nao me mande', 'nao envie mais', 'nao mande mais',
  'nao quero mais mensagem', 'nao quero mais mensagens', 'nao quero mais contato',
  // descadastro
  'cancelar inscricao', 'cancelar cadastro', 'unsubscribe',
  // sinais de denúncia (o número está em risco)
  'vou denunciar', 'vou te denunciar', 'vou bloquear', 'vou te bloquear', 'e spam', 'isso e spam',
] as const;

/** Verbos de "pare/saia/tire". `para` só vale seguido de "de" (senão é preposição). */
const STOP_VERBS = new Set([
  'parar', 'pare', 'parem', 'para', 'sair', 'saia', 'cancelar', 'cancele', 'remover', 'remova', 'remove',
  'tirar', 'tire', 'tira', 'retirar', 'retire', 'excluir', 'exclua', 'apagar', 'apague',
]);
/** Alvos que tornam o verbo uma recusa de contato (e não "parar na loja", "cancelar o contrato"). */
const STOP_TARGETS = new Set([
  'lista', 'contato', 'contatos', 'mensagem', 'mensagens', 'msg', 'receber', 'enviar', 'mandar', 'enviando',
  'mandando', 'spam', 'cadastro', 'numero', 'whatsapp', 'ligar', 'ligacao', 'ligacoes', 'email', 'emails', 'propaganda', 'promocao', 'promocoes',
]);
const NEGATIONS = new Set(['nao', 'nunca', 'jamais', 'sem']);

export type NegativeReplyKind = 'EXACT' | 'PHRASE' | 'VERB_TARGET' | 'DESCADASTR';

export interface NegativeReply {
  kind: NegativeReplyKind;
  /** Trecho que disparou (para auditoria). */
  term: string;
}

/**
 * Detecta recusa/pedido de saída numa resposta. Conservador de propósito: bloquear um lead legítimo por
 * falso positivo também custa dinheiro, então palavras soltas ("parar", "sair", "cancelar") só valem
 *   - se a mensagem for SÓ isso (SAIR, PARAR, STOP…), ou
 *   - seguidas de um alvo de contato ("parar de me mandar mensagem", "sair da lista"), sem negação antes
 *     ("não vou sair da lista"), ou
 *   - dentro de uma frase explícita de recusa ("não tenho interesse", "tirar da lista").
 * "Posso parar na loja amanhã?" e "cancelar o contrato" NÃO disparam.
 */
export function detectNegativeReply(text: string | null | undefined): NegativeReply | null {
  if (!text) return null;
  if (isOptOutText(text)) return { kind: 'EXACT', term: normalizeForMatch(text).replace(/[.!?]+$/g, '') };

  const n = normalizeReply(text);
  if (!n) return null;
  const tokens = n.split(' ');

  /** Há negação nas 2 palavras antes de `i`, sem atravessar uma quebra de oração ("|")? */
  const negatedBefore = (i: number): boolean => {
    for (let k = i - 1, seen = 0; k >= 0 && seen < 2; k--, seen++) {
      if (tokens[k] === '|') return false;
      if (NEGATIONS.has(tokens[k])) return true;
    }
    return false;
  };

  for (const phrase of NEGATIVE_PHRASES) {
    const words = phrase.split(' ');
    for (let i = 0; i + words.length <= tokens.length; i++) {
      if (!words.every((w, k) => tokens[i + k] === w)) continue;
      // Frases que já nascem negativas ("não tenho interesse", "sem interesse") não sofrem a regra de negação;
      // as demais ("sair da lista", "me remova") são anuladas por "não vou sair da lista".
      const intrinsic = words[0] === 'nao' || words[0] === 'sem';
      if (!intrinsic && negatedBefore(i)) continue;
      return { kind: 'PHRASE', term: phrase };
    }
  }
  const desc = n.match(/\bdescadastr\w*/);
  if (desc) return { kind: 'DESCADASTR', term: desc[0] };

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!STOP_VERBS.has(t)) continue;
    if (t === 'para' && tokens[i + 1] !== 'de') continue;
    if (negatedBefore(i)) continue; // "não vou sair da lista", "nunca vou parar de receber"
    const target = tokens.slice(i + 1, i + 5).find((x) => STOP_TARGETS.has(x));
    if (target) return { kind: 'VERB_TARGET', term: t + ' … ' + target };
  }
  return null;
}

/** Normaliza o nome de uma variável/coluna: sem acento, minúsculo, `_` no lugar de símbolos. */
export function normalizeVarName(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}

const VARIABLE_RE = /\{\{\s*([^{}\s|]+)\s*\}\}/g;

/** Variáveis `{{nome}}` usadas no modelo (normalizadas, sem repetição). */
export function extractVariables(template: string): string[] {
  const out = new Set<string>();
  for (const m of template.matchAll(VARIABLE_RE)) out.add(normalizeVarName(m[1]));
  return [...out];
}

/** Hash FNV-1a de 32 bits (semente estável para o sorteio do spintax). */
export function hashSeed(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** PRNG determinístico (mulberry32): mesma semente → mesma sequência. */
export function seededRandom(seed: string): () => number {
  let a = hashSeed(seed);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Resolve spintax `{Olá|Oi|Tudo bem}` (inclusive aninhado). Só grupos com `|` são sorteados;
 * chaves sem `|` ficam como texto literal.
 */
export function resolveSpintax(text: string, random: () => number): string {
  const group = /\{([^{}]*\|[^{}]*)\}/g;
  let out = text;
  for (let pass = 0; pass < 50; pass++) {
    let changed = false;
    out = out.replace(group, (_m, inner: string) => {
      changed = true;
      const options = inner.split('|');
      return options[Math.floor(random() * options.length)];
    });
    if (!changed) break;
  }
  return out;
}

// Marcadores de uso privado (Unicode PUA): protegem as variáveis enquanto o spintax é sorteado.
const VAR_OPEN = '\uE000';
const VAR_CLOSE = '\uE001';
const VAR_MARKER = /\uE000(\d+)\uE001/g;

export interface RenderMessageInput {
  template: string;
  companyName: string;
  /** Colunas extras do CSV (chaves normalizadas). */
  customData?: Record<string, string> | null;
  /** Semente estável (ex.: `campaignId:recipientId`): retry e reenvio geram o MESMO texto. */
  seed: string;
  appendOptOutFooter: boolean;
}

export interface RenderedMessage {
  text: string;
  /** Variáveis usadas e sem valor (não deveriam existir: a importação já invalida a linha). */
  missing: string[];
}

/**
 * Texto enviado de fato: variáveis (`{{empresa}}` + colunas do CSV) e spintax, determinísticos por
 * destinatário, mais o rodapé de opt-out opcional. O spintax é resolvido ANTES de inserir os valores,
 * então dados do CSV nunca são interpretados como spintax.
 */
export function renderCampaignMessage(input: RenderMessageInput): RenderedMessage {
  const values: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.customData ?? {})) values[normalizeVarName(k)] = String(v ?? '').trim();
  values.empresa = input.companyName.trim();

  // 1) troca cada {{var}} por um marcador protegido (o spintax não enxerga as chaves delas)
  const used: string[] = [];
  const protectedText = input.template.replace(VARIABLE_RE, (_m, name: string) => {
    used.push(normalizeVarName(name));
    return `${VAR_OPEN}${used.length - 1}${VAR_CLOSE}`;
  });

  // 2) sorteia o spintax
  const spun = resolveSpintax(protectedText, seededRandom(input.seed));

  // 3) devolve os valores (texto puro) nos marcadores que sobraram
  const missing = new Set<string>();
  const body = spun
    .replace(VAR_MARKER, (_m, i: string) => {
      const name = used[Number(i)];
      const value = values[name];
      if (!value) {
        missing.add(name);
        return '';
      }
      return value;
    })
    .trim();

  return {
    text: input.appendOptOutFooter ? `${body}\n\n${OPT_OUT_FOOTER}` : body,
    missing: [...missing],
  };
}

/** Compatível com o uso antigo (só `{{empresa}}`, sem spintax determinístico). */
export function renderCampaignText(
  template: string,
  companyName: string,
  appendOptOutFooter: boolean,
): string {
  return renderCampaignMessage({ template, companyName, seed: 'static', appendOptOutFooter }).text;
}

/** Comparação do texto do echo contra o `renderedText` (tolerante a espaços/quebras). */
export function sameRenderedText(a: string, b: string): boolean {
  const n = (s: string) => s.replace(/\s+/g, ' ').trim();
  return n(a) === n(b);
}
