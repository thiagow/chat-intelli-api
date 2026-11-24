import { ChannelType } from '@prisma/client';
import {
  phoneMatchKey,
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

  it('phoneMatchKey casa celular BR com e sem o nono dígito', () => {
    const com9 = phoneMatchKey('5562991785173@s.whatsapp.net');
    const sem9 = phoneMatchKey('556291785173@s.whatsapp.net');
    expect(com9).toBe(sem9);
    expect(com9).toBe('556291785173');
  });

  it('phoneMatchKey não altera fixo, estrangeiro nem número já sem 9', () => {
    expect(phoneMatchKey('556233221100')).toBe('556233221100');
    expect(phoneMatchKey('14155550123')).toBe('14155550123');
    expect(phoneMatchKey('5511999990000')).toBe('551199990000');
    expect(phoneMatchKey('5511899990000')).toBe('5511899990000');
  });

  it('stripWhatsappJid remove o sufixo', () => {
    expect(stripWhatsappJid('5562999990000@s.whatsapp.net')).toBe('5562999990000');
    expect(stripWhatsappJid('5562999990000')).toBe('5562999990000');
  });
});
