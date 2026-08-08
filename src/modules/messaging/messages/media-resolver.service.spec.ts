import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ChannelType } from '@prisma/client';
import { MediaResolverService } from './media-resolver.service';
import { PrismaService } from '../../../database/prisma.service';
import { ChannelAdapterRegistry } from '../../channel-hub/channel-adapter.registry';

describe('MediaResolverService', () => {
  let service: MediaResolverService;
  let prisma: { message: { findUnique: jest.Mock; update: jest.Mock } };
  let adapterRegistry: { getOutbound: jest.Mock };
  let outboundAdapter: { resolveInboundMediaUrl: jest.Mock };

  const baseMessage = {
    id: 'msg-1',
    externalId: 'ext-1',
    content: {} as Record<string, any>,
    conversation: {
      organizationId: 'org-1',
      channelId: 'chan-1',
      channel: { id: 'chan-1', type: ChannelType.WHATSAPP_ZAPPFY },
    },
  };

  beforeEach(() => {
    prisma = {
      message: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    outboundAdapter = {
      resolveInboundMediaUrl: jest.fn(),
    };
    adapterRegistry = {
      getOutbound: jest.fn().mockReturnValue(outboundAdapter),
    };
    service = new MediaResolverService(
      prisma as unknown as PrismaService,
      adapterRegistry as unknown as ChannelAdapterRegistry,
    );
  });

  it('returns the cached mediaUrl as-is when it already looks playable', async () => {
    prisma.message.findUnique.mockResolvedValue({
      ...baseMessage,
      content: { mediaUrl: 'https://cdn.example.com/audio.ogg', mimeType: 'audio/ogg' },
    });

    const result = await service.resolve('msg-1', 'org-1');

    expect(result).toEqual({ url: 'https://cdn.example.com/audio.ogg', mimeType: 'audio/ogg' });
    expect(outboundAdapter.resolveInboundMediaUrl).not.toHaveBeenCalled();
  });

  it('re-resolves via the provider when the cached mediaUrl is an encrypted WhatsApp .enc link', async () => {
    prisma.message.findUnique.mockResolvedValue({
      ...baseMessage,
      content: {
        mediaUrl: 'https://mmg.whatsapp.net/v/t62.7118-24/abc.enc?ccb=1',
        mimeType: 'audio/ogg',
      },
    });
    outboundAdapter.resolveInboundMediaUrl.mockResolvedValue({
      fileUrl: 'https://playable.example.com/decrypted.ogg',
      mimeType: 'audio/ogg',
    });

    const result = await service.resolve('msg-1', 'org-1');

    expect(outboundAdapter.resolveInboundMediaUrl).toHaveBeenCalledWith(
      baseMessage.conversation.channel,
      expect.objectContaining({ externalMessageId: 'ext-1' }),
    );
    expect(result).toEqual({
      url: 'https://playable.example.com/decrypted.ogg',
      mimeType: 'audio/ogg',
    });
    expect(prisma.message.update).toHaveBeenCalledWith({
      where: { id: 'msg-1' },
      data: {
        content: expect.objectContaining({
          mediaUrl: 'https://playable.example.com/decrypted.ogg',
        }),
      },
    });
  });

  it('resolves via the provider when there is no cached mediaUrl at all', async () => {
    prisma.message.findUnique.mockResolvedValue({
      ...baseMessage,
      content: {},
    });
    outboundAdapter.resolveInboundMediaUrl.mockResolvedValue({
      fileUrl: 'https://playable.example.com/decrypted.ogg',
      mimeType: 'audio/ogg',
    });

    const result = await service.resolve('msg-1', 'org-1');

    expect(result.url).toBe('https://playable.example.com/decrypted.ogg');
  });

  it('throws NotFoundException when the message does not exist', async () => {
    prisma.message.findUnique.mockResolvedValue(null);

    await expect(service.resolve('missing', 'org-1')).rejects.toThrow(NotFoundException);
  });

  it('throws BadRequestException when the mediaUrl is unplayable and there is no externalId to resolve it', async () => {
    prisma.message.findUnique.mockResolvedValue({
      ...baseMessage,
      externalId: null,
      content: { mediaUrl: 'https://mmg.whatsapp.net/v/abc.enc' },
    });

    await expect(service.resolve('msg-1', 'org-1')).rejects.toThrow(BadRequestException);
  });
});
