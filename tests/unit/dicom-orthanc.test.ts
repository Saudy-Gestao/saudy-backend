import { beforeEach, describe, expect, it, vi } from 'vitest';

const { prismaMock, processDicomBufferMock, downloadDicomFromGcsMock } = vi.hoisted(() => ({
  prismaMock: {
    dicomFile: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
    },
    orthancStudy: {
      findMany: vi.fn(),
      delete: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
    },
  },
  processDicomBufferMock: vi.fn(),
  downloadDicomFromGcsMock: vi.fn(),
}));

vi.mock('../../src/modules/dicom/lib/prisma', () => ({ default: prismaMock }));

vi.mock('../../src/modules/dicom/processor', () => ({ processDicomBuffer: processDicomBufferMock }));

vi.mock('../../src/modules/dicom/gcs', () => ({ downloadDicomFromGcs: downloadDicomFromGcsMock }));

import {
  ensureOrthancStudyFromGcs,
  findOrthancStudyIdByDicomStudyUid,
  startOrthancPoller,
} from '../../src/modules/dicom/orthanc';

describe('dicom orthanc', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it('finds orthanc study by study uid', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: vi.fn().mockResolvedValue(['orthanc-1']) }));

    const id = await findOrthancStudyIdByDicomStudyUid('study-1');
    expect(id).toBe('orthanc-1');
  });

  it('ensures study with cache hit', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: vi.fn().mockResolvedValue(['orthanc-1']) }));

    const result = await ensureOrthancStudyFromGcs('study-1');
    expect(result.status).toBe('cache_hit');
    expect(result.uploadedInstances).toBe(0);
  });

  it('rehydrates study from gcs when missing in orthanc', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: vi.fn().mockResolvedValue([]) })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true, json: vi.fn().mockResolvedValue(['orthanc-2']) });
    vi.stubGlobal('fetch', fetchMock);

    prismaMock.dicomFile.findMany.mockResolvedValue([
      { id: 'f1', path: 'p1' },
      { id: 'f2', path: 'p2' },
    ]);
    downloadDicomFromGcsMock.mockResolvedValue(Buffer.from('dicom-data'));

    const result = await ensureOrthancStudyFromGcs('study-2');

    expect(result.status).toBe('cache_miss_rehydrated');
    expect(result.uploadedInstances).toBe(2);
    expect(downloadDicomFromGcsMock).toHaveBeenCalledTimes(2);
  });

  it('throws when no archived files are found', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: vi.fn().mockResolvedValue([]) }));
    prismaMock.dicomFile.findMany.mockResolvedValue([]);

    await expect(ensureOrthancStudyFromGcs('study-3')).rejects.toThrow('No archived files found for study study-3');
  });

  it('starts orthanc poller and processes new instances', async () => {
    vi.useFakeTimers();

    const fetchMock = vi
      .fn()
      // poll studies
      .mockResolvedValueOnce({ ok: true, json: vi.fn().mockResolvedValue(['study-a']) })
      // study instances
      .mockResolvedValueOnce({ ok: true, json: vi.fn().mockResolvedValue([{ ID: 'inst-1' }]) })
      // instance file
      .mockResolvedValueOnce({ ok: true, arrayBuffer: vi.fn().mockResolvedValue(Buffer.from('dicom').buffer) })
      // cleanup delete
      .mockResolvedValue({ ok: true, status: 200, json: vi.fn().mockResolvedValue([]) });
    vi.stubGlobal('fetch', fetchMock);

    prismaMock.dicomFile.findFirst.mockResolvedValue(null);
    prismaMock.orthancStudy.findUnique.mockResolvedValue(null);
    prismaMock.orthancStudy.create.mockResolvedValue({});
    prismaMock.orthancStudy.findMany.mockResolvedValue([]);
    processDicomBufferMock.mockResolvedValue({});

    startOrthancPoller();
    await vi.runOnlyPendingTimersAsync();

    expect(processDicomBufferMock).toHaveBeenCalled();
  });
});
