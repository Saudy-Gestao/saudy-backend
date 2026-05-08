import { FastifyInstance } from 'fastify';
import prisma from '../lib/prisma';

const DEFAULT_REPORT_LAYOUT = {
  clinicName: 'Saudy',
  title: 'Laudo Médico',
  subtitle: '',
  headerText: '',
  footerText: '',
  paperSize: 'A4',
  orientation: 'portrait',
  marginTopMm: 18,
  marginRightMm: 16,
  marginBottomMm: 18,
  marginLeftMm: 16,
  fontFamily: 'Inter, Arial, sans-serif',
  fontSizePx: 13,
  primaryColor: '#0f172a',
  showLogo: false,
  logoUrl: '',
  logoImageDataUrl: '',
  showPatientInfo: true,
  showSignatures: true,
};

const normalizeReportLayout = (value: any) => {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    ...DEFAULT_REPORT_LAYOUT,
    ...source,
    marginTopMm: Number.isFinite(Number(source.marginTopMm)) ? Number(source.marginTopMm) : DEFAULT_REPORT_LAYOUT.marginTopMm,
    marginRightMm: Number.isFinite(Number(source.marginRightMm)) ? Number(source.marginRightMm) : DEFAULT_REPORT_LAYOUT.marginRightMm,
    marginBottomMm: Number.isFinite(Number(source.marginBottomMm)) ? Number(source.marginBottomMm) : DEFAULT_REPORT_LAYOUT.marginBottomMm,
    marginLeftMm: Number.isFinite(Number(source.marginLeftMm)) ? Number(source.marginLeftMm) : DEFAULT_REPORT_LAYOUT.marginLeftMm,
    fontSizePx: Number.isFinite(Number(source.fontSizePx)) ? Number(source.fontSizePx) : DEFAULT_REPORT_LAYOUT.fontSizePx,
    paperSize: source.paperSize === 'Letter' ? 'Letter' : 'A4',
    orientation: source.orientation === 'landscape' ? 'landscape' : 'portrait',
    showLogo: Boolean(source.showLogo),
    showPatientInfo: source.showPatientInfo !== false,
    showSignatures: source.showSignatures !== false,
  };
};

const getOrCreateConfig = async (branchId: string) => {
  const existing = await prisma.reportConfig.findFirst({ where: { branchId } });
  if (existing) return existing;

  return prisma.reportConfig.create({
    data: {
      branchId,
      requiresReviewer: true,
      reportLayout: DEFAULT_REPORT_LAYOUT,
    },
  });
};

export default async function reportConfigRoutes(app: FastifyInstance) {
  const getLoggedBranchId = async (request: any) => {
    const userId = (request.user as any)?.id;
    if (!userId) return null;
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { sector: { include: { branch: true } } },
    });
    return user?.sector?.branch?.id || null;
  };

  app.addHook('onRequest', async (request, reply) => {
    try {
      await request.jwtVerify();
    } catch {
      return reply.code(401).send({ error: 'Unauthorized' });
    }
  });

  app.get('/', {
    schema: {
      summary: 'Get report configuration',
      tags: ['Report Config'],
    },
  }, async (request, reply) => {
    const branchId = await getLoggedBranchId(request);
    if (!branchId) return (reply as any).code(403).send({ error: 'User not associated with a branch' });
    return getOrCreateConfig(branchId);
  });

  app.put('/', {
    schema: {
      summary: 'Update report configuration',
      tags: ['Report Config'],
      body: {
        type: 'object',
        properties: {
          requiresReviewer: { type: 'boolean' },
          reportLayout: { type: 'object', additionalProperties: true },
        },
      },
    },
  }, async (request, reply) => {
    const branchId = await getLoggedBranchId(request);
    if (!branchId) return (reply as any).code(403).send({ error: 'User not associated with a branch' });

    const data = request.body as any;

    if (data?.requiresReviewer !== undefined && typeof data.requiresReviewer !== 'boolean') {
      return reply.code(400).send({ error: 'requiresReviewer must be boolean when provided' });
    }

    if (data?.reportLayout !== undefined && (!data.reportLayout || typeof data.reportLayout !== 'object' || Array.isArray(data.reportLayout))) {
      return reply.code(400).send({ error: 'reportLayout must be an object when provided' });
    }

    const config = await getOrCreateConfig(branchId);
    return prisma.reportConfig.update({
      where: { id: config.id },
      data: {
        branchId,
        requiresReviewer: data.requiresReviewer ?? config.requiresReviewer,
        reportLayout: data.reportLayout !== undefined ? normalizeReportLayout(data.reportLayout) : (config as any).reportLayout,
      },
    });
  });
}
