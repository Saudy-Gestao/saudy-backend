import prisma from './prisma';

export interface HsmSyncResult {
  synced: number;
  created: number;
  updated: number;
  metaTemplates: Record<string, { status: string; id: string | null }>;
}

const normalizeTemplateBaseName = (value: string) => {
  const normalized = String(value || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_');

  return normalized || 'template_whatsapp';
};

const extractTemplateBaseName = (value: string) => {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return '';

  const noHyphenUuid = normalized.match(/^(.*)_[0-9a-f]{32}$/);
  if (noHyphenUuid) return noHyphenUuid[1];

  const hyphenUuid = normalized.match(/^(.*)_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  if (hyphenUuid) return hyphenUuid[1];

  if (normalized.endsWith('_uuid')) {
    return normalized.slice(0, -5);
  }

  return normalized;
};

async function getWabaId(phoneNumberId: string, bearerToken: string): Promise<string> {
  if (process.env.WHATSAPP_WABA_ID) return process.env.WHATSAPP_WABA_ID;

  const res = await fetch(
    `https://graph.facebook.com/v21.0/${phoneNumberId}?fields=whatsapp_business_account`,
    { headers: { Authorization: `Bearer ${bearerToken}` } },
  );
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Erro ao buscar WABA ID: ${body}`);
  }
  const data = await res.json() as { whatsapp_business_account?: { id: string } };
  const wabaId = data.whatsapp_business_account?.id;
  if (!wabaId) throw new Error('WABA ID não encontrado. Configure a env var WHATSAPP_WABA_ID.');
  return wabaId;
}

async function fetchMetaTemplates(
  wabaId: string,
  bearerToken: string,
): Promise<Array<{ name: string; status: string; id: string }>> {
  const templates: Array<{ name: string; status: string; id: string }> = [];
  let url: string | null =
    `https://graph.facebook.com/v21.0/${wabaId}/message_templates?limit=100&fields=name,status,id`;

  while (url) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${bearerToken}` } });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Erro ao listar templates da Meta: ${body}`);
    }
    const data = await res.json() as { data: any[]; paging?: { next?: string } };
    for (const t of (data.data || [])) {
      if (t.name && t.status && t.id) {
        templates.push({ name: String(t.name), status: String(t.status), id: String(t.id) });
      }
    }
    url = data.paging?.next || null;
  }

  return templates;
}

export async function syncBranchHsmTemplates(branchId: string): Promise<HsmSyncResult> {
  const whatsappConfig = await prisma.whatsAppConfig.findUnique({ where: { branchId } });

  const phoneNumberId = whatsappConfig?.appId || '';
  const bearerToken = whatsappConfig?.accountSid || '';

  if (!phoneNumberId || !bearerToken) {
    throw new Error('Credenciais do WhatsApp não configuradas na filial. Salve Token e Phone Number ID antes de sincronizar.');
  }

  const wabaId = await getWabaId(phoneNumberId, bearerToken);
  const rawTemplates = await fetchMetaTemplates(wabaId, bearerToken);

  const metaTemplates: Record<string, { status: string; id: string | null }> = {};
  const metaTemplatesByBaseName: Record<string, Array<{ name: string; status: string; id: string | null }>> = {};

  for (const t of rawTemplates) {
    const normalizedName = t.name.toLowerCase();
    const templateInfo = { status: t.status, id: t.id };
    metaTemplates[normalizedName] = templateInfo;

    const baseName = extractTemplateBaseName(normalizedName);
    if (!metaTemplatesByBaseName[baseName]) metaTemplatesByBaseName[baseName] = [];
    metaTemplatesByBaseName[baseName].push({ name: normalizedName, ...templateInfo });
  }

  const localTemplates = await prisma.whatsAppMessageTemplate.findMany({ where: { branchId } });
  let created = 0;
  let updated = 0;

  for (const tmpl of localTemplates) {
    const localTemplateName = String(tmpl.hsmTemplateName || '').trim().toLowerCase();
    const localTemplateBaseName = normalizeTemplateBaseName(tmpl.name || '');

    const metaTemplate =
      (tmpl.hsmTemplateId
        ? Object.values(metaTemplates).find((item) => item.id && item.id === tmpl.hsmTemplateId)
        : undefined)
      || (localTemplateName ? metaTemplates[localTemplateName] : undefined)
      || metaTemplatesByBaseName[localTemplateBaseName]?.[0];

    const matchedRemoteName =
      (localTemplateName && metaTemplates[localTemplateName] ? localTemplateName : null)
      || metaTemplatesByBaseName[localTemplateBaseName]?.[0]?.name
      || null;

    const metaStatus = metaTemplate?.status || null;
    const approved = metaStatus === 'APPROVED';
    const hsmTemplateId = metaTemplate?.id || null;

    const shouldUpdate =
      tmpl.hsmTemplateApproved !== approved
      || (tmpl.hsmTemplateStatus || null) !== metaStatus
      || (tmpl.hsmTemplateId || null) !== hsmTemplateId
      || ((tmpl.hsmTemplateName || null) !== (matchedRemoteName || null) && !!matchedRemoteName);

    if (shouldUpdate) {
      await prisma.whatsAppMessageTemplate.update({
        where: { id: tmpl.id },
        data: {
          hsmTemplateApproved: approved,
          hsmTemplateStatus: metaStatus,
          hsmTemplateId,
          hsmTemplateName: matchedRemoteName || tmpl.hsmTemplateName,
        },
      });
      updated++;
    }
  }

  return {
    synced: localTemplates.filter((tmpl: any) => tmpl.hsmTemplateName).length,
    created,
    updated,
    metaTemplates,
  };
}

export async function syncAllBranchesHsmTemplates(): Promise<{ branches: number; synced: number; created: number; updated: number }> {
  const configs = await prisma.whatsAppConfig.findMany({
    where: { isActive: true },
    select: { branchId: true, appId: true, accountSid: true },
  });

  let branches = 0;
  let synced = 0;
  let created = 0;
  let updated = 0;

  for (const config of configs) {
    if (!config.branchId) continue;
    if (!config.appId || !config.accountSid) continue;

    try {
      const result = await syncBranchHsmTemplates(config.branchId);
      branches++;
      synced += result.synced;
      created += result.created;
      updated += result.updated;
    } catch (error) {
      console.error('[whatsapp-hsm-sync] failed for branch', config.branchId, error);
    }
  }

  return { branches, synced, created, updated };
}
