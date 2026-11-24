import { createHmac } from 'node:crypto';

jest.mock('../../common/net/safe-fetch', () => {
  const actual = jest.requireActual('../../common/net/safe-fetch');
  return { ...actual, safePost: jest.fn() };
});
import { safePost, UnsafeUrlError } from '../../common/net/safe-fetch';
import { PermanentWebhookError, ReplyWebhookService, signBody } from './reply-webhook.service';

const safePostMock = safePost as unknown as jest.Mock;

function build(over: Record<string, any> = {}) {
  const recipient = {
    id: 'r1',
    companyName: 'Acme',
    customData: { cidade: 'Goiânia' },
    renderedText: 'Oi Acme!',
    sentAt: new Date('2026-11-24T12:00:00Z'),
    conversationId: 'conv1',
    replyWebhookStatus: 'PENDING',
    replyWebhookAttempts: 0,
    campaign: {
      id: 'cmp1',
      name: 'Black',
      onReplyWebhookUrl: 'https://hooks.exemplo.com/x',
      onReplyWebhookSecret: 'whsec_test',
      channel: { id: 'ch1', name: 'Comercial' },
    },
    ...over,
  };
  const prisma: any = {
    campaignRecipient: { findUnique: jest.fn().mockResolvedValue(recipient), update: jest.fn().mockResolvedValue({}) },
  };
  return { svc: new ReplyWebhookService(prisma), prisma, recipient };
}

const job = { recipientId: 'r1', replyText: 'Tenho interesse', repliedAt: '2026-11-24T12:30:00.000Z' };

describe('ReplyWebhookService', () => {
  beforeEach(() => safePostMock.mockReset());

  it('assina com HMAC-SHA256 sobre "timestamp.corpo" (o receptor valida origem e replay)', () => {
    const sig = signBody('segredo', '1700000000', '{"a":1}');
    expect(sig).toBe('sha256=' + createHmac('sha256', 'segredo').update('1700000000.{"a":1}').digest('hex'));
  });

  it('entrega com payload do lead, cabeçalhos e idempotency-key; marca SENT', async () => {
    const { svc, prisma } = build();
    safePostMock.mockResolvedValue({ status: 200, bodyPreview: 'ok' });
    await svc.deliver(job);

    const [url, body, opts] = safePostMock.mock.calls[0];
    expect(url).toBe('https://hooks.exemplo.com/x');
    const payload = JSON.parse(body);
    expect(payload).toMatchObject({
      event: 'campaign.reply',
      campaign: { id: 'cmp1', name: 'Black' },
      channel: { name: 'Comercial' },
      lead: { companyName: 'Acme', customData: { cidade: 'Goiânia' } },
      sentMessageText: 'Oi Acme!',
      replyText: 'Tenho interesse',
      conversationId: 'conv1',
    });
    expect(JSON.stringify(payload)).not.toContain('whsec_test'); // o segredo nunca vai no corpo
    expect(opts.headers['idempotency-key']).toBe('r1');
    expect(opts.headers['x-intelli-event']).toBe('campaign.reply');
    expect(opts.headers['x-intelli-signature']).toBe(signBody('whsec_test', opts.headers['x-intelli-timestamp'], body));
    expect(prisma.campaignRecipient.update).toHaveBeenLastCalledWith({
      where: { id: 'r1' },
      data: expect.objectContaining({ replyWebhookStatus: 'SENT', replyWebhookError: null }),
    });
  });

  it('5xx/408/429 são erro transitório (relança para o retry) e gravam a tentativa', async () => {
    for (const status of [500, 502, 408, 429]) {
      const { svc, prisma } = build();
      safePostMock.mockResolvedValue({ status, bodyPreview: '' });
      await expect(svc.deliver(job)).rejects.toThrow(`HTTP ${status}`);
      await expect(svc.deliver(job)).rejects.not.toBeInstanceOf(PermanentWebhookError);
      expect(prisma.campaignRecipient.update).toHaveBeenCalledWith({
        where: { id: 'r1' },
        data: expect.objectContaining({ replyWebhookError: `HTTP ${status}` }),
      });
    }
  });

  it('4xx (ex.: 400/401/404) é falha definitiva: não adianta insistir', async () => {
    const { svc } = build();
    safePostMock.mockResolvedValue({ status: 404, bodyPreview: '' });
    await expect(svc.deliver(job)).rejects.toBeInstanceOf(PermanentWebhookError);
  });

  it('URL bloqueada (SSRF) na hora da entrega é falha definitiva e fica registrada', async () => {
    const { svc, prisma } = build();
    safePostMock.mockRejectedValue(new UnsafeUrlError('O host resolve para um endereço interno'));
    await expect(svc.deliver(job)).rejects.toBeInstanceOf(PermanentWebhookError);
    expect(prisma.campaignRecipient.update).toHaveBeenCalledWith({
      where: { id: 'r1' },
      data: expect.objectContaining({ replyWebhookError: expect.stringContaining('URL bloqueada') }),
    });
  });

  it('erro de rede/timeout relança (retry com backoff)', async () => {
    const { svc } = build();
    safePostMock.mockRejectedValue(new Error('timeout após 8000ms'));
    await expect(svc.deliver(job)).rejects.toThrow(/timeout/);
  });

  it('já entregue (SENT): retry é idempotente e não chama a URL de novo', async () => {
    const { svc } = build({ replyWebhookStatus: 'SENT' });
    await svc.deliver(job);
    expect(safePostMock).not.toHaveBeenCalled();
  });

  it('webhook removido da campanha ou destinatário inexistente: falha definitiva', async () => {
    const a = build();
    a.recipient.campaign.onReplyWebhookUrl = null as any;
    await expect(a.svc.deliver(job)).rejects.toBeInstanceOf(PermanentWebhookError);

    const b = build();
    b.prisma.campaignRecipient.findUnique.mockResolvedValue(null);
    await expect(b.svc.deliver(job)).rejects.toBeInstanceOf(PermanentWebhookError);
  });

  it('markFailed registra FAILED sem estourar se o update falhar', async () => {
    const { svc, prisma } = build();
    await svc.markFailed('r1', 'esgotou');
    expect(prisma.campaignRecipient.update).toHaveBeenCalledWith({
      where: { id: 'r1' },
      data: { replyWebhookStatus: 'FAILED', replyWebhookError: 'esgotou' },
    });
    prisma.campaignRecipient.update.mockRejectedValue(new Error('db'));
    await expect(svc.markFailed('r1', 'x')).resolves.toBeUndefined();
  });

  it('sendTest devolve ok/erro sem tocar em destinatários', async () => {
    const { svc, prisma } = build();
    const campaign = { id: 'cmp1', name: 'B', onReplyWebhookUrl: 'https://hooks.exemplo.com/x', onReplyWebhookSecret: 'whsec_test' };
    safePostMock.mockResolvedValue({ status: 204, bodyPreview: '' });
    expect(await svc.sendTest(campaign)).toEqual({ ok: true, status: 204 });
    safePostMock.mockRejectedValue(new UnsafeUrlError('Endereço interno não permitido'));
    const bad = await svc.sendTest(campaign);
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain('URL bloqueada');
    expect(prisma.campaignRecipient.update).not.toHaveBeenCalled();
  });
});
