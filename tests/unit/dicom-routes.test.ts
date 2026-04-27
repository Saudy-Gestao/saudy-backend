import { Readable } from 'stream';
import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import dicomRoutes from '../../src/modules/dicom/routes';
import prisma from '../../src/modules/dicom/lib/prisma';
import { processDicomBuffer } from '../../src/modules/dicom/processor';
import { getDicomStreamFromGcs } from '../../src/modules/dicom/gcs';
import { ensureOrthancStudyFromGcs } from '../../src/modules/dicom/orthanc';

vi.mock('../../src/modules/dicom/lib/prisma', () => ({
  default: {
    user: { findUnique: vi.fn() },
    reportWorklistItem: { findFirst: vi.fn() },
    dicomFile: { findFirst: vi.fn(), findMany: vi.fn(), findUnique: vi.fn() },
  },
}));

vi.mock('../../src/modules/dicom/processor', () => ({
  processDicomBuffer: vi.fn(),
}));

vi.mock('../../src/modules/dicom/gcs', () => ({
  getDicomStreamFromGcs: vi.fn(),
}));

vi.mock('../../src/modules/dicom/orthanc', () => ({
  ensureOrthancStudyFromGcs: vi.fn(),
}));

const mockedPrisma = prisma as any;
const mockedProcessDicomBuffer = processDicomBuffer as any;
const mockedGetDicomStreamFromGcs = getDicomStreamFromGcs as any;
const mockedEnsureOrthancStudyFromGcs = ensureOrthancStudyFromGcs as any;

async function buildApp(authenticated = true) {
  const app = Fastify();
  app.decorateRequest('user', null);
  app.decorateRequest('jwtVerify', async function jwtVerify(this: any) {
    if (!authenticated) throw new Error('unauthorized');
    this.user = { id: 'user-1' };
  });
  await app.register(dicomRoutes, { prefix: '/dicom' });
  return app;
}

describe('dicom routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedPrisma.user.findUnique.mockResolvedValue({ sector: { branch: { id: 'branch-1' } } });
  });

  it('returns 401 when unauthorized', async () => {
    const app = await buildApp(false);
    const res = await app.inject({ method: 'GET', url: '/dicom/abc/files' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('accepts array payload and processes uploaded dicom', async () => {
    mockedProcessDicomBuffer.mockResolvedValue({ id: 'item-1' });
    const app = await buildApp(true);

    const res = await app.inject({
      method: 'POST',
      url: '/dicom/',
      payload: { base64: [Buffer.from('abc').toString('base64')] },
    });
    expect(res.statusCode).toBe(200);
    expect(mockedProcessDicomBuffer).toHaveBeenCalled();
    await app.close();
  });

  it('returns 500 when upload processing fails', async () => {
    mockedProcessDicomBuffer.mockRejectedValue(new Error('boom'));
    const app = await buildApp(true);

    const res = await app.inject({
      method: 'POST',
      url: '/dicom/',
      payload: { base64: [Buffer.from('abc').toString('base64')] },
    });
    expect(res.statusCode).toBe(500);
    expect(mockedProcessDicomBuffer).toHaveBeenCalled();
    await app.close();
  });

  it('handles ensure-orthanc flow (404, 400 and success)', async () => {
    const app = await buildApp(true);

    mockedPrisma.reportWorklistItem.findFirst.mockResolvedValueOnce(null);
    let res = await app.inject({ method: 'POST', url: '/dicom/x/ensure-orthanc' });
    expect(res.statusCode).toBe(404);

    mockedPrisma.reportWorklistItem.findFirst.mockResolvedValueOnce({ id: 'w1', dicomStudyUid: null });
    mockedPrisma.dicomFile.findFirst.mockResolvedValueOnce(null);
    res = await app.inject({ method: 'POST', url: '/dicom/x/ensure-orthanc' });
    expect(res.statusCode).toBe(400);

    mockedPrisma.reportWorklistItem.findFirst.mockResolvedValueOnce({ id: 'w1', dicomStudyUid: 'study-1' });
    mockedEnsureOrthancStudyFromGcs.mockResolvedValueOnce({ status: 'cache_hit', orthancStudyId: 'o1', uploadedInstances: 0 });
    res = await app.inject({ method: 'POST', url: '/dicom/x/ensure-orthanc' });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('cache_hit');

    mockedPrisma.reportWorklistItem.findFirst.mockResolvedValueOnce({ id: 'w1', dicomStudyUid: 'study-2' });
    mockedEnsureOrthancStudyFromGcs.mockRejectedValueOnce(new Error('orthanc-fail'));
    res = await app.inject({ method: 'POST', url: '/dicom/x/ensure-orthanc' });
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toBe('Failed to prepare study in Orthanc');

    await app.close();
  });

  it('serves and lists dicom files', async () => {
    const app = await buildApp(true);

    mockedPrisma.reportWorklistItem.findFirst.mockResolvedValue({ id: 'w1', dicomStudyUid: 's1' });
    mockedPrisma.dicomFile.findFirst.mockResolvedValue({ id: 'f1', path: 'p1' });
    mockedGetDicomStreamFromGcs.mockReturnValue(Readable.from(['dicom-data']));

    let res = await app.inject({ method: 'GET', url: '/dicom/x/file' });
    expect(res.statusCode).toBe(200);

    mockedPrisma.reportWorklistItem.findFirst.mockResolvedValueOnce({ id: 'w1' });
    mockedPrisma.dicomFile.findMany.mockResolvedValueOnce([
      { id: 'f1', seriesUid: 'sA', instanceId: 'i1', createdAt: new Date() },
      { id: 'f2', seriesUid: 'sB', instanceId: 'i2', createdAt: new Date() },
    ]);
    res = await app.inject({ method: 'GET', url: '/dicom/x/files?view=instances' });
    expect(res.statusCode).toBe(200);
    expect(res.json().files).toHaveLength(2);

    mockedPrisma.reportWorklistItem.findFirst.mockResolvedValueOnce({ id: 'w1' });
    mockedPrisma.dicomFile.findMany.mockResolvedValueOnce([
      { id: 'f3', seriesUid: null, instanceId: 'i3', createdAt: new Date() },
    ]);
    res = await app.inject({ method: 'GET', url: '/dicom/x/files?seriesUid=__NO_SERIES__' });
    expect(res.statusCode).toBe(200);
    expect(res.json().seriesUid).toBeNull();
    expect(res.json().files).toHaveLength(1);

    mockedPrisma.reportWorklistItem.findFirst.mockResolvedValueOnce({ id: 'w1' });
    mockedPrisma.dicomFile.findMany.mockResolvedValueOnce([
      { id: 'f1', seriesUid: 'sA', instanceId: 'i1', createdAt: new Date() },
      { id: 'f2', seriesUid: 'sA', instanceId: 'i2', createdAt: new Date() },
    ]);
    res = await app.inject({ method: 'GET', url: '/dicom/x/files?view=series' });
    expect(res.statusCode).toBe(200);
    expect(res.json().series).toHaveLength(1);

    mockedPrisma.reportWorklistItem.findFirst.mockResolvedValueOnce({ id: 'w1' });
    mockedPrisma.dicomFile.findMany.mockResolvedValueOnce([
      { id: 'f1', seriesUid: 'sA', instanceId: 'i1' },
    ]);
    res = await app.inject({ method: 'GET', url: '/dicom/x/series/sA/files' });
    expect(res.statusCode).toBe(200);
    expect(res.json().files).toHaveLength(1);

    mockedPrisma.dicomFile.findUnique.mockResolvedValueOnce({ id: 'f1', path: 'p1' });
    mockedGetDicomStreamFromGcs.mockReturnValueOnce(Readable.from(['dicom-data']));
    res = await app.inject({ method: 'GET', url: '/dicom/file/f1' });
    expect(res.statusCode).toBe(200);

    await app.close();
  });

  it('returns 404 when records or streams are missing', async () => {
    const app = await buildApp(true);

    mockedPrisma.reportWorklistItem.findFirst.mockResolvedValueOnce(null);
    let res = await app.inject({ method: 'GET', url: '/dicom/x/file' });
    expect(res.statusCode).toBe(404);

    mockedPrisma.reportWorklistItem.findFirst.mockResolvedValueOnce({ id: 'w1' });
    mockedPrisma.dicomFile.findFirst.mockResolvedValueOnce(null);
    res = await app.inject({ method: 'GET', url: '/dicom/x/file' });
    expect(res.statusCode).toBe(404);

    mockedPrisma.reportWorklistItem.findFirst.mockResolvedValueOnce({ id: 'w1' });
    mockedPrisma.dicomFile.findFirst.mockResolvedValueOnce({ id: 'f1', path: 'p1' });
    mockedGetDicomStreamFromGcs.mockImplementationOnce(() => {
      throw new Error('missing');
    });
    res = await app.inject({ method: 'GET', url: '/dicom/x/file' });
    expect(res.statusCode).toBe(404);

    mockedPrisma.dicomFile.findUnique.mockResolvedValueOnce(null);
    res = await app.inject({ method: 'GET', url: '/dicom/file/nope' });
    expect(res.statusCode).toBe(404);

    mockedPrisma.dicomFile.findUnique.mockResolvedValueOnce({ id: 'f1', path: 'p1' });
    mockedGetDicomStreamFromGcs.mockImplementationOnce(() => {
      throw new Error('missing');
    });
    res = await app.inject({ method: 'GET', url: '/dicom/file/f1' });
    expect(res.statusCode).toBe(404);

    mockedPrisma.reportWorklistItem.findFirst.mockResolvedValueOnce(null);
    res = await app.inject({ method: 'GET', url: '/dicom/x/files' });
    expect(res.statusCode).toBe(404);

    mockedPrisma.reportWorklistItem.findFirst.mockResolvedValueOnce(null);
    res = await app.inject({ method: 'GET', url: '/dicom/x/series/sA/files' });
    expect(res.statusCode).toBe(404);

    await app.close();
  });

  it('covers upload processing and additional listing branches', async () => {
    const app = await buildApp(true);

    mockedPrisma.user.findUnique.mockResolvedValueOnce(null);
    mockedProcessDicomBuffer.mockResolvedValueOnce({ id: 'ok-1' });
    let res = await app.inject({
      method: 'POST',
      url: '/dicom/',
      payload: { base64: Buffer.from('abc').toString('base64') },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().items).toHaveLength(1);

    mockedProcessDicomBuffer.mockRejectedValueOnce(new Error('process-fail'));
    res = await app.inject({
      method: 'POST',
      url: '/dicom/',
      payload: { base64: Buffer.from('abc').toString('base64') },
    });
    expect(res.statusCode).toBe(500);

    mockedPrisma.reportWorklistItem.findFirst.mockResolvedValueOnce({ id: 'w1' });
    mockedPrisma.dicomFile.findMany.mockResolvedValueOnce([
      { id: 'f1', seriesUid: 'sA', instanceId: 'i1', createdAt: new Date() },
      { id: 'f2', seriesUid: 'sA', instanceId: 'i2', createdAt: new Date() },
      { id: 'f3', seriesUid: 'sB', instanceId: 'i3', createdAt: new Date() },
    ]);
    res = await app.inject({ method: 'GET', url: '/dicom/x/files?view=series&includeInstances=false' });
    expect(res.statusCode).toBe(200);
    expect(res.json().series[0].instances).toEqual([]);

    mockedPrisma.reportWorklistItem.findFirst.mockResolvedValueOnce({ id: 'w1' });
    mockedPrisma.dicomFile.findMany.mockResolvedValueOnce([
      { id: 'f1', seriesUid: 'sA', instanceId: 'i1', createdAt: new Date() },
      { id: 'f2', seriesUid: 'sB', instanceId: 'i2', createdAt: new Date() },
    ]);
    res = await app.inject({ method: 'GET', url: '/dicom/x/files?seriesUid=sA' });
    expect(res.statusCode).toBe(200);
    expect(res.json().files).toHaveLength(1);
    expect(res.json().seriesUid).toBe('sA');

    mockedPrisma.reportWorklistItem.findFirst.mockResolvedValueOnce({ id: 'w1' });
    mockedPrisma.dicomFile.findMany.mockResolvedValueOnce([
      { id: 'fN', seriesUid: null, instanceId: 'i9' },
    ]);
    res = await app.inject({ method: 'GET', url: '/dicom/x/series/__NO_SERIES__/files' });
    expect(res.statusCode).toBe(200);
    expect(res.json().seriesUid).toBeNull();

    await app.close();
  });
});
