import prisma from './prisma';

export interface HsmSyncResult {
  synced: number;
  created: number;
  updated: number;
  gupshupTemplates: Record<string, { status: string; id: string | null }>;
}

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
    throw new Error(`Erro ao consultar Gupshup: ${body}`);
  }

  const gupshupData = await gupshupRes.json() as { status: string; templates: any[] };
  const gupshupTemplates: Record<string, { status: string; id: string | null }> = {};

  for (const t of (gupshupData.templates || [])) {
    if (!t.elementName) continue;
    const templateId =
      t.id
      ?? t.templateId
      ?? t.templateID
      ?? t.elementId
      ?? null;

    gupshupTemplates[String(t.elementName).toLowerCase()] = {
      status: String(t.status || ''),
      id: templateId ? String(templateId) : null,
    };
  }

  const localTemplates = await prisma.whatsAppMessageTemplate.findMany({ where: { branchId } });
  const refreshedLocalTemplates = localTemplates;
  let created = 0;
  let updated = 0;

  for (const tmpl of refreshedLocalTemplates) {
    if (!tmpl.hsmTemplateName) continue;
    const gupshupTemplate = gupshupTemplates[tmpl.hsmTemplateName.toLowerCase()];
    const gupshupStatus = gupshupTemplate?.status || null;
    const approved = gupshupStatus === 'APPROVED';
    const hsmTemplateId = gupshupTemplate?.id || null;
    const shouldUpdate =
      tmpl.hsmTemplateApproved !== approved
      || (tmpl.hsmTemplateStatus || null) !== gupshupStatus
      || (tmpl.hsmTemplateId || null) !== hsmTemplateId;

    if (shouldUpdate) {
      await prisma.whatsAppMessageTemplate.update({
        where: { id: tmpl.id },
        data: {
          hsmTemplateApproved: approved,
          hsmTemplateStatus: gupshupStatus,
          hsmTemplateId,
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
