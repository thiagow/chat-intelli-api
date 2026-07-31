import { Injectable, Logger } from '@nestjs/common';
import { Channel } from '@prisma/client';
import axios, { AxiosInstance } from 'axios';

/**
 * Uazapi is a hosted, multi-tenant service — unlike Zappfy (single fixed
 * base URL), each customer/instance may live on a different subdomain
 * (e.g. `https://free.uazapi.com`, or a dedicated region). We fall back to
 * the public free/demo host only if the channel didn't configure one.
 */
const DEFAULT_BASE_URL = 'https://free.uazapi.com';

@Injectable()
export class UazapiHttpClient {
  private readonly logger = new Logger(UazapiHttpClient.name);

  private baseUrl(channel: Channel): string {
    const config = channel.config as Record<string, any>;
    return (config.baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '');
  }

  /** Instance-scoped calls (send message, chats, groups, contacts...) auth with `token`. */
  private createClient(channel: Channel): AxiosInstance {
    const config = channel.config as Record<string, any>;
    return axios.create({
      baseURL: this.baseUrl(channel),
      headers: { token: config.token },
      timeout: 30000,
    });
  }

  /** Admin-scoped calls (create/list instances, global webhook) auth with `admintoken`. */
  private createAdminClient(channel: Channel): AxiosInstance {
    const config = channel.config as Record<string, any>;
    return axios.create({
      baseURL: this.baseUrl(channel),
      headers: { admintoken: config.adminToken },
      timeout: 30000,
    });
  }

  async sendRequest(
    channel: Channel,
    endpoint: string,
    payload: Record<string, any>,
  ): Promise<any> {
    const client = this.createClient(channel);
    try {
      const response = await client.post(endpoint, payload);
      return response.data;
    } catch (error: any) {
      this.logger.error(
        `Uazapi API error: ${endpoint} - ${error.response?.data?.message || error.message}`,
      );
      throw error;
    }
  }

  async getInstanceStatus(channel: Channel): Promise<any> {
    const client = this.createClient(channel);
    try {
      const response = await client.get('/instance/status');
      return response.data;
    } catch (error: any) {
      this.logger.error(`Uazapi status check failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Onboarding flow: create a fresh instance (admin-scoped) then connect it
   * (instance-scoped, returns QR/pairing code). The UI polls `getInstanceStatus`
   * until `connected`. Not wired into the settings screen yet — the initial
   * MVP asks for an already-connected instance's `token`, same UX as Zappfy.
   */
  async createInstance(channel: Channel, name: string): Promise<{ token: string }> {
    const client = this.createAdminClient(channel);
    const response = await client.post('/instance/create', { name });
    return { token: response.data?.token };
  }

  /**
   * Sem `phone`: gera QR code. Com `phone`: gera código de pareamento.
   * Proxy regional (Brasil) reduz risco de ban por "conexão suspeita" —
   * cidades disponíveis via `GET /proxy-managed/cities?country=br`.
   */
  async connectInstance(
    channel: Channel,
    options: {
      phone?: string;
      browser?: 'auto' | 'safari' | 'firefox' | 'edge' | 'chrome';
      systemName?: string;
      proxyCountry?: string;
      proxyState?: string;
      proxyCity?: string;
    } = {},
  ): Promise<{ qrcode?: string; pairingCode?: string }> {
    const client = this.createClient(channel);
    const response = await client.post('/instance/connect', {
      ...(options.phone && { phone: options.phone }),
      ...(options.browser && { browser: options.browser }),
      ...(options.systemName && { systemName: options.systemName }),
      ...(options.proxyCountry && { proxy_managed_country: options.proxyCountry }),
      ...(options.proxyState && { proxy_managed_state: options.proxyState }),
      ...(options.proxyCity && { proxy_managed_city: options.proxyCity }),
    });
    return {
      qrcode: response.data?.qrcode || response.data?.qrCode,
      pairingCode: response.data?.pairingCode || response.data?.paircode,
    };
  }

  /** Encerra a sessão — precisa de novo QR/pareamento na próxima conexão. */
  async disconnectInstance(channel: Channel): Promise<void> {
    const client = this.createClient(channel);
    await client.post('/instance/disconnect');
  }

  /** Remove a instância permanentemente do lado da Uazapi. */
  async deleteInstance(channel: Channel): Promise<void> {
    const client = this.createClient(channel);
    await client.delete('/instance');
  }

  async fetchChats(
    channel: Channel,
    options: { limit?: number; offset?: number; isGroup?: boolean } = {},
  ): Promise<any> {
    return this.sendRequest(channel, '/chat/find', {
      sort: '-wa_lastMsgTimestamp',
      limit: options.limit ?? 50,
      offset: options.offset ?? 0,
      ...(options.isGroup !== undefined && { wa_isGroup: options.isGroup }),
    });
  }

  async fetchMessages(
    channel: Channel,
    chatId: string,
    limit = 50,
    offset = 0,
  ): Promise<any> {
    return this.sendRequest(channel, '/message/find', {
      chatid: chatId,
      limit,
      offset,
    });
  }

  /**
   * Foto de perfil de um contato ou grupo, com o nome de exibição de brinde.
   * Manda `preview: false` pra forçar revalidação — sem isso a Uazapi pode
   * devolver uma URL de cache vencida (CDN responde 403).
   */
  async fetchProfilePicture(
    channel: Channel,
    numberOrJid: string,
  ): Promise<{ url: string | null; name: string | null }> {
    const chat = await this.sendRequest(channel, '/chat/details', {
      number: numberOrJid,
      preview: false,
    });
    return {
      url: chat?.image || chat?.imagePreview || null,
      name: chat?.wa_contactName || chat?.wa_name || chat?.name || null,
    };
  }

  async fetchGroupParticipants(
    channel: Channel,
    groupJid: string,
  ): Promise<Array<{ phone: string; lid?: string; isAdmin: boolean }>> {
    const info = await this.sendRequest(channel, '/group/info', {
      groupjid: groupJid,
    });
    const participants = info?.Participants ?? info?.participants ?? [];
    return participants
      .map((p: any) => ({
        phone: String(p?.PhoneNumber ?? '').replace(/@.*$/, ''),
        lid: p?.LID ?? p?.JID ?? undefined,
        isAdmin: !!(p?.IsAdmin || p?.IsSuperAdmin),
      }))
      .filter((p: { phone: string }) => !!p.phone);
  }

  /**
   * "Modo simples" (sem `action`) — a Uazapi gerencia um único webhook por
   * instância automaticamente, criando ou atualizando conforme necessário.
   *
   * `excludeMessages: ['wasSentByApi']` NÃO é usado por padrão aqui: nosso
   * pipeline depende do webhook `messages` também para os echoes
   * (`fromMe: true`) — é como reconciliamos status/ID de mensagens enviadas
   * por nós mesmos (mesmo comportamento já em produção via Zappfy). Exposto
   * como opção pra quem quiser habilitar mais pra frente.
   */
  async configureWebhook(
    channel: Channel,
    url: string,
    events = ['messages', 'messages_update'],
    excludeMessages?: string[],
  ): Promise<any> {
    return this.sendRequest(channel, '/webhook', {
      enabled: true,
      url,
      events,
      ...(excludeMessages && { excludeMessages }),
    });
  }

  async getMediaBuffer(channel: Channel, mediaUrl: string): Promise<Buffer> {
    const response = await axios.get(mediaUrl, {
      responseType: 'arraybuffer',
      timeout: 60000,
    });
    return Buffer.from(response.data);
  }

  /**
   * Inbound media from WhatsApp is delivered as an encrypted .enc URL on
   * mmg.whatsapp.net that the browser cannot play. Uazapi exposes
   * /message/download which decrypts server-side and returns a playable URL.
   */
  async resolveInboundMediaUrl(
    channel: Channel,
    externalMessageId: string,
  ): Promise<{ fileUrl: string; mimeType?: string }> {
    const response = await this.sendRequest(channel, '/message/download', {
      id: externalMessageId,
    });
    const fileUrl: string | undefined = response?.fileURL || response?.fileUrl;
    if (!fileUrl) {
      throw new Error(
        `Uazapi /message/download returned no fileURL for ${externalMessageId}`,
      );
    }
    return { fileUrl, mimeType: response?.mimetype };
  }

  async deleteMessage(channel: Channel, externalMessageId: string): Promise<void> {
    await this.sendRequest(channel, '/message/delete', { id: externalMessageId });
  }
}
