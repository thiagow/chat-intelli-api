import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ChannelType } from '@prisma/client';
import { InboundChannelPort } from './ports/inbound-channel.port';
import { OutboundChannelPort } from './ports/outbound-channel.port';
import { HistorySyncPort } from './ports/history-sync.port';
import { BulkSenderPort } from './ports/bulk-sender.port';

@Injectable()
export class ChannelAdapterRegistry {
  private readonly logger = new Logger(ChannelAdapterRegistry.name);
  private inboundAdapters = new Map<ChannelType, InboundChannelPort>();
  private outboundAdapters = new Map<ChannelType, OutboundChannelPort>();
  private historySyncAdapters = new Map<ChannelType, HistorySyncPort>();
  private bulkSenderAdapters = new Map<ChannelType, BulkSenderPort>();

  register(
    inbound: InboundChannelPort,
    outbound: OutboundChannelPort,
  ): void {
    const type = inbound.channelType;
    this.inboundAdapters.set(type, inbound);
    this.outboundAdapters.set(type, outbound);
    this.logger.log(`Adapter registered: ${type}`);
  }

  registerHistorySync(adapter: HistorySyncPort): void {
    this.historySyncAdapters.set(adapter.channelType, adapter);
    this.logger.log(`HistorySync adapter registered: ${adapter.channelType}`);
  }

  registerBulkSender(adapter: BulkSenderPort): void {
    this.bulkSenderAdapters.set(adapter.channelType, adapter);
    this.logger.log(`BulkSender adapter registered: ${adapter.channelType}`);
  }

  getBulkSender(type: ChannelType): BulkSenderPort | null {
    return this.bulkSenderAdapters.get(type) ?? null;
  }

  hasBulkSender(type: ChannelType): boolean {
    return this.bulkSenderAdapters.has(type);
  }

  getInbound(type: ChannelType): InboundChannelPort {
    const adapter = this.inboundAdapters.get(type);
    if (!adapter) {
      throw new NotFoundException(`No inbound adapter for channel type: ${type}`);
    }
    return adapter;
  }

  getOutbound(type: ChannelType): OutboundChannelPort {
    const adapter = this.outboundAdapters.get(type);
    if (!adapter) {
      throw new NotFoundException(`No outbound adapter for channel type: ${type}`);
    }
    return adapter;
  }

  getHistorySync(type: ChannelType): HistorySyncPort | null {
    return this.historySyncAdapters.get(type) ?? null;
  }

  hasHistorySync(type: ChannelType): boolean {
    return this.historySyncAdapters.has(type);
  }

  hasAdapter(type: ChannelType): boolean {
    return this.inboundAdapters.has(type);
  }

  getSupportedTypes(): ChannelType[] {
    return Array.from(this.inboundAdapters.keys());
  }
}
