import { parsePhoneNumberFromString, CountryCode } from 'libphonenumber-js';

export type PhoneNormalization =
  | { ok: true; e164: string }
  | { ok: false; reason: 'EMPTY' | 'INVALID' };

/**
 * Normaliza para E.164 **só com dígitos** (formato usado pela UaZAPI e pelos
 * nossos ContactChannel). Região padrão BR: aceita com/sem 55, com máscara,
 * e repara celular antigo de 8 dígitos (DDD + 6-9xxxxxxx) inserindo o 9.
 * A confirmação definitiva do JID real vem depois, via `/chat/check`.
 */
export function normalizePhone(
  raw: string | null | undefined,
  defaultRegion: CountryCode = 'BR',
): PhoneNormalization {
  const cleaned = String(raw ?? '').replace(/[^\d+]/g, '');
  if (!cleaned.replace(/\D/g, '')) return { ok: false, reason: 'EMPTY' };

  const attempt = (input: string) => {
    const parsed = parsePhoneNumberFromString(input, defaultRegion);
    return parsed && parsed.isValid() ? parsed.number.replace(/^\+/, '') : null;
  };

  const candidates: string[] = [];
  const digits = cleaned.replace(/\D/g, '');

  // Celular BR legado: DDD(2) + 8 dígitos começando em 6-9 → insere o 9.
  const national = digits.startsWith('55') && digits.length === 12 ? digits.slice(2) : digits;
  if (defaultRegion === 'BR' && national.length === 10 && /^[6-9]/.test(national.slice(2))) {
    // Fixo BR começa em 2-5; 6-9 após o DDD é celular sem o 9 → repara ANTES do parse direto.
    candidates.push(`${national.slice(0, 2)}9${national.slice(2)}`);
  }
  candidates.push(cleaned);
  if (!cleaned.startsWith('+') && digits.length >= 12) candidates.push(`+${digits}`);

  for (const c of candidates) {
    const e164 = attempt(c);
    if (e164) return { ok: true, e164 };
  }
  return { ok: false, reason: 'INVALID' };
}
