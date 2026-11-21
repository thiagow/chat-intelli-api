import { ChannelType } from '@prisma/client';
import {
  stripWhatsappJid,
  toWhatsappExternalId,
  usesJidExternalId,
} from './whatsapp-jid';

describe('whatsapp-jid', () => {
  it('usa JID para Zappfy e UaZAPI', () => {
    expect(toWhatsappExternalId(ChannelType.WHATSAPP_UAZAPI, '5562999990000')).toBe(
      '5562999990000@s.whatsapp.net',
    );
    expect(toWhatsappExternalId(ChannelType.WHATSAPP_ZAPPFY, '5562999990000')).toBe(
      '5562999990000@s.whatsapp.net',
    );
  });

  it('mantém só dígitos para WhatsApp Oficial e demais canais', () => {
    expect(toWhatsappExternalId(ChannelType.WHATSAPP_OFFICIAL, '5562999990000')).toBe(
      '5562999990000',
    );
    expect(toWhatsappExternalId(null, '5562999990000')).toBe('5562999990000');
  });

  it('é idempotente quando já recebe um JID', () => {
    expect(
      toWhatsappExternalId(ChannelType.WHATSAPP_UAZAPI, '5562999990000@s.whatsapp.net'),
    ).toBe('5562999990000@s.whatsapp.net');
  });

  it('usesJidExternalId distingue os canais', () => {
    expect(usesJidExternalId(ChannelType.WHATSAPP_UAZAPI)).toBe(true);
    expect(usesJidExternalId(ChannelType.WHATSAPP_OFFICIAL)).toBe(false);
    expect(usesJidExternalId(undefined)).toBe(false);
  });

  it('stripWhatsappJid remove o sufixo', () => {
    expect(stripWhatsappJid('5562999990000@s.whatsapp.net')).toBe('5562999990000');
    expect(stripWhatsappJid('5562999990000')).toBe('5562999990000');
  });
});
