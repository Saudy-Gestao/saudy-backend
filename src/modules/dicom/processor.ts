import path from 'path';
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
}

// images are stored exclusively in a GCS bucket; no local directory used
export async function processDicomBuffer(
  buffer: Buffer,
  branchId: string | null,
  instanceId?: string,
): Promise<any /* ReportWorklistItem */> {
  // parse minimal metadata
  const byteArray = new Uint8Array(buffer);
  const dataSet = dicomParser.parseDicom(byteArray);

  const studyInstanceUid = dataSet.string('x0020000d') || '';
  const seriesInstanceUid = dataSet.string('x0020000e') || '';
  const patientName = (dataSet.string('x00100010') || '').replace(/\^/g, ' ');
  const patientId = dataSet.string('x00100020') || '';
  const modality = dataSet.string('x00080060') || '';
  const studyDateRaw = dataSet.string('x00080020') || '';
  const studyDate = studyDateRaw
    ? `${studyDateRaw.slice(6, 8)}/${studyDateRaw.slice(4, 6)}/${studyDateRaw.slice(0, 4)}`
    : '';

  // always upload to GCS
  const objectName = `${uuidv4()}.dcm`;
  await uploadDicomToGcs(objectName, buffer);
  const fullPath = objectName; // store object name in database

  // compute url for retrieval (we serve through our own route)
  const dicomUrl = `/dicom/${studyInstanceUid || fullPath}/file`;

  // find existing worklist item
  let item = null;
  if (studyInstanceUid) {
    item = await prisma.reportWorklistItem.findFirst({
      where: {
        branchId,
        dicomStudyUid: studyInstanceUid,
      },
    });
  }

  if (!item && studyInstanceUid) {
    item = await prisma.reportWorklistItem.findFirst({
      where: {
        branchId,
        externalStudyId: studyInstanceUid,
      },
    });
  }

  // fallback by patient id + modality maybe
  if (!item && patientId) {
    item = await prisma.reportWorklistItem.findFirst({
      where: {
        branchId,
        patientCpf: patientId,
      },
    });
  }

  const now = new Date();
  if (item) {
    // update worklist item only if we haven't stored a path yet;
    // keep the existing path/URL for backward compatibility
    const updateData: any = {};
    if (!item.dicomPath) updateData.dicomPath = fullPath;
    if (!item.dicomUrl) updateData.dicomUrl = dicomUrl;
    if (!item.dicomStudyUid && studyInstanceUid) updateData.dicomStudyUid = studyInstanceUid;
    if (!item.dicomSeriesUid && seriesInstanceUid) updateData.dicomSeriesUid = seriesInstanceUid;
    updateData.dicomReceivedAt = now;

    item = await prisma.reportWorklistItem.update({
      where: { id: item.id },
      data: updateData,
    });
  } else {
    // create a bare minimal new worklist item
    item = await prisma.reportWorklistItem.create({
      data: {
        branchId,
        patientName: patientName || 'N/A',
        patientCpf: patientId || null,
        examType: modality || 'unknown',
        dicomStudyUid: studyInstanceUid || undefined,
        dicomSeriesUid: seriesInstanceUid || undefined,
        dicomPath: fullPath,
        dicomUrl,
        dicomReceivedAt: now,
      },
    });
  }

  // create a record for this file so we can store a series
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
    // log but don't fail the whole request if index exists etc.
    console.warn('failed to insert dicom file record', err);
  }

  return item;
}
