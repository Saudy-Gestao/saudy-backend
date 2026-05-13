import prisma from './prisma';

export interface HsmSyncResult {
  synced: number;
  created: number;
  updated: number;
  gupshupTemplates: Record<string, { status: string; id: string | null }>;
}

const normalizeTemplateBaseName = (value: string) => {
  const normalized = String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
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

export async function syncBranchHsmTemplates(branchId: string): Promise<HsmSyncResult> {
  const whatsappConfig = await prisma.whatsAppConfig.findUnique({ where: { branchId } });

  const gupshupAppId = whatsappConfig?.appId || '';
  const apiKey = whatsappConfig?.accountSid || '';

  if (!gupshupAppId || !apiKey) {
    throw new Error('Credenciais do WhatsApp não configuradas na filial. Salve API Key e App ID no banco antes de sincronizar.');
  }

  const gupshupRes = await fetch(
    `https://api.gupshup.io/wa/app/${gupshupAppId}/template`,
    { headers: { apikey: apiKey } },
  );

  if (!gupshupRes.ok) {
    const body = await gupshupRes.text();
    throw new Error(`Erro ao consultar Meta: ${body}`);
  }

  const gupshupData = await gupshupRes.json() as { status: string; templates: any[] };
  const gupshupTemplates: Record<string, { status: string; id: string | null }> = {};
  const gupshupTemplatesByBaseName: Record<string, Array<{ name: string; status: string; id: string | null }>> = {};

  for (const t of (gupshupData.templates || [])) {
    if (!t.elementName) continue;
    const elementName = String(t.elementName).trim();
    const templateId =
      t.id
      ?? t.templateId
      ?? t.templateID
      ?? t.elementId
      ?? null;

    const normalizedElementName = elementName.toLowerCase();
    const templateInfo = {
      status: String(t.status || ''),
      id: templateId ? String(templateId) : null,
    };
    gupshupTemplates[normalizedElementName] = templateInfo;

    const baseName = extractTemplateBaseName(normalizedElementName);
    if (!gupshupTemplatesByBaseName[baseName]) gupshupTemplatesByBaseName[baseName] = [];
    gupshupTemplatesByBaseName[baseName].push({
      name: normalizedElementName,
      ...templateInfo,
    });
  }

  const localTemplates = await prisma.whatsAppMessageTemplate.findMany({ where: { branchId } });
  const refreshedLocalTemplates = localTemplates;
  let created = 0;
  let updated = 0;

  for (const tmpl of refreshedLocalTemplates) {
    const localTemplateName = String(tmpl.hsmTemplateName || '').trim().toLowerCase();
    const localTemplateBaseName = normalizeTemplateBaseName(tmpl.name || '');
    const gupshupTemplate =
      (tmpl.hsmTemplateId
        ? Object.values(gupshupTemplates).find((item) => item.id && item.id === tmpl.hsmTemplateId)
        : undefined)
      || (localTemplateName ? gupshupTemplates[localTemplateName] : undefined)
      || gupshupTemplatesByBaseName[localTemplateBaseName]?.[0];

    const matchedRemoteName =
      (localTemplateName && gupshupTemplates[localTemplateName] ? localTemplateName : null)
      || gupshupTemplatesByBaseName[localTemplateBaseName]?.[0]?.name
      || null;

    const gupshupStatus = gupshupTemplate?.status || null;
    const approved = gupshupStatus === 'APPROVED';
    const hsmTemplateId = gupshupTemplate?.id || null;
    const shouldUpdate =
      tmpl.hsmTemplateApproved !== approved
      || (tmpl.hsmTemplateStatus || null) !== gupshupStatus
      || (tmpl.hsmTemplateId || null) !== hsmTemplateId
      || ((tmpl.hsmTemplateName || null) !== (matchedRemoteName || null) && !!matchedRemoteName);

    if (shouldUpdate) {
      await prisma.whatsAppMessageTemplate.update({
        where: { id: tmpl.id },
        data: {
          hsmTemplateApproved: approved,
          hsmTemplateStatus: gupshupStatus,
          hsmTemplateId,
          hsmTemplateName: matchedRemoteName || tmpl.hsmTemplateName,
        },
      });
      updated++;
    }
  }

  return {
    synced: refreshedLocalTemplates.filter((tmpl: any) => tmpl.hsmTemplateName).length,
    created,
    updated,
    gupshupTemplates,
  };
}

export async function syncAllBranchesHsmTemplates(): Promise<{ branches: number; synced: number; created: number; updated: number }> {
  const configs = await prisma.whatsAppConfig.findMany({
    where: {
      isActive: true,
    },
    select: {
      branchId: true,
      appId: true,
      accountSid: true,
    },
  });

  let branches = 0;
  let synced = 0;
  let created = 0;
  let updated = 0;

  for (const config of configs) {
    if (!config.branchId) continue;
    if (!config.appId || !config.accountSid) {
      continue;
    }

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
