/**
 * Backfill script: fetches Instagram usernames for contacts whose `name` is NULL
 * by calling `/me/conversations?user_id={igsid}&fields=participants` and
 * updating Contact.name + ContactChannel.profileName.
 *
 * Usage:
 *   cd chat-intelli-api
 *   npx ts-node -P tsconfig.json --transpile-only scripts/backfill-instagram-usernames.ts
 */
import { PrismaClient } from '@prisma/client';
import axios from 'axios';

const prisma = new PrismaClient();

type ChannelConfig = {
  accessToken?: string;
  pageAccessToken?: string;
  igBusinessId?: string;
  igUserId?: string;
  apiVersion?: string;
};

async function resolveParticipantUsername(
  cfg: ChannelConfig,
  businessId: string,
  igUserId: string,
): Promise<{ username?: string; name?: string } | null> {
  const token = cfg.accessToken || cfg.pageAccessToken;
  if (!token) return null;
  const apiVersion = cfg.apiVersion || 'v21.0';
  const url = `https://graph.instagram.com/${apiVersion}/me/conversations`;

  try {
    const { data } = await axios.get(url, {
      params: {
        user_id: igUserId,
        fields: 'participants',
        access_token: token,
      },
      timeout: 30000,
    });
    const participants: any[] = data?.data?.[0]?.participants?.data || [];
    const contact = participants.find(
      (p) => p?.id && String(p.id) !== String(businessId),
    );
    if (!contact) return null;
    return { username: contact.username, name: contact.name };
  } catch (err: any) {
    const meta = err?.response?.data?.error;
    const detail = meta
      ? `[${meta.code}] ${meta.message}`
      : err?.message || 'unknown';
    console.error(`  ✗ fetch failed for ${igUserId}: ${detail}`);
    return null;
  }
}

async function main() {
  const channels = await prisma.channel.findMany({
    where: { type: 'INSTAGRAM', deletedAt: null },
  });
  if (channels.length === 0) {
    console.log('No Instagram channels found.');
    return;
  }

  let totalFixed = 0;
  let totalSkipped = 0;
  let totalFailed = 0;

  for (const channel of channels) {
    const cfg = (channel.config as ChannelConfig) || {};
    const businessId = cfg.igBusinessId || cfg.igUserId;
    if (!businessId) {
      console.warn(`Channel ${channel.id} missing igBusinessId — skipping`);
      continue;
    }

    const contactChannels = await prisma.contactChannel.findMany({
      where: {
        channelId: channel.id,
        OR: [{ profileName: null }, { contact: { name: null } }],
      },
      include: { contact: true },
    });

    console.log(
      `\nChannel "${channel.name}" (${channel.id}): ${contactChannels.length} contacts to enrich`,
    );

    for (const cc of contactChannels) {
      const info = await resolveParticipantUsername(
        cfg,
        businessId,
        cc.externalId,
      );
      if (!info || (!info.username && !info.name)) {
        totalSkipped++;
        continue;
      }

      const displayName = info.username || info.name;

      const ccUpdates: Record<string, any> = {};
      if (displayName && displayName !== cc.profileName) {
        ccUpdates.profileName = displayName;
      }
      if (Object.keys(ccUpdates).length > 0) {
        await prisma.contactChannel.update({
          where: { id: cc.id },
          data: ccUpdates,
        });
      }

      const contactUpdates: Record<string, any> = {};
      if (displayName && !cc.contact.name) {
        contactUpdates.name = displayName;
      }
      if (Object.keys(contactUpdates).length > 0) {
        await prisma.contact.update({
          where: { id: cc.contactId },
          data: contactUpdates,
        });
      }

      console.log(`  ✓ ${cc.externalId} → @${displayName}`);
      totalFixed++;

      await new Promise((r) => setTimeout(r, 150));
    }
  }

  console.log(
    `\nDone. fixed=${totalFixed} skipped=${totalSkipped} failed=${totalFailed}`,
  );
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
