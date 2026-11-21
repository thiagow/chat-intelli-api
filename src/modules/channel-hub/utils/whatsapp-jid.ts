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
