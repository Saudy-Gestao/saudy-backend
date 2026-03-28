import { v4 as uuidv4 } from 'uuid';
import dicomParser from 'dicom-parser';
import prisma from './lib/prisma';
import { uploadDicomToGcs } from './gcs';

export interface ParsedDicomData {
  studyInstanceUid: string;
  seriesInstanceUid: string;
  patientName: string;
  patientId: string;
  modality: string;
  studyDate: string;
  accessionNumber: string;
}

function sanitizeObjectPathSegment(value: string): string {
  return value
    .trim()
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

// images are stored exclusively in a GCS bucket; no local directory used
export async function processDicomBuffer(
  buffer: Buffer,
  branchId: string | null,
  instanceId?: string,
): Promise<any /* ReportWorklistItem */> {
  // --- Deduplication guard: if instanceId is known, skip entirely if already processed ---
  // This must happen BEFORE the GCS upload to avoid orphaned files when the poller
  // fires multiple overlapping cycles during bulk ingestion.
  if (instanceId) {
    const existing = await prisma.dicomFile.findFirst({ where: { instanceId } });
    if (existing) {
      const item = await prisma.reportWorklistItem.findUnique({ where: { id: existing.worklistItemId } });
      if (item) return item;
    }
  }
  // parse minimal metadata
  const byteArray = new Uint8Array(buffer);
  const dataSet = dicomParser.parseDicom(byteArray);

  const studyInstanceUid = dataSet.string('x0020000d') || '';
  const seriesInstanceUid = dataSet.string('x0020000e') || '';
  const patientName = (dataSet.string('x00100010') || '').replace(/\^/g, ' ');
  const patientId = dataSet.string('x00100020') || '';
  const modality = dataSet.string('x00080060') || '';
  const accessionNumber = dataSet.string('x00080050') || '';
  const studyDateRaw = dataSet.string('x00080020') || '';
  const studyDate = studyDateRaw
    ? `${studyDateRaw.slice(6, 8)}/${studyDateRaw.slice(4, 6)}/${studyDateRaw.slice(0, 4)}`
    : '';

  // always upload to GCS, grouped by accession number (folder-like prefix)
  const accessionFolder = sanitizeObjectPathSegment(accessionNumber) || 'sem-accession-number';
  const objectName = `${accessionFolder}/${uuidv4()}.dcm`;
  await uploadDicomToGcs(objectName, buffer);
  const fullPath = objectName; // store object name in database

  // compute url for retrieval (we serve through our own route)
  const dicomUrl = `/dicom/${studyInstanceUid || fullPath}/file`;

  // --- Step 1: correlate with MwlEntry (the appointment-driven worklist) ---
  let mwlEntry: any = null;

  if (accessionNumber) {
    mwlEntry = await prisma.mwlEntry.findFirst({
      where: { accessionNumber, isActive: true },
    });
  }

  if (!mwlEntry && patientId) {
    mwlEntry = await prisma.mwlEntry.findFirst({
      where: {
        patientCpf: patientId,
        isActive: true,
        status: { not: 'cancelado' },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  if (mwlEntry) {
    await prisma.mwlEntry.update({
      where: { id: mwlEntry.id },
      data: { status: 'adquirido' },
    });
  }

  // Orthanc poller calls this with null branchId.
  // In this case, inherit branch from the matched MWL entry.
  const effectiveBranchId = branchId || mwlEntry?.branchId || null;

  // --- Step 2: find or create ReportWorklistItem (DICOM index) ---
  let item: any = null;

  if (studyInstanceUid) {
    item = await prisma.reportWorklistItem.findFirst({
      where: { dicomStudyUid: studyInstanceUid },
    });
  }

  if (!item && studyInstanceUid) {
    item = await prisma.reportWorklistItem.findFirst({
      where: { externalStudyId: studyInstanceUid },
    });
  }

  if (!item && mwlEntry) {
    item = await prisma.reportWorklistItem.findFirst({
      where: { mwlEntryId: mwlEntry.id },
    });
  }

  const now = new Date();
  if (item) {
    const updateData: any = { dicomReceivedAt: now };
    if (!item.dicomPath) updateData.dicomPath = fullPath;
    if (!item.dicomUrl) updateData.dicomUrl = dicomUrl;
    if (!item.dicomStudyUid && studyInstanceUid) updateData.dicomStudyUid = studyInstanceUid;
    if (!item.dicomSeriesUid && seriesInstanceUid) updateData.dicomSeriesUid = seriesInstanceUid;
    if (!item.mwlEntryId && mwlEntry) updateData.mwlEntryId = mwlEntry.id;
    if (!item.appointmentId && mwlEntry?.appointmentId) updateData.appointmentId = mwlEntry.appointmentId;
    if (!item.branchId && effectiveBranchId) updateData.branchId = effectiveBranchId;

    item = await prisma.reportWorklistItem.update({ where: { id: item.id }, data: updateData });
  } else {
    item = await prisma.reportWorklistItem.create({
      data: {
        branchId: effectiveBranchId,
        mwlEntryId: mwlEntry?.id || null,
        appointmentId: mwlEntry?.appointmentId || null,
        patientCpf: patientId || mwlEntry?.patientCpf || null,
        accessionNumber: accessionNumber || null,
        dicomStudyUid: studyInstanceUid || undefined,
        dicomSeriesUid: seriesInstanceUid || undefined,
        dicomPath: fullPath,
        dicomUrl,
        dicomReceivedAt: now,
      },
    });
  }

  // --- Step 3: index the DICOM file ---
  try {
    await prisma.dicomFile.create({
      data: {
        worklistItemId: item.id,
        studyUid: studyInstanceUid || undefined,
        seriesUid: seriesInstanceUid || undefined,
        path: fullPath,
        instanceId: instanceId || undefined,
      },
    });
  } catch (err) {
    console.warn('failed to insert dicom file record', err);
  }

  // --- Step 4: ensure a Report (laudo) draft exists ---
  await upsertReportFromWorklist(item, mwlEntry, { patientName, patientId, modality, studyDate });

  return item;
}

/**
 * Ensures a Report (laudo) draft exists for the given worklist item.
 * Called automatically whenever a DICOM is ingested.
 * Patient data priority: mwlEntry.appointment > mwlEntry > DICOM tags
 */
async function upsertReportFromWorklist(
  worklistItem: { id: string; branchId: string | null; appointmentId?: string | null },
  mwlEntry: { branchId?: string | null; patientName?: string | null; patientCpf?: string | null; examType?: string | null; requestingDoctor?: string | null; appointmentId?: string | null } | null,
  dicomMeta: { patientName: string; patientId: string; modality: string; studyDate: string },
): Promise<void> {
  try {
    const existing = await prisma.report.findFirst({
      where: { worklistItemId: worklistItem.id },
    });

    if (existing) {
      const updateData: any = {};
      const resolvedBranchId = worklistItem.branchId || mwlEntry?.branchId || null;
      if (!existing.branchId && resolvedBranchId) updateData.branchId = resolvedBranchId;
      if (!existing.exam && dicomMeta.modality) updateData.exam = dicomMeta.modality;
      if (!existing.scheduledFor && dicomMeta.studyDate) updateData.scheduledFor = dicomMeta.studyDate;
      if (Object.keys(updateData).length > 0) {
        await prisma.report.update({ where: { id: existing.id }, data: updateData });
      }
      return;
    }

    // resolve patient info: appointment > mwl_entry > DICOM tags
    let resolvedPatientName: string | null = dicomMeta.patientName || null;
    let resolvedCpf: string | null = dicomMeta.patientId || null;
    let resolvedRequestingDoctor: string | null = null;

    if (mwlEntry) {
      resolvedPatientName = mwlEntry.patientName || resolvedPatientName;
      resolvedCpf = mwlEntry.patientCpf || resolvedCpf;
      resolvedRequestingDoctor = mwlEntry.requestingDoctor || null;
    }

    const appointmentId = worklistItem.appointmentId || mwlEntry?.appointmentId || null;
    if (appointmentId) {
      const appt = await prisma.appointment.findUnique({
        where: { id: appointmentId },
        select: { patientName: true, patientCpf: true, doctorName: true },
      });
      if (appt) {
        resolvedPatientName = appt.patientName || resolvedPatientName;
        resolvedCpf = appt.patientCpf || resolvedCpf;
        resolvedRequestingDoctor = appt.doctorName || resolvedRequestingDoctor;
      }
    }

    await prisma.report.create({
      data: {
        branchId: worklistItem.branchId || mwlEntry?.branchId || null,
        worklistItemId: worklistItem.id,
        appointmentId,
        patientName: resolvedPatientName,
        cpf: resolvedCpf,
        exam: mwlEntry?.examType || dicomMeta.modality || null,
        scheduledFor: dicomMeta.studyDate || null,
        requestingDoctor: resolvedRequestingDoctor,
        status: 'rascunho',
      },
    });
  } catch (err) {
    console.warn('failed to upsert report from worklist item', err);
  }
}

