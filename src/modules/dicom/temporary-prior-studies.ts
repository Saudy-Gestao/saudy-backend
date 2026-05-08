import dicomParser from 'dicom-parser';
import { inflateRawSync } from 'zlib';
import prisma from './lib/prisma';
import {
  deleteOrthancStudy,
  findOrthancStudyIdByDicomStudyUid,
  postDicomInstance,
} from './orthanc';

const DEFAULT_TTL_HOURS = Number(process.env.TEMP_DICOM_TTL_HOURS || '8');
const MAX_TTL_HOURS = Number(process.env.TEMP_DICOM_MAX_TTL_HOURS || '24');
const MAX_TOTAL_BYTES = Number(process.env.TEMP_DICOM_MAX_TOTAL_BYTES || String(512 * 1024 * 1024));
const MAX_ZIP_FILES = Number(process.env.TEMP_DICOM_MAX_ZIP_FILES || '2000');

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const LOCAL_FILE_SIGNATURE = 0x04034b50;

export interface TemporaryDicomUploadFile {
  fileName?: string;
  base64: string;
}

interface ParsedTemporaryDicom {
  buffer: Buffer;
  studyInstanceUid: string;
  patientName: string | null;
  patientId: string | null;
  modality: string | null;
  studyDate: string | null;
}

interface TemporaryDicomBufferFile {
  fileName?: string;
  buffer: Buffer;
}

function decodeBase64(raw: string): Buffer {
  const trimmed = String(raw || '').trim();
  const normalized = trimmed.includes(',') ? trimmed.split(',').pop() || '' : trimmed;
  return Buffer.from(normalized, 'base64');
}

function isLikelyIgnorableZipEntry(fileName: string): boolean {
  const normalized = fileName.replace(/\\/g, '/');
  return normalized.endsWith('/')
    || normalized.includes('__MACOSX/')
    || normalized.split('/').some((part) => part.startsWith('.'));
}

function findEndOfCentralDirectory(zip: Buffer): number {
  const minOffset = Math.max(0, zip.length - 0xffff - 22);
  for (let offset = zip.length - 22; offset >= minOffset; offset -= 1) {
    if (zip.readUInt32LE(offset) === EOCD_SIGNATURE) return offset;
  }
  throw new Error('ZIP invalido: diretorio central nao encontrado');
}

function extractZipDicomFiles(zipBase64: string): TemporaryDicomBufferFile[] {
  const zip = decodeBase64(zipBase64);
  if (!zip.length) throw new Error('Arquivo ZIP vazio');

  const eocdOffset = findEndOfCentralDirectory(zip);
  const entriesCount = zip.readUInt16LE(eocdOffset + 10);
  const centralDirectoryOffset = zip.readUInt32LE(eocdOffset + 16);

  if (entriesCount > MAX_ZIP_FILES) {
    throw new Error('ZIP contem arquivos demais para carregamento temporario');
  }

  const files: TemporaryDicomBufferFile[] = [];
  let offset = centralDirectoryOffset;
  let totalBytes = 0;

  for (let index = 0; index < entriesCount; index += 1) {
    if (offset + 46 > zip.length || zip.readUInt32LE(offset) !== CENTRAL_DIRECTORY_SIGNATURE) {
      throw new Error('ZIP invalido: entrada do diretorio central corrompida');
    }

    const compressionMethod = zip.readUInt16LE(offset + 10);
    const compressedSize = zip.readUInt32LE(offset + 20);
    const uncompressedSize = zip.readUInt32LE(offset + 24);
    const fileNameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    const localHeaderOffset = zip.readUInt32LE(offset + 42);
    const fileName = zip.subarray(offset + 46, offset + 46 + fileNameLength).toString('utf8');

    offset += 46 + fileNameLength + extraLength + commentLength;

    if (isLikelyIgnorableZipEntry(fileName)) continue;
    if (totalBytes + uncompressedSize > MAX_TOTAL_BYTES) {
      throw new Error('Tamanho total dos DICOMs no ZIP excede o limite para carregamento temporario');
    }
    if (localHeaderOffset + 30 > zip.length || zip.readUInt32LE(localHeaderOffset) !== LOCAL_FILE_SIGNATURE) {
      throw new Error('ZIP invalido: cabecalho local corrompido');
    }

    const localFileNameLength = zip.readUInt16LE(localHeaderOffset + 26);
    const localExtraLength = zip.readUInt16LE(localHeaderOffset + 28);
    const dataOffset = localHeaderOffset + 30 + localFileNameLength + localExtraLength;
    const compressed = zip.subarray(dataOffset, dataOffset + compressedSize);

    let buffer: Buffer;
    if (compressionMethod === 0) {
      buffer = Buffer.from(compressed);
    } else if (compressionMethod === 8) {
      buffer = inflateRawSync(compressed);
    } else {
      throw new Error(`ZIP usa metodo de compressao nao suportado (${compressionMethod})`);
    }

    if (uncompressedSize && buffer.length !== uncompressedSize) {
      throw new Error('ZIP invalido: tamanho descompactado divergente');
    }

    totalBytes += buffer.length;
    files.push({ fileName, buffer });
  }

  if (!files.length) throw new Error('ZIP nao contem arquivos DICOM validos para processar');
  return files;
}

function formatDicomDate(raw: string | undefined): string | null {
  if (!raw || raw.length < 8) return null;
  return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
}

function parseTemporaryDicom(file: TemporaryDicomBufferFile): ParsedTemporaryDicom {
  const buffer = file.buffer;
  if (!buffer.length) {
    throw new Error(`Arquivo DICOM vazio${file.fileName ? `: ${file.fileName}` : ''}`);
  }

  const dataSet = dicomParser.parseDicom(new Uint8Array(buffer));
  const studyInstanceUid = dataSet.string('x0020000d') || '';
  if (!studyInstanceUid) {
    throw new Error(`Arquivo DICOM sem StudyInstanceUID${file.fileName ? `: ${file.fileName}` : ''}`);
  }

  return {
    buffer,
    studyInstanceUid,
    patientName: (dataSet.string('x00100010') || '').replace(/\^/g, ' ') || null,
    patientId: dataSet.string('x00100020') || null,
    modality: dataSet.string('x00080060') || null,
    studyDate: formatDicomDate(dataSet.string('x00080020')),
  };
}

function resolveExpiresAt(ttlHours?: number): Date {
  const requested = Number.isFinite(ttlHours) && ttlHours ? Number(ttlHours) : DEFAULT_TTL_HOURS;
  const bounded = Math.min(Math.max(requested, 1), Math.max(MAX_TTL_HOURS, 1));
  return new Date(Date.now() + bounded * 60 * 60 * 1000);
}

export async function hasPermanentStudyReference(studyInstanceUid: string): Promise<boolean> {
  const [worklistCount, dicomFileCount] = await Promise.all([
    prisma.reportWorklistItem.count({
      where: {
        dicomStudyUid: studyInstanceUid,
        isActive: true,
      },
    }),
    prisma.dicomFile.count({
      where: {
        studyUid: studyInstanceUid,
      },
    }),
  ]);

  return worklistCount > 0 || dicomFileCount > 0;
}

export async function uploadTemporaryPriorStudy(params: {
  branchId: string;
  reportId: string;
  uploadedByUserId?: string | null;
  description?: string | null;
  ttlHours?: number;
  files?: TemporaryDicomUploadFile[];
  zipBase64?: string | null;
}) {
  const files: TemporaryDicomBufferFile[] = [
    ...(params.files || []).map((file) => ({
      fileName: file.fileName,
      buffer: decodeBase64(file.base64),
    })),
    ...(params.zipBase64 ? extractZipDicomFiles(params.zipBase64) : []),
  ];

  if (!files.length) throw new Error('Nenhum arquivo DICOM enviado');

  const parsed = files.map(parseTemporaryDicom);
  const totalBytes = parsed.reduce((sum, item) => sum + item.buffer.length, 0);
  if (totalBytes > MAX_TOTAL_BYTES) {
    throw new Error('Tamanho total dos DICOMs excede o limite para carregamento temporario');
  }

  const studyUids = Array.from(new Set(parsed.map((item) => item.studyInstanceUid)));
  if (studyUids.length !== 1) {
    throw new Error('Envie apenas um estudo DICOM por carregamento temporario');
  }

  const studyInstanceUid = studyUids[0];
  const preExistingStudyId = await findOrthancStudyIdByDicomStudyUid(studyInstanceUid);
  if (preExistingStudyId) {
    const first = parsed[0];
    const deleteFromOrthanc = !(await hasPermanentStudyReference(studyInstanceUid));
    return prisma.temporaryDicomStudy.create({
      data: {
        branchId: params.branchId,
        reportId: params.reportId,
        orthancStudyId: preExistingStudyId,
        studyInstanceUid,
        patientName: first.patientName,
        patientId: first.patientId,
        modality: first.modality,
        studyDate: first.studyDate,
        description: params.description || null,
        instancesCount: parsed.length,
        uploadedByUserId: params.uploadedByUserId || null,
        expiresAt: resolveExpiresAt(params.ttlHours),
        deleteFromOrthanc,
      },
    });
  }

  let orthancStudyId: string | null = null;
  let uploadedInstances = 0;
  for (const item of parsed) {
    const result = await postDicomInstance(item.buffer);
    orthancStudyId = String(result.ParentStudy || orthancStudyId || '');
    uploadedInstances += 1;
  }

  if (!orthancStudyId) {
    orthancStudyId = await findOrthancStudyIdByDicomStudyUid(studyInstanceUid);
  }
  if (!orthancStudyId) {
    throw new Error('Orthanc recebeu os DICOMs, mas nao retornou o estudo criado');
  }

  const first = parsed[0];
  const created = await prisma.temporaryDicomStudy.create({
    data: {
      branchId: params.branchId,
      reportId: params.reportId,
      orthancStudyId,
      studyInstanceUid,
      patientName: first.patientName,
      patientId: first.patientId,
      modality: first.modality,
      studyDate: first.studyDate,
      description: params.description || null,
      instancesCount: uploadedInstances,
      uploadedByUserId: params.uploadedByUserId || null,
      expiresAt: resolveExpiresAt(params.ttlHours),
      deleteFromOrthanc: true,
    },
  });

  return created;
}

export async function cleanupExpiredTemporaryDicomStudies(now = new Date()) {
  const expired = await prisma.temporaryDicomStudy.findMany({
    where: {
      deletedAt: null,
      expiresAt: { lte: now },
    },
    take: 100,
    orderBy: { expiresAt: 'asc' },
  });

  let deleted = 0;
  for (const study of expired) {
    try {
      if (study.deleteFromOrthanc || !(await hasPermanentStudyReference(study.studyInstanceUid))) {
        await deleteOrthancStudy(study.orthancStudyId);
      }
      await prisma.temporaryDicomStudy.update({
        where: { id: study.id },
        data: { deletedAt: new Date() },
      });
      deleted += 1;
    } catch (err) {
      console.warn('temporary dicom cleanup: failed to delete study', study.id, err);
    }
  }

  return { scanned: expired.length, deleted };
}

export function startTemporaryDicomStudyCleanup() {
  const intervalMs = Number(process.env.TEMP_DICOM_CLEANUP_INTERVAL_MS || String(15 * 60 * 1000));

  const run = async () => {
    try {
      await cleanupExpiredTemporaryDicomStudies();
    } catch (err) {
      console.warn('temporary dicom cleanup error', err);
    }
  };

  const handle = setInterval(run, intervalMs);
  if (typeof (handle as any).unref === 'function') (handle as any).unref();
  void run();
}
