import { beforeEach, describe, expect, it, vi } from 'vitest';

const { parseDicomMock, prismaMock, findOrthancStudyIdMock } = vi.hoisted(() => ({
  parseDicomMock: vi.fn(),
  findOrthancStudyIdMock: vi.fn(),
  prismaMock: {
    reportWorklistItem: {
      count: vi.fn(),
    },
    dicomFile: {
      count: vi.fn(),
    },
    temporaryDicomStudy: {
      create: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
    },
  },
}));

vi.mock('dicom-parser', () => ({
  default: {
    parseDicom: parseDicomMock,
  },
}));

vi.mock('../../src/modules/dicom/lib/prisma', () => ({
  default: prismaMock,
}));

vi.mock('../../src/modules/dicom/orthanc', () => ({
  deleteOrthancStudy: vi.fn(),
  findOrthancStudyIdByDicomStudyUid: findOrthancStudyIdMock,
  postDicomInstance: vi.fn(),
}));

import { uploadTemporaryPriorStudy } from '../../src/modules/dicom/temporary-prior-studies';

describe('temporary prior dicom studies', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    parseDicomMock.mockReturnValue({
      string: (tag: string) => ({
        x0020000d: 'study-temp-1',
        x00100010: 'Maria^Silva',
        x00100020: '123',
        x00080060: 'CT',
        x00080020: '20260507',
      }[tag] || ''),
    });
    findOrthancStudyIdMock.mockResolvedValue('orthanc-existing-1');
    prismaMock.reportWorklistItem.count.mockResolvedValue(0);
    prismaMock.dicomFile.count.mockResolvedValue(0);
    prismaMock.temporaryDicomStudy.create.mockImplementation(async ({ data }: any) => ({
      id: 'tmp-1',
      ...data,
    }));
  });

  it('deletes pre-existing Orthanc study when it has no permanent system reference', async () => {
    const item = await uploadTemporaryPriorStudy({
      branchId: 'b-1',
      reportId: 'r-1',
      files: [{ fileName: 'prior.dcm', base64: Buffer.from('dicom').toString('base64') }],
    });

    expect(item.deleteFromOrthanc).toBe(true);
    expect(prismaMock.temporaryDicomStudy.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        orthancStudyId: 'orthanc-existing-1',
        studyInstanceUid: 'study-temp-1',
        deleteFromOrthanc: true,
      }),
    });
  });

  it('preserves pre-existing Orthanc study when it is referenced by permanent worklist data', async () => {
    prismaMock.reportWorklistItem.count.mockResolvedValueOnce(1);

    const item = await uploadTemporaryPriorStudy({
      branchId: 'b-1',
      reportId: 'r-1',
      files: [{ fileName: 'prior.dcm', base64: Buffer.from('dicom').toString('base64') }],
    });

    expect(item.deleteFromOrthanc).toBe(false);
  });
});
