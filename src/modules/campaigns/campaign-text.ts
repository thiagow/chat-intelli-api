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

/** Texto enviado de fato: placeholder `{{empresa}}` + rodapé de opt-out opcional. */
export function renderCampaignText(
  template: string,
  companyName: string,
  appendOptOutFooter: boolean,
): string {
  const body = template.replace(/\{\{\s*empresa\s*\}\}/gi, companyName).trim();
  return appendOptOutFooter ? `${body}\n\n${OPT_OUT_FOOTER}` : body;
}

/** Comparação do texto do echo contra o `renderedText` (tolerante a espaços/quebras). */
export function sameRenderedText(a: string, b: string): boolean {
  const n = (s: string) => s.replace(/\s+/g, ' ').trim();
  return n(a) === n(b);
}
