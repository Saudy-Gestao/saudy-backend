import prisma from './prisma';

export type ResolvedWhatsAppConfig = {
  sourceBranchId: string;
  isInherited: boolean;
  accountSid: string;
  authToken: string;
  fromNumber: string;
  appId: string | null;
};

type ResolveOptions = {
  requireActive?: boolean;
  requireCredentials?: boolean;
};

const hasCredentials = (config: {
  accountSid?: string | null;
  authToken?: string | null;
  fromNumber?: string | null;
} | null | undefined) => Boolean(
  String(config?.accountSid || '').trim()
  && String(config?.authToken || '').trim()
  && String(config?.fromNumber || '').trim(),
);

const supportsConfig = (
  config: {
    isActive?: boolean | null;
    accountSid?: string | null;
    authToken?: string | null;
    fromNumber?: string | null;
  } | null | undefined,
  options: ResolveOptions,
) => {
  if (!config) return false;
  if (options.requireActive !== false && !config.isActive) return false;
  if (options.requireCredentials !== false && !hasCredentials(config)) return false;
  return true;
};

const normalizeResolvedConfig = (
  config: {
    branchId: string;
    accountSid: string;
    authToken: string;
    fromNumber: string;
    appId: string | null;
  },
  isInherited: boolean,
): ResolvedWhatsAppConfig => ({
  sourceBranchId: config.branchId,
  isInherited,
  accountSid: String(config.accountSid || '').trim(),
  authToken: String(config.authToken || '').trim(),
  fromNumber: String(config.fromNumber || '').trim(),
  appId: config.appId || null,
});

export async function resolveWhatsAppConfigForBranch(
  branchId: string,
  options: ResolveOptions = {},
): Promise<ResolvedWhatsAppConfig | null> {
  const normalizedBranchId = String(branchId || '').trim();
  if (!normalizedBranchId) return null;

  const ownConfig = await prisma.whatsAppConfig.findUnique({
    where: { branchId: normalizedBranchId },
    select: {
      branchId: true,
      isActive: true,
      accountSid: true,
      authToken: true,
      fromNumber: true,
      appId: true,
    },
  });

  if (supportsConfig(ownConfig, options)) {
    return normalizeResolvedConfig(ownConfig as any, false);
  }

  const branch = await prisma.branch.findUnique({
    where: { id: normalizedBranchId },
    select: { companyId: true },
  });

  if (!branch?.companyId) return null;

  const companyBranches = await prisma.branch.findMany({
    where: { companyId: branch.companyId },
    select: { id: true, isMatriz: true },
  });

  const companyBranchIds = companyBranches
    .map((item: { id: string }) => String(item.id || '').trim())
    .filter(Boolean)
    .filter((item: string) => item !== normalizedBranchId);

  if (companyBranchIds.length === 0) return null;

  const configs = await prisma.whatsAppConfig.findMany({
    where: { branchId: { in: companyBranchIds } },
    select: {
      branchId: true,
      isActive: true,
      accountSid: true,
      authToken: true,
      fromNumber: true,
      appId: true,
      updatedAt: true,
    },
  });

  const allowed = configs.filter((config: any) => supportsConfig(config, options));
  if (allowed.length === 0) return null;

  const matrixBranchIds = new Set(
    companyBranches
      .filter((item: { isMatriz: boolean }) => item.isMatriz)
      .map((item: { id: string }) => String(item.id || '').trim())
      .filter(Boolean),
  );

  const sorted = allowed.sort((a: any, b: any) => {
    const aIsMatrix = matrixBranchIds.has(String(a.branchId || '').trim()) ? 0 : 1;
    const bIsMatrix = matrixBranchIds.has(String(b.branchId || '').trim()) ? 0 : 1;
    if (aIsMatrix !== bIsMatrix) return aIsMatrix - bIsMatrix;
    return new Date(String(b.updatedAt)).getTime() - new Date(String(a.updatedAt)).getTime();
  });

  return normalizeResolvedConfig(sorted[0] as any, true);
}
