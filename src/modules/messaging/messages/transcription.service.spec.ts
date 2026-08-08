import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChannelType } from '@prisma/client';
import axios from 'axios';
import { TranscriptionService } from './transcription.service';
import { PrismaService } from '../../../database/prisma.service';
import { ChannelAdapterRegistry } from '../../channel-hub/channel-adapter.registry';
import { MediaResolverService } from './media-resolver.service';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('TranscriptionService', () => {
  let service: TranscriptionService;
  let prisma: { message: { findUnique: jest.Mock; update: jest.Mock } };
  let config: { get: jest.Mock };
  let adapterRegistry: { getOutbound: jest.Mock };
  let outboundAdapter: { downloadMedia: jest.Mock };
  let mediaResolver: { resolve: jest.Mock };

  const baseMessage = {
    id: 'msg-1',
    type: 'AUDIO',
    metadata: {},
    conversation: {
      organizationId: 'org-1',
      channelId: 'chan-1',
      channel: { id: 'chan-1', type: ChannelType.WHATSAPP_ZAPPFY },
    },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    prisma = {
      message: { findUnique: jest.fn(), update: jest.fn() },
    };
    config = { get: jest.fn().mockReturnValue('sk-test-key') };
    outboundAdapter = { downloadMedia: jest.fn() };
    adapterRegistry = { getOutbound: jest.fn().mockReturnValue(outboundAdapter) };
    mediaResolver = { resolve: jest.fn() };

    service = new TranscriptionService(
      prisma as unknown as PrismaService,
      config as unknown as ConfigService,
      adapterRegistry as unknown as ChannelAdapterRegistry,
      mediaResolver as unknown as MediaResolverService,
    );

    mockedAxios.post.mockResolvedValue({
      data: { text: 'ola tudo bem', language: 'pt', duration: 3 },
    });
  });

  it('goes through the media resolver instead of fetching a cached WhatsApp .enc URL directly', async () => {
    prisma.message.findUnique.mockResolvedValue({
      ...baseMessage,
      content: {
        mediaUrl: 'https://mmg.whatsapp.net/v/t62.7118-24/abc.enc?ccb=1',
        mimeType: 'audio/ogg',
      },
    });
    mediaResolver.resolve.mockResolvedValue({
      url: 'https://playable.example.com/decrypted.ogg',
      mimeType: 'audio/ogg',
    });
    outboundAdapter.downloadMedia.mockResolvedValue(Buffer.from('audio-bytes'));

    await service.transcribe('msg-1', 'org-1');

    expect(mediaResolver.resolve).toHaveBeenCalledWith('msg-1', 'org-1');
    expect(outboundAdapter.downloadMedia).toHaveBeenCalledWith(
      baseMessage.conversation.channel,
      'https://playable.example.com/decrypted.ogg',
    );
  });

  it('downloads directly when the cached mediaUrl already looks playable', async () => {
    prisma.message.findUnique.mockResolvedValue({
      ...baseMessage,
      content: { mediaUrl: 'https://cdn.example.com/audio.ogg', mimeType: 'audio/ogg' },
    });
    outboundAdapter.downloadMedia.mockResolvedValue(Buffer.from('audio-bytes'));

    await service.transcribe('msg-1', 'org-1');

    expect(mediaResolver.resolve).not.toHaveBeenCalled();
    expect(outboundAdapter.downloadMedia).toHaveBeenCalledWith(
      baseMessage.conversation.channel,
      'https://cdn.example.com/audio.ogg',
    );
  });

  it('throws when the message is not an audio message', async () => {
    prisma.message.findUnique.mockResolvedValue({ ...baseMessage, type: 'TEXT', content: {} });

    await expect(service.transcribe('msg-1', 'org-1')).rejects.toThrow(BadRequestException);
  });
});
