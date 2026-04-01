import prisma from './prisma';
import { DEFAULT_TEMPLATES } from './whatsapp-default-templates';

export interface HsmSyncResult {
  synced: number;
  created: number;
  updated: number;
  gupshupTemplates: Record<string, { status: string; id: string | null }>;
}

export async function syncBranchHsmTemplates(branchId: string): Promise<HsmSyncResult> {
  const whatsappConfig = await prisma.whatsAppConfig.findUnique({ where: { branchId } });

  const gupshupAppId = whatsappConfig?.appId || process.env.GUPSHUP_APP_ID || '';
  const apiKey = whatsappConfig?.accountSid || process.env.GUPSHUP_API_KEY || '';

  if (!gupshupAppId || !apiKey) {
    throw new Error('App ID do Gupshup não configurado. Preencha o campo App ID nas configurações.');
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
  const localTemplateTypes = new Set(localTemplates.map((tmpl: any) => tmpl.type));
  let created = 0;

  for (const defaultTemplate of DEFAULT_TEMPLATES) {
    const hsmTemplateName = String(defaultTemplate.hsmTemplateName || '').trim().toLowerCase();
    if (!hsmTemplateName) continue;
    if (localTemplateTypes.has(defaultTemplate.type as any)) continue;

    const gupshupTemplate = gupshupTemplates[hsmTemplateName];
    if (!gupshupTemplate) continue;

    await prisma.whatsAppMessageTemplate.create({
      data: {
        branchId,
        type: defaultTemplate.type as any,
        name: defaultTemplate.name,
        message: defaultTemplate.message,
        hsmTemplateName: defaultTemplate.hsmTemplateName,
        hsmTemplateId: gupshupTemplate.id,
        hsmTemplateStatus: gupshupTemplate.status || null,
        hsmTemplateApproved: gupshupTemplate.status === 'APPROVED',
        importedFromGupshupSync: true,
        isActive: true,
      },
    });

    localTemplateTypes.add(defaultTemplate.type as any);
    created++;
  }

  const refreshedLocalTemplates = await prisma.whatsAppMessageTemplate.findMany({ where: { branchId } });
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
    if (!(config.appId || process.env.GUPSHUP_APP_ID) || !(config.accountSid || process.env.GUPSHUP_API_KEY)) {
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
