import { FastifyInstance } from 'fastify';
import prisma from '../lib/prisma';
import { isValidCpf, normalizeCpf } from '../../../lib/cpf';
import WhatsAppAutoSender from '../lib/whatsapp-auto-sender';
import { deleteOrthancStudy } from '../../dicom/orthanc';
import { hasPermanentStudyReference, uploadTemporaryPriorStudy } from '../../dicom/temporary-prior-studies';
import { generatePatientReportPdfBuffer } from '../../auth/lib/patient-report-pdf';

const FINAL_REPORT_STATUSES = new Set([
  'FINALIZADO',
  'FINALIZADO_COM_REVISAO',
  'LIBERADO',
  'ASSINADO',
  'CONCLUIDO',
  'FINAL',
  'APROVADO',
]);

function normalizeReportStatus(value?: string | null) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '_');
}

function resolvePatientVisibleReport(report: any) {
  const latestPublication = Array.isArray(report?.publications) ? report.publications[0] : null;
  const hasPublishedSnapshot = Boolean(latestPublication);
  const normalizedStatus = normalizeReportStatus(report?.status);
  const isCurrentlyFinalized = FINAL_REPORT_STATUSES.has(normalizedStatus);
  const isUnderReview = hasPublishedSnapshot && !isCurrentlyFinalized;

  return {
    ...report,
    latestPublication,
    publishedVersion: latestPublication?.version ?? null,
    isUnderReview,
    patientWarning: isUnderReview
      ? 'Este laudo está em revisão pela clínica. Você está visualizando a última versão publicada.'
      : null,
    description: (hasPublishedSnapshot ? latestPublication?.description : report?.description) || null,
    conclusion: (hasPublishedSnapshot ? latestPublication?.conclusion : report?.conclusion) || null,
    notes: (hasPublishedSnapshot ? latestPublication?.notes : report?.notes) || null,
    exam: (hasPublishedSnapshot ? latestPublication?.exam : report?.exam) || null,
    requestingDoctor: (hasPublishedSnapshot ? latestPublication?.requestingDoctor : report?.requestingDoctor) || null,
    reportingDoctor: (hasPublishedSnapshot ? latestPublication?.reportingDoctor : report?.reportingDoctor) || null,
    reviewingDoctor: (hasPublishedSnapshot ? latestPublication?.reviewingDoctor : report?.reviewingDoctor) || null,
    reportingDoctorId: report?.reportingDoctorId || null,
    reviewingDoctorId: report?.reviewingDoctorId || null,
    issuerSignedAt: (hasPublishedSnapshot ? latestPublication?.issuerSignedAt : report?.issuerSignedAt) || null,
    reviewerSignedAt: (hasPublishedSnapshot ? latestPublication?.reviewerSignedAt : report?.reviewerSignedAt) || null,
  };
}

export default async function reportRoutes(app: FastifyInstance) {
  const getLoggedUser = async (request: any) => {
    const userId = (request.user as any)?.id;
    if (!userId) return { userId: null, userName: null, branchId: null, doctorName: null, doctorId: null };
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        sector: { include: { branch: true } },
        doctor: { select: { id: true, name: true } },
      },
    });
    return {
      userId: user?.id || null,
      userName: (user as any)?.name || null,
      branchId: user?.sector?.branch?.id || null,
      doctorName: user?.doctor?.name || null,
      doctorId: user?.doctor?.id || null,
    };
  };

  const getLoggedBranchId = async (request: any) => {
    const { branchId } = await getLoggedUser(request);
    return branchId;
  };

  const createAuditLog = async (params: {
    branchId: string;
    reportId?: string;
    action: string;
    performedByUserId?: string | null;
    performedByName?: string | null;
    details?: string;
  }) => {
    try {
      await prisma.reportAuditLog.create({ data: params });
    } catch {
      // audit log failures must not break the main operation
    }
  };

  const reportAccessWhere = (id: string, branchId: string): any => ({
    id,
    branchId,
  });

  app.addHook('onRequest', async (request, reply) => {
    try {
      await request.jwtVerify();
    } catch {
      return reply.code(401).send({ error: 'Unauthorized' });
    }
  });

  app.get('/', {
    schema: {
      summary: 'List reports',
      tags: ['Reports'],
      querystring: {
        type: 'object',
        properties: {
          search: { type: 'string' },
          status: { type: 'string' },
          exam: { type: 'string' },
          worklistItemId: { type: 'string' },
          appointmentId: { type: 'string' },
          limit: { type: 'number', default: 50 },
          offset: { type: 'number', default: 0 },
        },
      },
    },
  }, async (request, reply) => {
    const context = await getLoggedUser(request);
    const branchId = context?.branchId;
    if (!branchId) return (reply as any).code(403).send({ error: 'User not associated with a branch' });

    const { search, status, exam, worklistItemId, appointmentId, limit = 50, offset = 0 } = request.query as any;

    const where: any = { isActive: true, branchId };
    if (status) where.status = status;
    if (exam) where.exam = exam;
    if (worklistItemId) where.worklistItemId = worklistItemId;
    if (appointmentId) where.appointmentId = appointmentId;
    if (search) {
      where.OR = [
        { patientName: { contains: search, mode: 'insensitive' } },
        { cpf: { contains: search, mode: 'insensitive' } },
        { requestingDoctor: { contains: search, mode: 'insensitive' } },
      ];
    }
    const [items, total] = await Promise.all([
      prisma.report.findMany({
        where,
        take: limit,
        skip: offset,
        orderBy: { createdAt: 'desc' },
        include: {
          appointment: { select: { id: true, patientName: true, patientCpf: true, specialty: true, date: true, time: true, doctorName: true, convenio: true } },
          worklistItem: { select: { id: true, dicomStudyUid: true, dicomUrl: true, dicomReceivedAt: true } },
          addendums: { where: { isActive: true, status: 'finalizado' }, select: { id: true } },
        },
      }),
      prisma.report.count({ where }),
    ]);

    const normalizedItems = items.map((item: any) => ({
      ...item,
      hasFinalizedAddendum: Array.isArray(item.addendums) && item.addendums.length > 0,
    }));

    return { items: normalizedItems, total };
  });

  app.get('/:id', {
    schema: {
      summary: 'Get report by ID',
      tags: ['Reports'],
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
  }, async (request, reply) => {
    const context = await getLoggedUser(request);
    const branchId = context?.branchId;
    if (!branchId) return (reply as any).code(403).send({ error: 'User not associated with a branch' });

    const { id } = request.params as any;
    const item = await prisma.report.findFirst({
      where: reportAccessWhere(id, branchId),
      include: {
        appointment: { select: { id: true, patientName: true, patientCpf: true, specialty: true, date: true, time: true, doctorName: true, status: true } },
        worklistItem: { select: { id: true, dicomStudyUid: true, dicomUrl: true, dicomReceivedAt: true, accessionNumber: true } },
        addendums: { where: { isActive: true }, orderBy: { updatedAt: 'desc' } },
        temporaryDicomStudies: { where: { deletedAt: null }, orderBy: { createdAt: 'desc' } },
      },
    });
    if (!item) return reply.code(404).send({ error: 'Report not found' });
    return item;
  });

  app.get('/:id/patient-facing-pdf', {
    schema: {
      summary: 'Render patient-facing report PDF (same source used by patient portal)',
      tags: ['Reports'],
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
  }, async (request, reply) => {
    const { branchId } = await getLoggedUser(request);
    if (!branchId) return (reply as any).code(403).send({ error: 'User not associated with a branch' });

    const { id } = request.params as any;
    const report = await prisma.report.findFirst({
      where: reportAccessWhere(id, branchId),
      include: {
        appointment: {
          select: {
            id: true,
            date: true,
            time: true,
            specialty: true,
            doctorName: true,
          },
        },
        addendums: {
          where: { isActive: true, status: 'finalizado' },
          orderBy: { createdAt: 'asc' },
        },
        publications: {
          where: { isActive: true },
          orderBy: { version: 'desc' },
          take: 1,
        },
      },
    });
    if (!report) return reply.code(404).send({ error: 'Report not found' });

    const visibleReport = resolvePatientVisibleReport(report);
    const config = await prisma.reportConfig.findFirst({
      where: { branchId },
      select: { reportLayout: true, requiresReviewer: true },
    });
    const addendums = Array.isArray((report as any)?.addendums) ? (report as any).addendums : [];
    const doctorIds = Array.from(new Set([
      String(visibleReport?.reportingDoctorId || report?.reportingDoctorId || '').trim(),
      String(visibleReport?.reviewingDoctorId || report?.reviewingDoctorId || '').trim(),
      ...addendums.map((item: any) => String(item?.issuerDoctorId || '').trim()),
    ].filter(Boolean)));
    const doctors = doctorIds.length > 0
      ? await prisma.doctor.findMany({
        where: { id: { in: doctorIds } },
        select: { id: true, name: true, crmType: true, crm: true, crmState: true, signatureImageBase64: true },
      })
      : [];
    const doctorMap = new Map<string, any>(doctors.map((doctor: any) => [doctor.id, doctor]));
    const reportingDoctor = doctorMap.get(String(visibleReport?.reportingDoctorId || report?.reportingDoctorId || '').trim());
    const reviewingDoctor = doctorMap.get(String(visibleReport?.reviewingDoctorId || report?.reviewingDoctorId || '').trim());
    const getRegistration = (doctor: any) => {
      if (!doctor) return null;
      const type = String(doctor.crmType || 'CRM').trim();
      const crm = String(doctor.crm || '').trim();
      const state = String(doctor.crmState || '').trim();
      if (!crm) return null;
      return `${type} ${crm}${state ? `/${state}` : ''}`;
    };

    const pdf = await generatePatientReportPdfBuffer({
      reportId: String(report.id),
      reportContentHtml: String(visibleReport?.description || '').trim() || `<p>${String(visibleReport?.conclusion || '-')}</p>`,
      reportStatus: visibleReport?.status || null,
      reportUnderReview: Boolean(visibleReport?.isUnderReview),
      publishedVersion: visibleReport?.publishedVersion ?? null,
      patientWarning: visibleReport?.patientWarning || null,
      patient: {
        name: report?.patientName || report?.appointment?.patientName || '-',
        cpf: report?.cpf || report?.appointment?.patientCpf || null,
      },
      examName: visibleReport?.exam || report?.appointment?.specialty || '-',
      appointment: {
        date: report?.appointment?.date || null,
        time: report?.appointment?.time || null,
      },
      doctors: {
        requestingDoctor: visibleReport?.requestingDoctor || null,
        reportingDoctor: visibleReport?.reportingDoctor || null,
        reviewingDoctor: visibleReport?.reviewingDoctor || null,
        reportingDoctorSignatureBase64: reportingDoctor?.signatureImageBase64 || null,
        reviewingDoctorSignatureBase64: reviewingDoctor?.signatureImageBase64 || null,
        reportingDoctorRegistration: getRegistration(reportingDoctor),
        reviewingDoctorRegistration: getRegistration(reviewingDoctor),
      },
      signatures: {
        issuerSignedAt: visibleReport?.issuerSignedAt || null,
        reviewerSignedAt: visibleReport?.reviewerSignedAt || null,
      },
      addendums: addendums.map((item: any) => {
        const issuerDoctor = doctorMap.get(String(item?.issuerDoctorId || '').trim());
        return {
          ...item,
          issuerDoctorName: item.issuerDoctor || null,
          issuerDoctorSignatureBase64: issuerDoctor?.signatureImageBase64 || null,
          issuerDoctorRegistration: getRegistration(issuerDoctor),
        };
      }),
      layout: (config as any)?.reportLayout || null,
      requiresReviewer: (config as any)?.requiresReviewer !== false,
      hideUnderReviewNotice: true,
      previewRibbonText: 'Prévia médica',
    });

    reply.header('Content-Type', 'application/pdf');
    reply.header('Content-Disposition', `inline; filename="laudo-${report.id}.pdf"`);
    reply.header('Cache-Control', 'no-store');
    reply.header('Content-Length', String(pdf.length));
    return reply.send(pdf);
  });

  app.post('/:id/patient-facing-pdf-preview', {
    schema: {
      summary: 'Render doctor preview PDF using current editor content',
      tags: ['Reports'],
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      body: {
        type: 'object',
        properties: {
          contentHtml: { type: 'string' },
          patientName: { type: 'string' },
          patientCpf: { type: 'string' },
          examName: { type: 'string' },
          appointmentDate: { type: 'string' },
          appointmentTime: { type: 'string' },
          requestingDoctor: { type: 'string' },
          reportingDoctor: { type: 'string' },
          reviewingDoctor: { type: 'string' },
          issuerSignedAt: { type: 'string' },
          reviewerSignedAt: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const { branchId } = await getLoggedUser(request);
    if (!branchId) return (reply as any).code(403).send({ error: 'User not associated with a branch' });

    const { id } = request.params as any;
    const body = (request.body || {}) as any;

    const report = await prisma.report.findFirst({
      where: reportAccessWhere(id, branchId),
      include: {
        appointment: {
          select: {
            id: true,
            date: true,
            time: true,
            specialty: true,
            doctorName: true,
            patientName: true,
            patientCpf: true,
          },
        },
        addendums: {
          where: { isActive: true, status: 'finalizado' },
          orderBy: { createdAt: 'asc' },
        },
        publications: {
          where: { isActive: true },
          orderBy: { version: 'desc' },
          take: 1,
        },
      },
    });
    if (!report) return reply.code(404).send({ error: 'Report not found' });

    const visibleReport = resolvePatientVisibleReport(report);
    const config = await prisma.reportConfig.findFirst({
      where: { branchId },
      select: { reportLayout: true, requiresReviewer: true },
    });
    const addendums = Array.isArray((report as any)?.addendums) ? (report as any).addendums : [];
    const doctorIds = Array.from(new Set([
      String(visibleReport?.reportingDoctorId || report?.reportingDoctorId || '').trim(),
      String(visibleReport?.reviewingDoctorId || report?.reviewingDoctorId || '').trim(),
      ...addendums.map((item: any) => String(item?.issuerDoctorId || '').trim()),
    ].filter(Boolean)));
    const doctors = doctorIds.length > 0
      ? await prisma.doctor.findMany({
        where: { id: { in: doctorIds } },
        select: { id: true, name: true, crmType: true, crm: true, crmState: true, signatureImageBase64: true },
      })
      : [];
    const doctorMap = new Map<string, any>(doctors.map((doctor: any) => [doctor.id, doctor]));
    const reportingDoctor = doctorMap.get(String(visibleReport?.reportingDoctorId || report?.reportingDoctorId || '').trim());
    const reviewingDoctor = doctorMap.get(String(visibleReport?.reviewingDoctorId || report?.reviewingDoctorId || '').trim());
    const getRegistration = (doctor: any) => {
      if (!doctor) return null;
      const type = String(doctor.crmType || 'CRM').trim();
      const crm = String(doctor.crm || '').trim();
      const state = String(doctor.crmState || '').trim();
      if (!crm) return null;
      return `${type} ${crm}${state ? `/${state}` : ''}`;
    };
    const hasOwn = (key: string) => Object.prototype.hasOwnProperty.call(body, key);
    const pick = (key: string, fallback: any) => (hasOwn(key) ? body[key] : fallback);

    const pdf = await generatePatientReportPdfBuffer({
      reportId: String(report.id),
      reportContentHtml: String(pick('contentHtml', visibleReport?.description) || '').trim()
        || String(visibleReport?.description || '').trim()
        || `<p>${String(visibleReport?.conclusion || '-')}</p>`,
      reportStatus: visibleReport?.status || null,
      reportUnderReview: Boolean(visibleReport?.isUnderReview),
      publishedVersion: visibleReport?.publishedVersion ?? null,
      patientWarning: visibleReport?.patientWarning || null,
      patient: {
        name: pick('patientName', report?.patientName || report?.appointment?.patientName || '-'),
        cpf: pick('patientCpf', report?.cpf || report?.appointment?.patientCpf || null),
      },
      examName: pick('examName', visibleReport?.exam || report?.appointment?.specialty || '-'),
      appointment: {
        date: pick('appointmentDate', report?.appointment?.date || null),
        time: pick('appointmentTime', report?.appointment?.time || null),
      },
      doctors: {
        requestingDoctor: pick('requestingDoctor', visibleReport?.requestingDoctor || null),
        reportingDoctor: pick('reportingDoctor', visibleReport?.reportingDoctor || null),
        reviewingDoctor: pick('reviewingDoctor', visibleReport?.reviewingDoctor || null),
        reportingDoctorSignatureBase64: reportingDoctor?.signatureImageBase64 || null,
        reviewingDoctorSignatureBase64: reviewingDoctor?.signatureImageBase64 || null,
        reportingDoctorRegistration: getRegistration(reportingDoctor),
        reviewingDoctorRegistration: getRegistration(reviewingDoctor),
      },
      signatures: {
        issuerSignedAt: pick('issuerSignedAt', visibleReport?.issuerSignedAt || null),
        reviewerSignedAt: pick('reviewerSignedAt', visibleReport?.reviewerSignedAt || null),
      },
      addendums: addendums.map((item: any) => {
        const issuerDoctor = doctorMap.get(String(item?.issuerDoctorId || '').trim());
        return {
          ...item,
          issuerDoctorName: item.issuerDoctor || null,
          issuerDoctorSignatureBase64: issuerDoctor?.signatureImageBase64 || null,
          issuerDoctorRegistration: getRegistration(issuerDoctor),
        };
      }),
      layout: (config as any)?.reportLayout || null,
      requiresReviewer: (config as any)?.requiresReviewer !== false,
      hideUnderReviewNotice: true,
      previewRibbonText: 'Prévia médica',
    });

    reply.header('Content-Type', 'application/pdf');
    reply.header('Content-Disposition', `inline; filename="laudo-preview-${report.id}.pdf"`);
    reply.header('Cache-Control', 'no-store');
    reply.header('Content-Length', String(pdf.length));
    return reply.send(pdf);
  });

  app.get('/:id/temporary-prior-studies', {
    schema: {
      summary: 'List temporary prior DICOM studies for a report',
      tags: ['Reports'],
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
  }, async (request, reply) => {
    const context = await getLoggedUser(request);
    const branchId = context?.branchId;
    if (!branchId) return (reply as any).code(403).send({ error: 'User not associated with a branch' });

    const { id } = request.params as any;
    const report = await prisma.report.findFirst({
      where: reportAccessWhere(id, branchId),
      select: { id: true },
    });
    if (!report) return reply.code(404).send({ error: 'Report not found' });

    const items = await prisma.temporaryDicomStudy.findMany({
      where: { reportId: id, branchId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
    });

    return { items, total: items.length };
  });

  app.post('/:id/temporary-prior-studies', {
    bodyLimit: Number(process.env.TEMP_DICOM_BODY_LIMIT_BYTES || String(700 * 1024 * 1024)),
    schema: {
      summary: 'Upload a temporary prior DICOM study for report comparison',
      tags: ['Reports'],
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      body: {
        type: 'object',
        properties: {
          files: {
            type: 'array',
            items: {
              type: 'object',
              required: ['base64'],
              properties: {
                fileName: { type: 'string' },
                base64: { type: 'string' },
              },
            },
          },
          filesBase64: { type: 'array', items: { type: 'string' } },
          zipBase64: { type: 'string' },
          zipFileName: { type: 'string' },
          description: { type: 'string' },
          ttlHours: { type: 'number' },
        },
      },
    },
  }, async (request, reply) => {
    const { branchId, userId, userName, doctorName, doctorId } = await getLoggedUser(request);
    if (!branchId) return (reply as any).code(403).send({ error: 'User not associated with a branch' });

    const { id } = request.params as any;
    const report = await prisma.report.findFirst({
      where: reportAccessWhere(id, branchId),
      select: { id: true, patientName: true, cpf: true, exam: true },
    });
    if (!report) return reply.code(404).send({ error: 'Report not found' });

    const payload = request.body as any;
    const files = Array.isArray(payload?.files)
      ? payload.files.map((file: any) => ({
          fileName: typeof file?.fileName === 'string' ? file.fileName : undefined,
          base64: String(file?.base64 || ''),
        }))
      : Array.isArray(payload?.filesBase64)
        ? payload.filesBase64.map((base64: string, index: number) => ({
            fileName: `dicom-${index + 1}.dcm`,
            base64: String(base64 || ''),
          }))
        : [];

    const zipBase64 = typeof payload?.zipBase64 === 'string' ? payload.zipBase64 : null;

    if (!files.length && !zipBase64) {
      return reply.code(400).send({ error: 'Envie ao menos um arquivo DICOM ou um ZIP com DICOMs' });
    }

    try {
      const item = await uploadTemporaryPriorStudy({
        branchId,
        reportId: id,
        uploadedByUserId: userId,
        description: payload?.description || null,
        ttlHours: payload?.ttlHours,
        files,
        zipBase64,
      });

      await createAuditLog({
        branchId,
        reportId: id,
        action: 'estudo_dicom_temporario_carregado',
        performedByUserId: userId,
        performedByName: userName,
        details: JSON.stringify({
          temporaryStudyId: item.id,
          orthancStudyId: item.orthancStudyId,
          studyInstanceUid: item.studyInstanceUid,
          instancesCount: item.instancesCount,
          expiresAt: item.expiresAt,
        }),
      });

      return reply.code(201).send({
        item,
        temporaryStudyId: item.id,
        orthancStudyId: item.orthancStudyId,
        studyInstanceUid: item.studyInstanceUid,
        expiresAt: item.expiresAt,
        viewer: {
          type: 'orthanc',
          dicomWebStudyPath: `/dicom-web/studies/${item.studyInstanceUid}`,
        },
      });
    } catch (err: any) {
      request.log.error({ err, reportId: id }, 'Failed to upload temporary prior study');
      return reply.code(400).send({
        error: 'Failed to upload temporary prior DICOM study',
        details: err?.message || 'Unknown error',
      });
    }
  });

  app.delete('/:id/temporary-prior-studies/:temporaryStudyId', {
    schema: {
      summary: 'Delete a temporary prior DICOM study from Orthanc',
      tags: ['Reports'],
      params: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          temporaryStudyId: { type: 'string' },
        },
        required: ['id', 'temporaryStudyId'],
      },
    },
  }, async (request, reply) => {
    const { branchId, userId, userName, doctorName, doctorId } = await getLoggedUser(request);
    if (!branchId) return (reply as any).code(403).send({ error: 'User not associated with a branch' });

    const { id, temporaryStudyId } = request.params as any;
    const report = await prisma.report.findFirst({
      where: reportAccessWhere(id, branchId),
      select: { id: true },
    });
    if (!report) return reply.code(404).send({ error: 'Report not found' });

    const study = await prisma.temporaryDicomStudy.findFirst({
      where: { id: temporaryStudyId, reportId: id, branchId, deletedAt: null },
    });
    if (!study) return reply.code(404).send({ error: 'Temporary DICOM study not found' });

    try {
      if (study.deleteFromOrthanc || !(await hasPermanentStudyReference(study.studyInstanceUid))) {
        await deleteOrthancStudy(study.orthancStudyId);
      }
      await prisma.temporaryDicomStudy.update({
        where: { id: study.id },
        data: { deletedAt: new Date() },
      });

      await createAuditLog({
        branchId,
        reportId: id,
        action: 'estudo_dicom_temporario_removido',
        performedByUserId: userId,
        performedByName: userName,
        details: JSON.stringify({
          temporaryStudyId: study.id,
          orthancStudyId: study.orthancStudyId,
          studyInstanceUid: study.studyInstanceUid,
        }),
      });

      return { message: 'Temporary DICOM study deleted' };
    } catch (err: any) {
      request.log.error({ err, reportId: id, temporaryStudyId }, 'Failed to delete temporary prior study');
      return reply.code(500).send({
        error: 'Failed to delete temporary DICOM study',
        details: err?.message || 'Unknown error',
      });
    }
  });

  app.post('/', {
    schema: {
      summary: 'Create report',
      tags: ['Reports'],
      body: {
        type: 'object',
        properties: {
          worklistItemId: { type: 'string' },
          appointmentId: { type: 'string' },
          patientName: { type: 'string', minLength: 1 },
          cpf: { type: 'string', pattern: '^\\d{11}$' },
          birthDate: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
          requestingDoctor: { type: 'string' },
          reportingDoctor: { type: 'string' },
          reviewingDoctor: { type: 'string' },
          reportingDoctorId: { type: 'string' },
          reviewingDoctorId: { type: 'string' },
          description: { type: 'string' },
          conclusion: { type: 'string' },
          notes: { type: 'string' },
          status: { type: 'string' },
          exam: { type: 'string' },
          scheduledFor: { type: 'string' },
          responsibleDoctor: { type: 'string' },
          observation: { type: 'string' },
          issuerSignedAt: { type: 'string' },
          reviewerSignedAt: { type: 'string' },
          signIssuer: { type: 'boolean' },
          signReviewer: { type: 'boolean' },
          finalizedAt: { type: 'string' },
          finalizedDoctorId: { type: 'string' },
        },
      },
      response: {
        201: { type: 'object' },
        400: { type: 'object', additionalProperties: true },
        403: { type: 'object', additionalProperties: true },
      },
    },
  }, async (request, reply) => {
    const { branchId, userId, userName, doctorName, doctorId } = await getLoggedUser(request);
    if (!branchId) return (reply as any).code(403).send({ error: 'User not associated with a branch' });

    const data = request.body as any;

    // patientName is optional when worklistItemId or appointmentId is provided
    if (!data.worklistItemId && !data.appointmentId) {
      if (!data.patientName || !String(data.patientName).trim()) {
        return reply.code(400).send({ error: 'patientName is required when worklistItemId or appointmentId is not provided' });
      }
    }

    if (data.cpf) {
      const digits = normalizeCpf(data.cpf);
      if (!isValidCpf(digits)) {
        return reply.code(400).send({ error: 'cpf must be valid' });
      }
      data.cpf = digits; // normalize
    }

    if (data.birthDate && !/^\d{4}-\d{2}-\d{2}$/.test(String(data.birthDate))) {
      return reply.code(400).send({ error: 'birthDate must be YYYY-MM-DD' });
    }

    const shouldAttributeMedicalAuthor = data.status === 'laudado' || data.status === 'revisado' || data.status === 'finalizado';
    if (shouldAttributeMedicalAuthor && !doctorId) {
      return reply.code(403).send({ error: 'Usuário sem vínculo com médico para executar esta ação' });
    }
    if (!data.reportingDoctorId && doctorId && shouldAttributeMedicalAuthor) {
      data.reportingDoctorId = doctorId;
    }
    if (!data.reportingDoctor && doctorName && shouldAttributeMedicalAuthor) {
      data.reportingDoctor = doctorName;
    }

    try {
      const createData: any = {
        branchId,
        worklistItemId: data.worklistItemId || null,
        appointmentId: data.appointmentId || null,
        patientName: data.patientName || null,
        cpf: data.cpf || null,
        birthDate: data.birthDate || null,
        requestingDoctor: data.requestingDoctor || null,
        reportingDoctor: data.reportingDoctor || null,
        reviewingDoctor: data.reviewingDoctor || null,
        reportingDoctorId: data.reportingDoctorId || null,
        reviewingDoctorId: data.reviewingDoctorId || null,
        description: data.description || null,
        conclusion: data.conclusion || null,
        notes: data.notes || null,
        status: data.status || 'rascunho',
        exam: data.exam || null,
        scheduledFor: data.scheduledFor || null,
        responsibleDoctor: data.responsibleDoctor || null,
        observation: data.observation || null,
        issuerSignedAt: data.signIssuer ? new Date() : (data.issuerSignedAt ? new Date(data.issuerSignedAt) : null),
        reviewerSignedAt: data.signReviewer ? new Date() : (data.reviewerSignedAt ? new Date(data.reviewerSignedAt) : null),
      };
      const item = await prisma.report.create({ data: createData });

      await createAuditLog({
        branchId,
        reportId: item.id,
        action: 'laudo_criado',
        performedByUserId: userId,
        performedByName: userName,
        details: JSON.stringify({
          status: item.status,
          paciente: item.patientName,
          exame: item.exam,
          medicoSolicitante: item.requestingDoctor,
          medicoLaudador: item.reportingDoctor,
        }),
      });

      return reply.code(201).send(item);
    } catch (err: any) {
      request.log.error({ err }, 'Failed to create report');
      return reply.code(400).send({ error: 'Failed to create report', details: err.message });
    }
  });

  app.put('/:id', {
    schema: {
      summary: 'Update report',
      tags: ['Reports'],
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      body: {
        type: 'object',
        properties: {
          worklistItemId: { type: 'string' },
          appointmentId: { type: 'string' },
          patientName: { type: 'string', minLength: 1 },
          cpf: { type: 'string', pattern: '^\\d{11}$' },
          birthDate: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
          requestingDoctor: { type: 'string' },
          reportingDoctor: { type: 'string' },
          reviewingDoctor: { type: 'string' },
          reportingDoctorId: { type: 'string' },
          reviewingDoctorId: { type: 'string' },
          description: { type: 'string' },
          conclusion: { type: 'string' },
          notes: { type: 'string' },
          status: { type: 'string' },
          exam: { type: 'string' },
          scheduledFor: { type: 'string' },
          responsibleDoctor: { type: 'string' },
          observation: { type: 'string' },
          issuerSignedAt: { type: 'string' },
          reviewerSignedAt: { type: 'string' },
          signIssuer: { type: 'boolean' },
          signReviewer: { type: 'boolean' },
          finalizedAt: { type: 'string' },
          finalizedDoctorId: { type: 'string' },
        },
      },
      response: {
        200: { type: 'object' },
        400: { type: 'object', additionalProperties: true },
        403: { type: 'object', additionalProperties: true },
        404: { type: 'object', additionalProperties: true },
      },
    },
  }, async (request, reply) => {
    const { branchId, userId, userName, doctorName, doctorId } = await getLoggedUser(request);
    if (!branchId) return (reply as any).code(403).send({ error: 'User not associated with a branch' });

    const { id } = request.params as any;
    const data = request.body as any;

    try {
      const existing = await prisma.report.findFirst({ where: { id, branchId } });
      if (!existing) return reply.code(404).send({ error: 'Report not found' });

      // runtime validations for update
      if (data.patientName !== undefined && (!String(data.patientName).trim())) {
        return reply.code(400).send({ error: 'patientName cannot be empty' });
      }

      if (data.cpf) {
        const digits = normalizeCpf(data.cpf);
        if (!isValidCpf(digits)) {
          return reply.code(400).send({ error: 'cpf must be valid' });
        }
        data.cpf = digits;
      }

      if (data.birthDate && !/^\d{4}-\d{2}-\d{2}$/.test(String(data.birthDate))) {
        return reply.code(400).send({ error: 'birthDate must be YYYY-MM-DD' });
      }

      const updateData: any = { ...data, branchId };
      const signIssuerRequested = data.signIssuer === true;
      const signReviewerRequested = data.signReviewer === true;
      const hasDescriptionChange = data.description !== undefined && data.description !== existing.description;
      const shouldResignReviewer = signReviewerRequested && (hasDescriptionChange || !existing.reviewerSignedAt);
      if (data.issuerSignedAt !== undefined) updateData.issuerSignedAt = data.issuerSignedAt ? new Date(data.issuerSignedAt) : null;
      if (data.reviewerSignedAt !== undefined) updateData.reviewerSignedAt = data.reviewerSignedAt ? new Date(data.reviewerSignedAt) : null;
      if (data.finalizedAt !== undefined) updateData.finalizedAt = data.finalizedAt ? new Date(data.finalizedAt) : null;
      if (signIssuerRequested && !existing.issuerSignedAt) {
        updateData.issuerSignedAt = new Date();
      }
      if (shouldResignReviewer) {
        updateData.reviewerSignedAt = new Date();
      }
      delete updateData.signIssuer;
      delete updateData.signReviewer;

      // If report content changes after review signature, reviewer must sign again.
      // Keep issuer signature untouched per current business rule.
      if (hasDescriptionChange && existing.reviewerSignedAt && !signReviewerRequested) {
        updateData.reviewerSignedAt = null;
        updateData.reviewingDoctorId = null;
        updateData.reviewingDoctor = null;
      }
      const signingDoctorName = String(doctorName || '').trim() || null;
      const signingDoctorId = String(doctorId || '').trim() || null;
      const isIssuerSigningNow = Boolean(updateData.issuerSignedAt) && !existing.issuerSignedAt;
      const isReviewerSigningNow = Boolean(updateData.reviewerSignedAt) && !existing.reviewerSignedAt;

      const isMedicalAttributionAction = Boolean(
        isIssuerSigningNow
        || isReviewerSigningNow
        || data.status === 'laudado'
        || data.status === 'revisado'
        || data.status === 'finalizado',
      );
      if (isMedicalAttributionAction && !signingDoctorId) {
        return reply.code(403).send({ error: 'Usuário sem vínculo com médico para executar esta ação' });
      } else if (existing.status === 'finalizado' && data.status && data.status !== 'finalizado') {
        // Current-state semantics: unfinalizing clears finalization markers.
        if (data.finalizedAt === undefined) updateData.finalizedAt = null;
        if (data.finalizedDoctorId === undefined) updateData.finalizedDoctorId = null;
      }

      // If reviewer signs first on a report without issuer signature, register both signatures.
      if (isReviewerSigningNow && !existing.issuerSignedAt && !updateData.issuerSignedAt) {
        updateData.issuerSignedAt = updateData.reviewerSignedAt;
      }

      if (isIssuerSigningNow) {
        updateData.reportingDoctorId = signingDoctorId || (existing as any).reportingDoctorId || null;
        updateData.reportingDoctor = signingDoctorName || existing.reportingDoctor || null;
      }
      if (isReviewerSigningNow || shouldResignReviewer) {
        updateData.reviewingDoctorId = signingDoctorId || (existing as any).reviewingDoctorId || null;
        updateData.reviewingDoctor = signingDoctorName || existing.reviewingDoctor || null;
      }
      if (updateData.issuerSignedAt && !String(updateData.reportingDoctorId || '').trim()) {
        updateData.reportingDoctorId = (existing as any).reportingDoctorId || signingDoctorId || null;
      }
      if (updateData.issuerSignedAt && !String(updateData.reportingDoctor || '').trim()) {
        updateData.reportingDoctor = existing.reportingDoctor || signingDoctorName || null;
      }
      // First meaningful save should claim the report author even without signature.
      if ((data.description !== undefined || data.status === 'laudado') && !String(updateData.reportingDoctor || '').trim()) {
        updateData.reportingDoctor = existing.reportingDoctor || signingDoctorName || null;
      }
      if ((data.description !== undefined || data.status === 'laudado') && !String(updateData.reportingDoctorId || '').trim()) {
        updateData.reportingDoctorId = (existing as any).reportingDoctorId || signingDoctorId || null;
      }
      if (data.status === 'revisado' && !String(updateData.reviewingDoctorId || '').trim()) {
        updateData.reviewingDoctorId = (existing as any).reviewingDoctorId || signingDoctorId || null;
      }
      if (data.status === 'revisado' && !String(updateData.reviewingDoctor || '').trim()) {
        updateData.reviewingDoctor = existing.reviewingDoctor || signingDoctorName || null;
      }

      let publicationCreateData: any = null;
      if (data.status === 'finalizado') {
        const config = await prisma.reportConfig.findFirst({
          where: { branchId },
          select: { requiresReviewer: true },
        });
        const requiresReviewer = config?.requiresReviewer ?? true;
        const nextIssuerSignedAt = updateData.issuerSignedAt ?? existing.issuerSignedAt;
        const nextReviewerSignedAt = updateData.reviewerSignedAt ?? existing.reviewerSignedAt;

        if (!nextIssuerSignedAt) {
          return reply.code(400).send({ error: 'issuerSignedAt is required to finalize report' });
        }
        if (requiresReviewer && !nextReviewerSignedAt) {
          return reply.code(400).send({ error: 'reviewerSignedAt is required to finalize report for this branch' });
        }

        if (!updateData.finalizedAt && !existing.finalizedAt) {
          updateData.finalizedAt = new Date();
        } else if (!updateData.finalizedAt) {
          updateData.finalizedAt = existing.finalizedAt;
        }
        if (!updateData.finalizedDoctorId && !(existing as any).finalizedDoctorId) {
          updateData.finalizedDoctorId = signingDoctorId;
        } else if (!updateData.finalizedDoctorId) {
          updateData.finalizedDoctorId = (existing as any).finalizedDoctorId;
        }

        const latestPublication = await prisma.reportPublication.findFirst({
          where: { reportId: id, isActive: true },
          orderBy: { version: 'desc' },
          select: { version: true },
        });
        const nextVersion = Number(latestPublication?.version || 0) + 1;
        const publishedAt = new Date();
        publicationCreateData = {
          branchId,
          reportId: id,
          version: nextVersion,
          publishedAt,
          description: updateData.description ?? existing.description ?? null,
          conclusion: updateData.conclusion ?? existing.conclusion ?? null,
          notes: updateData.notes ?? existing.notes ?? null,
          exam: updateData.exam ?? existing.exam ?? null,
          requestingDoctor: updateData.requestingDoctor ?? existing.requestingDoctor ?? null,
          reportingDoctor: updateData.reportingDoctor ?? existing.reportingDoctor ?? null,
          reviewingDoctor: updateData.reviewingDoctor ?? existing.reviewingDoctor ?? null,
          issuerSignedAt: nextIssuerSignedAt ?? null,
          reviewerSignedAt: nextReviewerSignedAt ?? null,
        };
      }

      let item: any = null;
      if (publicationCreateData) {
        const txResult = await prisma.$transaction(async (tx) => {
          const updated = await tx.report.update({ where: { id }, data: updateData });
          await tx.reportPublication.create({ data: publicationCreateData });
          return updated;
        });
        item = txResult;
      } else {
        item = await prisma.report.update({ where: { id }, data: updateData });
      }

      // Determine the most descriptive action label for meaningful status transitions
      let action = 'laudo_atualizado';
      if (data.status && data.status !== existing.status) {
        if (data.status === 'finalizado') {
          action = 'laudo_finalizado';
        } else if (existing.status === 'finalizado') {
          action = 'laudo_desfinalizado';
        } else {
          action = 'laudo_status_alterado';
        }
      } else if (data.issuerSignedAt && !existing.issuerSignedAt) {
        action = 'laudo_assinado_emissor';
      } else if ((data.reviewerSignedAt || signReviewerRequested) && !existing.reviewerSignedAt) {
        action = 'laudo_assinado_revisor';
      } else if (data.description !== undefined) {
        action = 'laudo_conteudo_alterado';
      }

      const auditDetails: Record<string, any> = {};
      if (data.status && data.status !== existing.status) {
        auditDetails.statusAnterior = existing.status;
        auditDetails.statusNovo = data.status;
      }
      if (hasDescriptionChange) {
        auditDetails.conteudoAnterior = existing.description || '';
        auditDetails.conteudoNovo = data.description || '';
      }
      if (data.issuerSignedAt !== undefined) {
        auditDetails.assinaturaEmissor = data.issuerSignedAt;
      }
      if (data.reviewerSignedAt !== undefined) {
        auditDetails.assinaturaRevisor = data.reviewerSignedAt;
      }
      auditDetails.medicoEmissor = item.issuerSignedAt ? (item.reportingDoctor || null) : null;
      auditDetails.medicoRevisor = item.reviewerSignedAt ? (item.reviewingDoctor || null) : null;
      auditDetails.medicoEmissorId = (item as any).reportingDoctorId || null;
      auditDetails.medicoRevisorId = (item as any).reviewingDoctorId || null;
      auditDetails.medicoFinalizadorId = (item as any).finalizedDoctorId || null;

      await createAuditLog({
        branchId,
        reportId: id,
        action,
        performedByUserId: userId,
        performedByName: userName,
        details: JSON.stringify(auditDetails),
      });

      if (existing.status !== 'finalizado' && item.status === 'finalizado' && item.appointmentId) {
        void (async () => {
          try {
            const alreadyNotified = await prisma.reportAuditLog.findFirst({
              where: {
                branchId,
                reportId: id,
                action: 'notificacao_exame_pronto_enviada',
              },
              select: { id: true },
            });

            if (alreadyNotified) return;

            const branch = await prisma.branch.findUnique({
              where: { id: branchId },
              select: { tradeName: true },
            });

            const result = await WhatsAppAutoSender.sendExamResultReadyMessage({
              branchId,
              appointmentId: item.appointmentId,
              patientName: item.patientName || null,
              examName: item.exam || null,
              clinicName: branch?.tradeName || null,
            });

            await createAuditLog({
              branchId,
              reportId: id,
              action: result.success ? 'notificacao_exame_pronto_enviada' : 'notificacao_exame_pronto_falhou',
              performedByUserId: userId,
              performedByName: userName,
              details: JSON.stringify({
                appointmentId: item.appointmentId,
                statusLaudo: item.status,
                error: result.error || null,
              }),
            });
          } catch (notifyError: any) {
            request.log.warn({ err: notifyError, reportId: id }, 'Failed to notify patient about ready report');
          }
        })();
      }

      return item;
    } catch (err: any) {
      request.log.error({ err }, 'Failed to update report');
      return reply.code(400).send({ error: 'Failed to update report', details: err.message });
    }
  });

  app.delete('/:id', {
    schema: {
      summary: 'Delete report',
      tags: ['Reports'],
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
  }, async (request, reply) => {
    const { branchId, userId, userName } = await getLoggedUser(request);
    if (!branchId) return (reply as any).code(403).send({ error: 'User not associated with a branch' });

    const { id } = request.params as any;
    const existing = await prisma.report.findFirst({ where: { id, branchId } });
    if (!existing) return reply.code(404).send({ error: 'Report not found' });
    await prisma.report.delete({ where: { id } });
    await createAuditLog({
      branchId,
      reportId: id,
      action: 'laudo_excluido',
      performedByUserId: userId,
      performedByName: userName,
    });
    return { message: 'Deleted' };
  });
}


