/**
 * Backfill — contatos duplicados em canais WHATSAPP_UAZAPI.
 *
 * CONTEXTO
 *   O inbound UaZAPI grava `ContactChannel.externalId` como JID
 *   (`<phone>@s.whatsapp.net`), mas o outbound/recovery gravava só os dígitos
 *   (bug corrigido em channel-hub/utils/whatsapp-jid.ts). Quando o cliente
 *   respondia, nascia um segundo Contact para a mesma pessoa.
 *
 * O QUE FAZ (por ContactChannel UaZAPI com externalId só-dígitos)
 *   1. Sem gêmeo JID:            renomeia o externalId para o JID.
 *   2. Gêmeo JID, mesmo contato: remove a linha só-dígitos.
 *   3. Gêmeo JID, outro contato (mesma org): funde o contato duplicado no
 *      canônico (o do JID, que é o que o inbound usa): conversas, cards, tags
 *      e memórias de IA passam para o canônico; o duplicado é apagado se não
 *      sobrar nenhum canal nele. Contatos de orgs diferentes NUNCA são fundidos.
 *
 * USAGE
 *   npx ts-node prisma/scripts/merge-uazapi-duplicate-contacts.ts            # dry-run
 *   npx ts-node prisma/scripts/merge-uazapi-duplicate-contacts.ts --apply    # aplica
 *
 * Idempotente: rodar de novo depois do --apply não encontra mais nada.
 * Cada contato é tratado em sua própria transação.
 */
import { ChannelType, PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');
const JID_SUFFIX = '@s.whatsapp.net';

type Action = 'RENAME' | 'DROP_DUPLICATE_ROW' | 'MERGE' | 'SKIP_CROSS_ORG';
const counters: Record<Action, number> = {
  RENAME: 0,
  DROP_DUPLICATE_ROW: 0,
  MERGE: 0,
  SKIP_CROSS_ORG: 0,
};

async function main() {
  console.log(APPLY ? '== APPLY ==' : '== DRY-RUN (use --apply para gravar) ==');

  const rows = await prisma.contactChannel.findMany({
    where: {
      channel: { type: ChannelType.WHATSAPP_UAZAPI },
      NOT: { externalId: { contains: '@' } },
    },
    include: { contact: { select: { id: true, organizationId: true } } },
  });
  console.log(`ContactChannels UaZAPI sem JID: ${rows.length}`);

  for (const row of rows) {
    const jid = `${row.externalId}${JID_SUFFIX}`;
    const twin = await prisma.contactChannel.findUnique({
      where: {
        uq_contact_channel_external: { channelId: row.channelId, externalId: jid },
      },
      include: { contact: { select: { id: true, organizationId: true } } },
    });

    if (!twin) {
      counters.RENAME++;
      log('RENAME', `${row.externalId} -> ${jid} (contact ${row.contactId})`);
      if (APPLY) {
        await prisma.contactChannel.update({
          where: { id: row.id },
          data: { externalId: jid },
        });
      }
      continue;
    }

    if (twin.contactId === row.contactId) {
      counters.DROP_DUPLICATE_ROW++;
      log('DROP_DUPLICATE_ROW', `${row.externalId} (contact ${row.contactId})`);
      if (APPLY) await prisma.contactChannel.delete({ where: { id: row.id } });
      continue;
    }

    if (twin.contact.organizationId !== row.contact.organizationId) {
      counters.SKIP_CROSS_ORG++;
      log('SKIP_CROSS_ORG', `${row.externalId}: ${row.contactId} vs ${twin.contactId}`);
      continue;
    }

    counters.MERGE++;
    log('MERGE', `contact ${row.contactId} -> ${twin.contactId} (${row.externalId})`);
    if (APPLY) await mergeContact(row.contactId, twin.contactId, row.id);
  }

  console.log('\nResumo:', counters);
  if (!APPLY) console.log('Nada foi gravado. Rode com --apply para aplicar.');
}

async function mergeContact(dupId: string, canonicalId: string, dupChannelRowId: string) {
  await prisma.$transaction(async (tx) => {
    await tx.conversation.updateMany({
      where: { contactId: dupId },
      data: { contactId: canonicalId },
    });
    await tx.card.updateMany({
      where: { contactId: dupId },
      data: { contactId: canonicalId },
    });

    // ContactTag: PK composta (contactId, tagId). Copia o que falta e descarta o resto.
    const dupTags = await tx.contactTag.findMany({ where: { contactId: dupId } });
    if (dupTags.length) {
      await tx.contactTag.createMany({
        data: dupTags.map((t) => ({ ...t, contactId: canonicalId })),
        skipDuplicates: true,
      });
      await tx.contactTag.deleteMany({ where: { contactId: dupId } });
    }

    // AiAgentMemory: unique (agentId, contactId). Move só as sem conflito;
    // as que conflitam ficam no duplicado e caem junto no delete (cascade).
    const canonicalAgents = await tx.aiAgentMemory.findMany({
      where: { contactId: canonicalId },
      select: { agentId: true },
    });
    await tx.aiAgentMemory.updateMany({
      where: {
        contactId: dupId,
        agentId: { notIn: canonicalAgents.map((m) => m.agentId) },
      },
      data: { contactId: canonicalId },
    });

    await tx.contactChannel.delete({ where: { id: dupChannelRowId } });

    // Só apaga o contato duplicado se não restou nenhum canal nele
    // (ele pode ter vínculos em outros canais, que não são nossos de mexer).
    const remaining = await tx.contactChannel.count({ where: { contactId: dupId } });
    if (remaining === 0) await tx.contact.delete({ where: { id: dupId } });
  });
}

function log(action: Action, detail: string) {
  console.log(`[${action}] ${detail}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
