import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import reportRoutes from '../../src/modules/care/routes/reports';
import prisma from '../../src/modules/care/lib/prisma';
import { isValidCpf, normalizeCpf } from '../../src/lib/cpf';
import { deleteOrthancStudy } from '../../src/modules/dicom/orthanc';
import { hasPermanentStudyReference, uploadTemporaryPriorStudy } from '../../src/modules/dicom/temporary-prior-studies';

vi.mock('../../src/modules/care/lib/prisma', () => ({
  default: {
    $transaction: vi.fn(),
    user: { findUnique: vi.fn() },
    doctor: { findMany: vi.fn() },
    reportConfig: { findFirst: vi.fn() },
    reportPublication: { findFirst: vi.fn(), create: vi.fn() },
    report: {
      findMany: vi.fn(),
      count: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    reportAuditLog: {
      create: vi.fn(),
      findFirst: vi.fn(),
    },
    temporaryDicomStudy: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
    },
  },
}));

vi.mock('../../src/lib/cpf', () => ({
  isValidCpf: vi.fn(),
  normalizeCpf: vi.fn(),
}));

vi.mock('../../src/modules/dicom/orthanc', () => ({
  deleteOrthancStudy: vi.fn(),
}));

vi.mock('../../src/modules/dicom/temporary-prior-studies', () => ({
  hasPermanentStudyReference: vi.fn(),
  uploadTemporaryPriorStudy: vi.fn(),
}));

const mockedPrisma = prisma as any;
const mockedIsValidCpf = isValidCpf as any;
const mockedNormalizeCpf = normalizeCpf as any;
const mockedDeleteOrthancStudy = deleteOrthancStudy as any;
const mockedHasPermanentStudyReference = hasPermanentStudyReference as any;
const mockedUploadTemporaryPriorStudy = uploadTemporaryPriorStudy as any;

async function buildApp(opts?: { unauthorized?: boolean }) {
  const app = Fastify();
  app.decorateRequest('user', null);
  app.decorateRequest('jwtVerify', async function jwtVerify(this: any) {
    if (opts?.unauthorized) throw new Error('unauthorized');
    this.user = { id: 'u-1' };
  });

  await app.register(reportRoutes, { prefix: '/reports' });
  return app;
}

describe('care reports routes', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockedNormalizeCpf.mockImplementation((value: string) => String(value || '').replace(/\D/g, ''));
    mockedIsValidCpf.mockReturnValue(true);
    mockedPrisma.user.findUnique.mockResolvedValue({
      id: 'u-1',
      name: 'Doc',
      sector: { branch: { id: 'b-1' } },
      doctor: { id: 'd-1', name: 'Doc Med' },
    });
    mockedPrisma.$transaction.mockImplementation(async (callback: any) => callback({
      report: { update: mockedPrisma.report.update },
      reportPublication: { create: mockedPrisma.reportPublication.create },
    }));
    mockedPrisma.doctor.findMany.mockResolvedValue([]);
    mockedPrisma.reportConfig.findFirst.mockResolvedValue({ requiresReviewer: true, reportLayout: null });
    mockedPrisma.reportPublication.findFirst.mockResolvedValue(null);
    mockedPrisma.reportPublication.create.mockResolvedValue({ id: 'rp-1', version: 1 });
    mockedPrisma.reportAuditLog.create.mockResolvedValue({});
    mockedPrisma.reportAuditLog.findFirst.mockResolvedValue(null);
    mockedPrisma.temporaryDicomStudy.findMany.mockResolvedValue([]);
    mockedPrisma.temporaryDicomStudy.findFirst.mockResolvedValue(null);
    mockedPrisma.temporaryDicomStudy.update.mockResolvedValue({});
    mockedDeleteOrthancStudy.mockResolvedValue(true);
    mockedHasPermanentStudyReference.mockResolvedValue(false);
  });

  it('handles auth and list/get', async () => {
    const unauth = await buildApp({ unauthorized: true });
    let res = await unauth.inject({ method: 'GET', url: '/reports' });
    expect(res.statusCode).toBe(401);
    await unauth.close();

    mockedPrisma.report.findMany.mockResolvedValue([{ id: 'r-1' }]);
    mockedPrisma.report.count.mockResolvedValue(1);
    mockedPrisma.report.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'r-1' });

    const app = await buildApp();
    res = await app.inject({ method: 'GET', url: '/reports?status=finalizado&search=maria' });
    expect(res.statusCode).toBe(200);
    expect(res.json().total).toBe(1);

    res = await app.inject({ method: 'GET', url: '/reports/r-1' });
    expect(res.statusCode).toBe(404);

    res = await app.inject({ method: 'GET', url: '/reports/r-1' });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('validates create report payload and handles create errors', async () => {
    const app = await buildApp();

    let res = await app.inject({
      method: 'POST',
      url: '/reports',
      payload: { patientName: '' },
    });
    expect(res.statusCode).toBe(400);

    mockedIsValidCpf.mockReturnValueOnce(false);
    res = await app.inject({
      method: 'POST',
      url: '/reports',
      payload: { patientName: 'Maria', cpf: '123', birthDate: '2000-01-01' },
    });
    expect(res.statusCode).toBe(400);

    res = await app.inject({
      method: 'POST',
      url: '/reports',
      payload: { patientName: 'Maria', cpf: '12345678901', birthDate: '20000101' },
    });
    expect(res.statusCode).toBe(400);

    mockedPrisma.report.create.mockRejectedValueOnce(new Error('boom')).mockResolvedValue({
      id: 'r-1',
      status: 'rascunho',
      patientName: 'Maria',
      exam: 'TC',
      requestingDoctor: null,
      reportingDoctor: null,
    });

    res = await app.inject({
      method: 'POST',
      url: '/reports',
      payload: { patientName: 'Maria', cpf: '12345678901', birthDate: '2000-01-01' },
    });
    expect(res.statusCode).toBe(400);

    await app.close();
  });

  it('creates report successfully', async () => {
    mockedPrisma.report.create.mockResolvedValue({
      id: 'r-1',
      status: 'rascunho',
      patientName: null,
      exam: null,
      requestingDoctor: null,
      reportingDoctor: null,
    });

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/reports',
      payload: { worklistItemId: 'w-1' },
    });

    expect(res.statusCode).toBe(201);
    await app.close();
  });

  it('updates report with validations and errors', async () => {
    mockedPrisma.report.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'r-1', status: 'rascunho', description: null, issuerSignedAt: null, reviewerSignedAt: null })
      .mockResolvedValueOnce({ id: 'r-1', status: 'rascunho', description: null, issuerSignedAt: null, reviewerSignedAt: null })
      .mockResolvedValueOnce({ id: 'r-1', status: 'rascunho', description: null, issuerSignedAt: null, reviewerSignedAt: null })
      .mockResolvedValueOnce({ id: 'r-1', status: 'finalizado', description: 'ok', issuerSignedAt: null, reviewerSignedAt: null });
    mockedPrisma.report.update
      .mockResolvedValueOnce({ id: 'r-1', status: 'finalizado', description: 'ok', issuerSignedAt: null, reviewerSignedAt: null, reportingDoctor: null, reviewingDoctor: null })
      .mockRejectedValueOnce(new Error('bad update'));

    const app = await buildApp();

    let res = await app.inject({ method: 'PUT', url: '/reports/r-1', payload: { status: 'finalizado' } });
    expect(res.statusCode).toBe(404);

    res = await app.inject({ method: 'PUT', url: '/reports/r-1', payload: { patientName: '   ' } });
    expect(res.statusCode).toBe(400);

    mockedIsValidCpf.mockReturnValueOnce(false);
    res = await app.inject({ method: 'PUT', url: '/reports/r-1', payload: { cpf: '123' } });
    expect(res.statusCode).toBe(400);

    res = await app.inject({ method: 'PUT', url: '/reports/r-1', payload: { description: 'novo' } });
    expect(res.statusCode).toBe(200);

    mockedPrisma.report.findFirst.mockResolvedValueOnce({
      id: 'r-1',
      status: 'finalizado',
      description: 'ok',
      issuerSignedAt: null,
      reviewerSignedAt: null,
    });
    res = await app.inject({ method: 'PUT', url: '/reports/r-1', payload: { description: 'novo-2' } });
    expect(res.statusCode).toBe(400);

    await app.close();
  });

  it('deletes report and handles not found', async () => {
    mockedPrisma.report.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'r-1' });
    mockedPrisma.report.delete.mockResolvedValue({});

    const app = await buildApp();

    let res = await app.inject({ method: 'DELETE', url: '/reports/r-1' });
    expect(res.statusCode).toBe(404);

    res = await app.inject({ method: 'DELETE', url: '/reports/r-1' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ message: 'Deleted' });

    await app.close();
  });

  it('uploads, lists and deletes temporary prior DICOM studies', async () => {
    const expiresAt = new Date('2026-05-07T20:00:00Z');
    const tempStudy = {
      id: 'tmp-1',
      reportId: 'r-1',
      branchId: 'b-1',
      orthancStudyId: 'orthanc-1',
      studyInstanceUid: 'study-1',
      instancesCount: 2,
      expiresAt,
      deleteFromOrthanc: false,
    };

    mockedPrisma.report.findFirst.mockResolvedValue({ id: 'r-1', patientName: 'Maria', cpf: '12345678901', exam: 'TC' });
    mockedUploadTemporaryPriorStudy.mockResolvedValue(tempStudy);
    mockedPrisma.temporaryDicomStudy.findMany.mockResolvedValue([tempStudy]);
    mockedPrisma.temporaryDicomStudy.findFirst.mockResolvedValue(tempStudy);
    mockedPrisma.temporaryDicomStudy.update.mockResolvedValue({ ...tempStudy, deletedAt: new Date() });

    const app = await buildApp();

    let res = await app.inject({
      method: 'POST',
      url: '/reports/r-1/temporary-prior-studies',
      payload: { filesBase64: ['ZGljb20='], description: 'Comparativo externo' },
    });
    expect(res.statusCode).toBe(201);
    expect(mockedUploadTemporaryPriorStudy).toHaveBeenCalledWith(expect.objectContaining({
      branchId: 'b-1',
      reportId: 'r-1',
      files: [{ fileName: 'dicom-1.dcm', base64: 'ZGljb20=' }],
    }));
    expect(res.json().viewer.dicomWebStudyPath).toBe('/dicom-web/studies/study-1');

    res = await app.inject({
      method: 'POST',
      url: '/reports/r-1/temporary-prior-studies',
      payload: { zipBase64: 'emlw', description: 'ZIP externo' },
    });
    expect(res.statusCode).toBe(201);
    expect(mockedUploadTemporaryPriorStudy).toHaveBeenCalledWith(expect.objectContaining({
      branchId: 'b-1',
      reportId: 'r-1',
      files: [],
      zipBase64: 'emlw',
    }));

    res = await app.inject({ method: 'GET', url: '/reports/r-1/temporary-prior-studies' });
    expect(res.statusCode).toBe(200);
    expect(res.json().total).toBe(1);

    res = await app.inject({ method: 'DELETE', url: '/reports/r-1/temporary-prior-studies/tmp-1' });
    expect(res.statusCode).toBe(200);
    expect(mockedHasPermanentStudyReference).toHaveBeenCalledWith('study-1');
    expect(mockedDeleteOrthancStudy).toHaveBeenCalledWith('orthanc-1');

    await app.close();
  });

  it('validates temporary prior DICOM study upload and delete errors', async () => {
    mockedPrisma.report.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'r-1' }).mockResolvedValueOnce({ id: 'r-1' });
    mockedUploadTemporaryPriorStudy.mockRejectedValueOnce(new Error('invalid dicom'));
    mockedPrisma.temporaryDicomStudy.findFirst.mockResolvedValueOnce(null);

    const app = await buildApp();

    let res = await app.inject({
      method: 'POST',
      url: '/reports/r-missing/temporary-prior-studies',
      payload: { filesBase64: ['ZGljb20='] },
    });
    expect(res.statusCode).toBe(404);

    res = await app.inject({
      method: 'POST',
      url: '/reports/r-1/temporary-prior-studies',
      payload: {},
    });
    expect(res.statusCode).toBe(400);

    res = await app.inject({
      method: 'POST',
      url: '/reports/r-1/temporary-prior-studies',
      payload: { files: [{ base64: 'bad' }] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().details).toBe('invalid dicom');

    res = await app.inject({ method: 'DELETE', url: '/reports/r-1/temporary-prior-studies/nope' });
    expect(res.statusCode).toBe(404);

    await app.close();
  });

  it('covers audit action and audit details branches', async () => {
    const app = await buildApp();

    const baseUpdated = { id: 'r-1', status: 'rascunho', description: null, issuerSignedAt: null, reviewerSignedAt: null, reportingDoctor: null, reviewingDoctor: null };

    // laudo_desfinalizado: existing.status = 'finalizado', new status != 'finalizado'
    mockedPrisma.report.findFirst.mockResolvedValueOnce({ id: 'r-1', status: 'finalizado', description: null, issuerSignedAt: null, reviewerSignedAt: null });
    mockedPrisma.report.update.mockResolvedValueOnce({ ...baseUpdated, status: 'rascunho' });
    let res = await app.inject({ method: 'PUT', url: '/reports/r-1', payload: { status: 'rascunho' } });
    expect(res.statusCode).toBe(200);
    expect(mockedPrisma.reportAuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'laudo_desfinalizado' }) }),
    );

    // laudo_status_alterado: both non-finalizado
    mockedPrisma.report.findFirst.mockResolvedValueOnce({ id: 'r-1', status: 'rascunho', description: null, issuerSignedAt: null, reviewerSignedAt: null });
    mockedPrisma.report.update.mockResolvedValueOnce({ ...baseUpdated, status: 'em_andamento' });
    res = await app.inject({ method: 'PUT', url: '/reports/r-1', payload: { status: 'em_andamento' } });
    expect(res.statusCode).toBe(200);
    expect(mockedPrisma.reportAuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'laudo_status_alterado' }) }),
    );

    // laudo_assinado_emissor: issuerSignedAt set, existing.issuerSignedAt = null
    mockedPrisma.report.findFirst.mockResolvedValueOnce({ id: 'r-1', status: 'rascunho', description: null, issuerSignedAt: null, reviewerSignedAt: null });
    mockedPrisma.report.update.mockResolvedValueOnce({ ...baseUpdated, issuerSignedAt: '2026-04-13T10:00:00Z' });
    res = await app.inject({ method: 'PUT', url: '/reports/r-1', payload: { issuerSignedAt: '2026-04-13T10:00:00Z' } });
    expect(res.statusCode).toBe(200);
    expect(mockedPrisma.reportAuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'laudo_assinado_emissor' }) }),
    );

    // laudo_assinado_revisor: reviewerSignedAt set, existing.reviewerSignedAt = null
    mockedPrisma.report.findFirst.mockResolvedValueOnce({ id: 'r-1', status: 'rascunho', description: null, issuerSignedAt: null, reviewerSignedAt: null });
    mockedPrisma.report.update.mockResolvedValueOnce({ ...baseUpdated, reviewerSignedAt: '2026-04-13T12:00:00Z' });
    res = await app.inject({ method: 'PUT', url: '/reports/r-1', payload: { reviewerSignedAt: '2026-04-13T12:00:00Z' } });
    expect(res.statusCode).toBe(200);
    expect(mockedPrisma.reportAuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'laudo_assinado_revisor' }) }),
    );

    // Changed description: auditDetails.conteudoAnterior / conteudoNovo
    mockedPrisma.report.findFirst.mockResolvedValueOnce({ id: 'r-1', status: 'rascunho', description: 'antigo', issuerSignedAt: null, reviewerSignedAt: null });
    mockedPrisma.report.update.mockResolvedValueOnce({ ...baseUpdated, description: 'novo' });
    res = await app.inject({ method: 'PUT', url: '/reports/r-1', payload: { description: 'novo' } });
    expect(res.statusCode).toBe(200);
    const detailsWithDesc = JSON.parse(mockedPrisma.reportAuditLog.create.mock.calls.at(-1)[0].data.details);
    expect(detailsWithDesc.conteudoAnterior).toBe('antigo');
    expect(detailsWithDesc.conteudoNovo).toBe('novo');

    // Item with issuerSignedAt truthy → medicoEmissor branch uses reportingDoctor
    mockedPrisma.report.findFirst.mockResolvedValueOnce({ id: 'r-1', status: 'rascunho', description: null, issuerSignedAt: null, reviewerSignedAt: null });
    mockedPrisma.report.update.mockResolvedValueOnce({
      ...baseUpdated,
      issuerSignedAt: '2026-04-13T10:00:00Z',
      reviewerSignedAt: '2026-04-13T11:00:00Z',
      reportingDoctor: 'Dr Emissor',
      reviewingDoctor: 'Dr Revisor',
    });
    res = await app.inject({ method: 'PUT', url: '/reports/r-1', payload: { issuerSignedAt: '2026-04-13T10:00:00Z', reviewerSignedAt: '2026-04-13T11:00:00Z' } });
    expect(res.statusCode).toBe(200);
    const detailsWithDoctors = JSON.parse(mockedPrisma.reportAuditLog.create.mock.calls.at(-1)[0].data.details);
    expect(detailsWithDoctors.medicoEmissor).toBe('Dr Emissor');
    expect(detailsWithDoctors.medicoRevisor).toBe('Dr Revisor');

    // issuerSignedAt truthy, reportingDoctor = null → medicoEmissor remains null
    mockedPrisma.report.findFirst.mockResolvedValueOnce({ id: 'r-1', status: 'rascunho', description: null, issuerSignedAt: null, reviewerSignedAt: null });
    mockedPrisma.report.update.mockResolvedValueOnce({
      ...baseUpdated,
      issuerSignedAt: '2026-04-13T10:00:00Z',
      reviewerSignedAt: '2026-04-13T11:00:00Z',
      reportingDoctor: null,
      reviewingDoctor: null,
    });
    res = await app.inject({ method: 'PUT', url: '/reports/r-1', payload: { issuerSignedAt: '2026-04-13T10:00:00Z', reviewerSignedAt: '2026-04-13T11:00:00Z' } });
    expect(res.statusCode).toBe(200);
    const detailsNoDoc = JSON.parse(mockedPrisma.reportAuditLog.create.mock.calls.at(-1)[0].data.details);
    expect(detailsNoDoc.medicoEmissor).toBeNull();

    // valid cpf on PUT → covers data.cpf = digits branch
    mockedPrisma.report.findFirst.mockResolvedValueOnce({ id: 'r-1', status: 'rascunho', description: null, issuerSignedAt: null, reviewerSignedAt: null });
    mockedPrisma.report.update.mockResolvedValueOnce({ ...baseUpdated });
    res = await app.inject({ method: 'PUT', url: '/reports/r-1', payload: { cpf: '12345678901' } });
    expect(res.statusCode).toBe(200);
    expect(mockedNormalizeCpf).toHaveBeenCalledWith('12345678901');

    await app.close();
  });
});
