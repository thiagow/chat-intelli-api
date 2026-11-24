import { ChannelType } from '@prisma/client';

const WA_USER_SUFFIX = '@s.whatsapp.net';

/**
 * Canais WhatsApp baseados em baileys/whatsmeow (Zappfy e UaZAPI) entregam o
 * inbound com o JID completo (`<phone>@s.whatsapp.net`) como external id do
 * contato. Os demais (WhatsApp Oficial/Meta etc.) usam só os dígitos.
 *
 * Toda criação de `ContactChannel.externalId` iniciada pelo nosso lado
 * (outbound, recovery, campanhas) PRECISA passar por aqui; se divergir do que
 * o inbound grava, o contato é duplicado quando a pessoa responde.
 */
export function usesJidExternalId(channelType: ChannelType | null | undefined): boolean {
  return (
    channelType === ChannelType.WHATSAPP_ZAPPFY ||
    channelType === ChannelType.WHATSAPP_UAZAPI
  );
}

export function toWhatsappExternalId(
  channelType: ChannelType | null | undefined,
  phone: string,
): string {
  if (!usesJidExternalId(channelType)) return phone;
  return phone.endsWith(WA_USER_SUFFIX) ? phone : `${phone}${WA_USER_SUFFIX}`;
}

export function stripWhatsappJid(externalId: string): string {
  return externalId.replace(/@s\.whatsapp\.net$|@g\.us$/, '');
}

/**
 * Chave de comparação de números/JIDs do WhatsApp. Celulares brasileiros existem nas duas
 * formas (com e sem o nono dígito) e o WhatsApp devolve a forma "real" da conta, que pode
 * diferir da digitada: 5562991785173 ↔ 556291785173. Remove o 9 de 55 + DDD + 9 + 8 dígitos
 * para que as duas formas casem. Só para COMPARAR; nunca para enviar nem gravar.
 */
export function phoneMatchKey(value: string): string {
  const d = stripWhatsappJid(value).replace(/\D/g, '');
  return d.length === 13 && d.startsWith('55') && d[4] === '9' ? d.slice(0, 4) + d.slice(5) : d;
}
