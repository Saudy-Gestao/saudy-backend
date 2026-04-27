import { beforeEach, describe, expect, it, vi } from 'vitest';

const { parseDicomMock, prismaMock, uploadDicomToGcsMock } = vi.hoisted(() => ({
  parseDicomMock: vi.fn(),
  prismaMock: {
    dicomFile: {
      findFirst: vi.fn(),
      create: vi.fn(),
    },
    reportWorklistItem: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    mwlEntry: {
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    report: {
      findFirst: vi.fn(),
      update: vi.fn(),
      create: vi.fn(),
    },
    appointment: {
      findUnique: vi.fn(),
    },
  },
  uploadDicomToGcsMock: vi.fn(),
}));

vi.mock('uuid', () => ({ v4: vi.fn(() => 'uuid-1') }));

vi.mock('dicom-parser', () => ({
  default: {
    parseDicom: parseDicomMock,
  },
}));

vi.mock('../../src/modules/dicom/lib/prisma', () => ({
  default: prismaMock,
}));
vi.mock('../../src/modules/dicom/gcs', () => ({
  uploadDicomToGcs: uploadDicomToGcsMock,
}));

import { processDicomBuffer } from '../../src/modules/dicom/processor';

describe('dicom processor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    parseDicomMock.mockReturnValue({
      string: (tag: string) => ({
        x0020000d: 'study-uid',
        x0020000e: 'series-uid',
        x00100010: 'Maria^Silva',
        x00100020: '12345678900',
        x00080060: 'MR',
        x00080050: 'ACC-1',
        x00080020: '20260410',
      }[tag] || ''),
    });

    prismaMock.dicomFile.findFirst.mockResolvedValue(null);
    prismaMock.reportWorklistItem.findUnique.mockResolvedValue(null);
    prismaMock.reportWorklistItem.findFirst.mockResolvedValue(null);
    prismaMock.mwlEntry.findFirst.mockResolvedValue(null);
    prismaMock.mwlEntry.update.mockResolvedValue({});
    prismaMock.reportWorklistItem.create.mockResolvedValue({ id: 'w1', branchId: 'b1', appointmentId: null });
    prismaMock.reportWorklistItem.update.mockResolvedValue({ id: 'w1', branchId: 'b1', appointmentId: null });
    prismaMock.dicomFile.create.mockResolvedValue({});
    prismaMock.report.findFirst.mockResolvedValue(null);
    prismaMock.report.create.mockResolvedValue({});
    prismaMock.report.update.mockResolvedValue({});
    prismaMock.appointment.findUnique.mockResolvedValue(null);
    uploadDicomToGcsMock.mockResolvedValue(undefined);
  });

  it('returns existing item when instance already processed', async () => {
    prismaMock.dicomFile.findFirst.mockResolvedValueOnce({ worklistItemId: 'w-existing' });
    prismaMock.reportWorklistItem.findUnique.mockResolvedValueOnce({ id: 'w-existing' });

    const item = await processDicomBuffer(Buffer.from('abc'), 'b1', 'inst-1');

    expect(item).toEqual({ id: 'w-existing' });
    expect(uploadDicomToGcsMock).not.toHaveBeenCalled();
  });

  it('creates worklist/report and uploads dicom on normal flow', async () => {
    const item = await processDicomBuffer(Buffer.from('abc'), 'b1', 'inst-1');

    expect(uploadDicomToGcsMock).toHaveBeenCalledWith('ACC-1/uuid-1.dcm', Buffer.from('abc'));
    expect(prismaMock.reportWorklistItem.create).toHaveBeenCalled();
    expect(prismaMock.dicomFile.create).toHaveBeenCalled();
    expect(prismaMock.report.create).toHaveBeenCalled();
    expect(item.id).toBe('w1');
  });

  it('updates existing worklist and existing report when found', async () => {
    prismaMock.reportWorklistItem.findFirst
      .mockResolvedValueOnce({ id: 'w2', dicomPath: null, dicomUrl: null, dicomStudyUid: null, dicomSeriesUid: null, mwlEntryId: null, appointmentId: null, branchId: null });
    prismaMock.report.findFirst.mockResolvedValueOnce({ id: 'r1', branchId: null, exam: null, scheduledFor: null });

    await processDicomBuffer(Buffer.from('abc'), null, undefined);

    expect(prismaMock.reportWorklistItem.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'w2' } }));
    expect(prismaMock.report.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'r1' } }));
  });

  it('handles dicomFile create failure without throwing', async () => {
    prismaMock.dicomFile.create.mockRejectedValueOnce(new Error('dup'));

    await expect(processDicomBuffer(Buffer.from('abc'), 'b1', 'inst-1')).resolves.toBeTruthy();
  });

  it('continues processing when instance exists but worklist item is missing', async () => {
    prismaMock.dicomFile.findFirst.mockResolvedValueOnce({ worklistItemId: 'missing-item' });
    prismaMock.reportWorklistItem.findUnique.mockResolvedValueOnce(null);

    const item = await processDicomBuffer(Buffer.from('abc'), 'b1', 'inst-1');

    expect(uploadDicomToGcsMock).toHaveBeenCalled();
    expect(prismaMock.reportWorklistItem.create).toHaveBeenCalled();
    expect(item.id).toBe('w1');
  });

  it('uses sanitized fallback folder and looks up mwl by patient id when accession is missing', async () => {
    parseDicomMock.mockReturnValueOnce({
      string: (tag: string) => ({
        x0020000d: 'study-uid',
        x0020000e: 'series-uid',
        x00100010: 'Ana^Souza',
        x00100020: '99999999999',
        x00080060: 'CT',
        x00080050: '   ',
        x00080020: '20260411',
      }[tag] || ''),
    });
    prismaMock.mwlEntry.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'mwl-1', branchId: 'branch-from-mwl', appointmentId: null, patientCpf: '99999999999' });
    prismaMock.reportWorklistItem.create.mockResolvedValueOnce({ id: 'w2', branchId: 'branch-from-mwl', appointmentId: null });

    await processDicomBuffer(Buffer.from('abc'), null, undefined);

    expect(uploadDicomToGcsMock).toHaveBeenCalledWith('sem-accession-number/uuid-1.dcm', Buffer.from('abc'));
    expect(prismaMock.mwlEntry.update).toHaveBeenCalledWith({
      where: { id: 'mwl-1' },
      data: { status: 'adquirido' },
    });
    expect(prismaMock.reportWorklistItem.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          branchId: 'branch-from-mwl',
          mwlEntryId: 'mwl-1',
        }),
      }),
    );
  });

  it('falls back to externalStudyId and then mwlEntryId when finding existing worklist item', async () => {
    prismaMock.mwlEntry.findFirst.mockResolvedValueOnce({
      id: 'mwl-2',
      branchId: 'mwl-branch',
      appointmentId: 'appt-2',
      patientCpf: '12345678900',
    });
    prismaMock.reportWorklistItem.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: 'w-existing',
        dicomPath: null,
        dicomUrl: null,
        dicomStudyUid: null,
        dicomSeriesUid: null,
        mwlEntryId: null,
        appointmentId: null,
        branchId: null,
      });

    await processDicomBuffer(Buffer.from('abc'), null, undefined);

    expect(prismaMock.reportWorklistItem.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'w-existing' },
      }),
    );
  });

  it('creates report using appointment data priority over mwl and dicom metadata', async () => {
    parseDicomMock.mockReturnValueOnce({
      string: (tag: string) => ({
        x0020000d: 'study-uid',
        x0020000e: 'series-uid',
        x00100010: 'Dicom^Patient',
        x00100020: '11111111111',
        x00080060: 'US',
        x00080050: 'ACC-2',
        x00080020: '20260412',
      }[tag] || ''),
    });
    prismaMock.mwlEntry.findFirst.mockResolvedValueOnce({
      id: 'mwl-3',
      branchId: 'mwl-branch',
      appointmentId: 'appt-3',
      patientName: 'Mwl Name',
      patientCpf: '22222222222',
      examType: 'XR',
      requestingDoctor: 'Dr Mwl',
    });
    prismaMock.reportWorklistItem.create.mockResolvedValueOnce({ id: 'w3', branchId: 'mwl-branch', appointmentId: 'appt-3' });
    prismaMock.appointment.findUnique.mockResolvedValueOnce({
      patientName: 'Appointment Name',
      patientCpf: '33333333333',
      doctorName: 'Dr Appointment',
    });

    await processDicomBuffer(Buffer.from('abc'), null, undefined);

    expect(prismaMock.report.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          patientName: 'Appointment Name',
          cpf: '33333333333',
          requestingDoctor: 'Dr Appointment',
          exam: 'XR',
        }),
      }),
    );
  });

  it('does not update existing report when all enrichable fields are already filled', async () => {
    prismaMock.reportWorklistItem.findFirst.mockResolvedValueOnce({
      id: 'w4',
      dicomPath: 'already-set',
      dicomUrl: '/dicom/existing/file',
      dicomStudyUid: 'study-uid',
      dicomSeriesUid: 'series-uid',
      mwlEntryId: 'mwl-4',
      appointmentId: 'appt-4',
      branchId: 'b4',
    });
    prismaMock.report.findFirst.mockResolvedValueOnce({
      id: 'r4',
      branchId: 'b4',
      exam: 'MR',
      scheduledFor: '10/04/2026',
    });

    await processDicomBuffer(Buffer.from('abc'), 'b4', undefined);

    expect(prismaMock.report.update).not.toHaveBeenCalled();
  });

  it('creates report with null scheduled date when dicom study date is missing', async () => {
    parseDicomMock.mockReturnValueOnce({
      string: (tag: string) => ({
        x0020000d: 'study-uid',
        x0020000e: 'series-uid',
        x00100010: 'No^Date',
        x00100020: '44444444444',
        x00080060: 'CR',
        x00080050: 'ACC-3',
        x00080020: '',
      }[tag] || ''),
    });

    await processDicomBuffer(Buffer.from('abc'), 'b1', undefined);

    expect(prismaMock.report.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          scheduledFor: null,
        }),
      }),
    );
  });

  it('swallows report upsert errors and still returns worklist item', async () => {
    prismaMock.report.findFirst.mockRejectedValueOnce(new Error('upsert-fail'));

    await expect(processDicomBuffer(Buffer.from('abc'), 'b1', undefined)).resolves.toEqual(
      expect.objectContaining({ id: 'w1' }),
    );
  });
});
