/**
 * Backfill: rebuilds content + type for Instagram messages stored as "[template]".
 * Reads metadata.rawPayload (the original Meta `messaging` event) and applies
 * the same logic as InstagramMessageMapper.extractTemplateContent.
 *
 * Usage:
 *   cd chat-intelli-api
 *   npx ts-node -P tsconfig.json --transpile-only scripts/backfill-instagram-templates.ts
 *   # add `--dry` to preview without writing
 */
import { MessageContentType, PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const DRY = process.argv.includes('--dry');

type Button = { type: string; title: string; url?: string; payload?: string };
type Element = {
  title?: string;
  subtitle?: string;
  imageUrl?: string;
  defaultActionUrl?: string;
  buttons?: Button[];
};

function mapButton(b: any): Button {
  return {
    type: String(b?.type ?? 'web_url'),
    title: String(b?.title ?? ''),
    url: b?.url ? String(b.url) : undefined,
    payload: b?.payload ? String(b.payload) : undefined,
  };
}

function buildContent(payload: any) {
  const wrapperKey = payload
    ? Object.keys(payload).find(
        (k) => payload[k] && typeof payload[k] === 'object' && !Array.isArray(payload[k]),
      )
    : undefined;
  const inner = wrapperKey ? payload[wrapperKey] : payload;
  const templateType = (payload?.template_type as string | undefined) || wrapperKey;

  const buttons: Button[] = Array.isArray(inner?.buttons)
    ? inner.buttons.map(mapButton)
    : Array.isArray(payload?.buttons)
      ? payload.buttons.map(mapButton)
      : [];

  const rawElements = Array.isArray(inner?.elements)
    ? inner.elements
    : Array.isArray(payload?.elements)
      ? payload.elements
      : [];
  const elements: Element[] = rawElements.map((el: any) => ({
    title: el?.title ? String(el.title) : undefined,
    subtitle: el?.subtitle ? String(el.subtitle) : undefined,
    imageUrl: el?.image_url ? String(el.image_url) : undefined,
    defaultActionUrl: el?.default_action?.url
      ? String(el.default_action.url)
      : undefined,
    buttons: Array.isArray(el?.buttons) ? el.buttons.map(mapButton) : undefined,
  }));

  const headerText =
    (inner?.text ? String(inner.text) : undefined) ||
    (payload?.text ? String(payload.text) : undefined);
  const elementText = elements
    .map((el) => [el.title, el.subtitle].filter(Boolean).join(' — '))
    .filter(Boolean)
    .join('\n');
  const text = headerText || elementText || undefined;

  return {
    text,
    template: {
      templateType,
      text: headerText,
      buttons: buttons.length ? buttons : undefined,
      elements: elements.length ? elements : undefined,
    },
  };
}

async function main() {
  const candidates = await prisma.message.findMany({
    where: {
      OR: [
        { content: { path: ['text'], equals: '[template]' } },
        { type: MessageContentType.TEMPLATE },
      ],
    },
    select: { id: true, content: true, type: true, metadata: true },
  });

  console.log(`Found ${candidates.length} candidate messages${DRY ? ' (dry)' : ''}.`);

  let fixed = 0;
  let skipped = 0;

  for (const msg of candidates) {
    const meta = (msg.metadata as any) || {};
    const raw = meta.rawPayload;
    const attachment = raw?.message?.attachments?.[0];

    if (!attachment || attachment.type !== 'template' || !attachment.payload) {
      skipped++;
      continue;
    }

    const newContent = buildContent(attachment.payload);
    const hasStructure =
      !!newContent.template.buttons?.length ||
      !!newContent.template.elements?.length ||
      !!newContent.text;

    if (!hasStructure) {
      skipped++;
      continue;
    }

    if (DRY) {
      console.log(`would update ${msg.id}: text="${newContent.text ?? ''}" buttons=${newContent.template.buttons?.length ?? 0} elements=${newContent.template.elements?.length ?? 0}`);
      fixed++;
      continue;
    }

    await prisma.message.update({
      where: { id: msg.id },
      data: {
        type: MessageContentType.TEMPLATE,
        content: newContent as any,
      },
    });
    fixed++;
    console.log(`✓ ${msg.id}`);
  }

  console.log(`\nDone. fixed=${fixed} skipped=${skipped}`);
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
