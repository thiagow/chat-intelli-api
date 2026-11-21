import {
  mapFolderMessageStatus,
  parseSenderEvent,
  UazapiBulkSenderAdapter,
} from './uazapi.bulk-sender.adapter';

describe('UazapiBulkSenderAdapter', () => {
  const http: any = {
    checkNumbers: jest.fn(),
    senderAdvanced: jest.fn(),
    senderEdit: jest.fn(),
    senderListFolders: jest.fn(),
    senderListMessages: jest.fn(),
    configureWebhook: jest.fn(),
    getInstanceStatus: jest.fn(),
  };
  const adapter = new UazapiBulkSenderAdapter(http);
  const channel: any = { id: 'ch1' };
  beforeEach(() => jest.clearAllMocks());

  it('checkNumbers normaliza a resposta', async () => {
    http.checkNumbers.mockResolvedValue([
      { query: '5511999998888', jid: '5511999998888@s.whatsapp.net', isInWhatsapp: true },
      { query: '5511000000000', jid: '', isInWhatsapp: false },
    ]);
    const r = await adapter.checkNumbers(channel, ['5511999998888', '5511000000000']);
    expect(r).toEqual([
      { query: '5511999998888', jid: '5511999998888@s.whatsapp.net', isInWhatsapp: true },
      { query: '5511000000000', jid: null, isInWhatsapp: false },
    ]);
  });

  it('createFolder envia delay em segundos, info e scheduled_for; exige folder_id', async () => {
    http.senderAdvanced.mockResolvedValue({ folder_id: 'F1', count: 2, status: 'queued' });
    const f = await adapter.createFolder(channel, {
      messages: [{ number: '5511999998888', text: 'oi' }],
      delayMinSec: 30,
      delayMaxSec: 90,
      info: 'ic:c:0',
      scheduledFor: 1_800_000_000_000,
    });
    expect(f.folderId).toBe('F1');
    expect(http.senderAdvanced).toHaveBeenCalledWith(channel, {
      messages: [{ number: '5511999998888', type: 'text', text: 'oi' }],
      delayMin: 30,
      delayMax: 90,
      info: 'ic:c:0',
      scheduled_for: 1_800_000_000_000,
    });
    http.senderAdvanced.mockResolvedValue({});
    await expect(
      adapter.createFolder(channel, { messages: [], delayMinSec: 1, delayMaxSec: 2, info: 'x' }),
    ).rejects.toThrow(/folder_id/);
  });

  it('listFolders e listFolderMessages mapeiam contadores/status e paginação', async () => {
    http.senderListFolders.mockResolvedValue([{ id: 'F1', info: 'ic:c:0', status: 'done', log_sucess: 3, log_failed: 1 }]);
    expect(await adapter.listFolders(channel)).toEqual([
      expect.objectContaining({ folderId: 'F1', info: 'ic:c:0', status: 'done', sent: 3, failed: 1 }),
    ]);

    http.senderListMessages.mockResolvedValue({
      messages: [
        { chatid: '5511@s.whatsapp.net', messageid: 'M1', status: 'Sent' },
        { chatid: '5522@s.whatsapp.net', status: 'failed', error: 'not on whatsapp' },
      ],
    });
    const res = await adapter.listFolderMessages(channel, 'F1', { limit: 2 });
    expect(res.hasMore).toBe(true);
    expect(res.messages[0]).toMatchObject({ status: 'SENT', providerMessageId: 'M1' });
    expect(res.messages[1]).toMatchObject({ status: 'FAILED', error: 'not on whatsapp' });
  });

  it('controlFolder traduz para /sender/edit', async () => {
    await adapter.controlFolder(channel, 'F1', 'stop');
    expect(http.senderEdit).toHaveBeenCalledWith(channel, { folder_id: 'F1', action: 'stop' });
  });

  it('isConnected: false só quando o provider confirma que caiu; indeterminado = true', async () => {
    http.getInstanceStatus.mockResolvedValue({ status: 'connected' });
    expect(await adapter.isConnected(channel)).toBe(true);
    http.getInstanceStatus.mockResolvedValue({ status: 'disconnected' });
    expect(await adapter.isConnected(channel)).toBe(false);
    http.getInstanceStatus.mockResolvedValue({});
    expect(await adapter.isConnected(channel)).toBe(true);
  });

  it('ensureWebhook assina os eventos de envio em massa', async () => {
    await adapter.ensureWebhook(channel, 'https://x/y');
    expect(http.configureWebhook).toHaveBeenCalledWith(channel, 'https://x/y', ['messages', 'messages_update', 'sender']);
  });
});

describe('helpers do sender', () => {
  it('parseSenderEvent lê folderID/status/contadores', () => {
    expect(parseSenderEvent({ EventType: 'sender', folderID: 'F9', status: 'done', successCount: 5, failedCount: 1 })).toMatchObject({
      folderId: 'F9',
      status: 'done',
      successCount: 5,
      failedCount: 1,
    });
    expect(parseSenderEvent({ EventType: 'sender', folderID: 'F9', status: 'sending' })?.status).toBe('sending');
    expect(parseSenderEvent({ EventType: 'sender' })).toBeNull();
  });

  it('mapFolderMessageStatus', () => {
    expect(mapFolderMessageStatus('Sent')).toBe('SENT');
    expect(mapFolderMessageStatus('error')).toBe('FAILED');
    expect(mapFolderMessageStatus('scheduled')).toBe('PENDING');
    expect(mapFolderMessageStatus('???')).toBe('UNKNOWN');
  });
});
