import prisma from './lib/prisma';
import { processDicomBuffer } from './processor';
import { downloadDicomFromGcs } from './gcs';

const ORTHANC_URL = process.env.ORTHANC_URL || 'http://localhost:8042';
const ORTHANC_AUTH = process.env.ORTHANC_AUTH || 'orthanc:orthanc';
const POLL_INTERVAL = Number(process.env.ORTHANC_POLL_INTERVAL || '10000'); // ms
const RETENTION_DAYS = Number(process.env.ORTHANC_RETENTION_DAYS || '15');
const CLEANUP_INTERVAL = Number(process.env.ORTHANC_CLEANUP_INTERVAL || String(60 * 60 * 1000)); // 1h
const LOG_SKIPPED_INSTANCES = process.env.ORTHANC_LOG_SKIPPED_INSTANCES === 'true';

function authHeader() {
  return 'Basic ' + Buffer.from(ORTHANC_AUTH).toString('base64');
}

async function fetchJson<T>(path: string): Promise<T> {
  const res = await fetch(`${ORTHANC_URL}${path}`, {
    headers: { Authorization: authHeader() },
  });
  if (!res.ok) throw new Error(`Orthanc request failed: ${res.status}`);
  return (await res.json()) as T;
}

async function fetchBuffer(path: string) {
  const res = await fetch(`${ORTHANC_URL}${path}`, {
    headers: { Authorization: authHeader() },
  });
  if (!res.ok) throw new Error(`Orthanc request failed: ${res.status}`);
  return res.arrayBuffer();
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${ORTHANC_URL}${path}`, {
    method: 'POST',
    headers: {
      Authorization: authHeader(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Orthanc request failed: ${res.status}`);
  return (await res.json()) as T;
}

async function postDicomInstance(buffer: Buffer): Promise<void> {
  const res = await fetch(`${ORTHANC_URL}/instances`, {
    method: 'POST',
    headers: {
      Authorization: authHeader(),
      'Content-Type': 'application/dicom',
    },
    body: buffer,
  });

  if (!res.ok) {
    throw new Error(`Orthanc upload failed: ${res.status}`);
  }
}

export async function findOrthancStudyIdByDicomStudyUid(studyInstanceUid: string): Promise<string | null> {
  const result = await postJson<string[]>('/tools/find', {
    Level: 'Study',
    Query: {
      StudyInstanceUID: studyInstanceUid,
    },
  });

  return result[0] || null;
}

export async function ensureOrthancStudyFromGcs(studyInstanceUid: string) {
  const existingStudyId = await findOrthancStudyIdByDicomStudyUid(studyInstanceUid);
  if (existingStudyId) {
    return {
      status: 'cache_hit' as const,
      studyInstanceUid,
      orthancStudyId: existingStudyId,
      uploadedInstances: 0,
    };
  }

  const files = await prisma.dicomFile.findMany({
    where: { studyUid: studyInstanceUid },
    orderBy: { createdAt: 'asc' },
    select: { id: true, path: true },
  });

  if (files.length === 0) {
    throw new Error(`No archived files found for study ${studyInstanceUid}`);
  }

  let uploadedInstances = 0;
  for (const file of files) {
    const buffer = await downloadDicomFromGcs(file.path);
    await postDicomInstance(buffer);
    uploadedInstances += 1;
  }

  const orthancStudyId = await findOrthancStudyIdByDicomStudyUid(studyInstanceUid);
  return {
    status: 'cache_miss_rehydrated' as const,
    studyInstanceUid,
    orthancStudyId,
    uploadedInstances,
  };
}

async function cleanupOldOrthancStudies() {
  if (RETENTION_DAYS <= 0) return;

  const cutoffDate = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const oldStudies = await prisma.orthancStudy.findMany({
    where: { processedAt: { lt: cutoffDate } },
    select: { studyUid: true, processedAt: true },
    take: 200,
    orderBy: { processedAt: 'asc' },
  });

  for (const study of oldStudies) {
    try {
      const res = await fetch(`${ORTHANC_URL}/studies/${study.studyUid}`, {
        method: 'DELETE',
        headers: { Authorization: authHeader() },
      });

      // 200/204: deleted now, 404: already absent.
      if (res.ok || res.status === 404) {
        await prisma.orthancStudy.delete({ where: { studyUid: study.studyUid } });
      } else {
        console.warn(`orthanc cleanup: failed to delete ${study.studyUid} (${res.status})`);
      }
    } catch (err) {
      console.warn(`orthanc cleanup: error deleting ${study.studyUid}`, err);
    }
  }
}

export function startOrthancPoller() {
  const handle = async () => {
    try {
      const studies: string[] = await fetchJson<string[]>('/studies');
      for (const uid of studies) {
        console.log(`orthanc poll: examining study ${uid}`);
        // fetch all instance descriptions
        const instObjs: Array<{ ID: string }> = await fetchJson<any>(`/studies/${uid}/instances`);
        const instances = instObjs.map(o => o.ID);

        for (const inst of instances) {
          // skip if we already processed this instance
          const seen = await prisma.dicomFile.findFirst({ where: { instanceId: inst } });
          if (seen) {
            if (LOG_SKIPPED_INSTANCES) {
              console.log(`orthanc poll: skipping already processed instance ${inst}`);
            }
            continue;
          }

          console.log(`orthanc poll: fetching new instance ${inst} for study ${uid}`);
          try {
            const buf = await fetchBuffer(`/instances/${inst}/file`);
            await processDicomBuffer(Buffer.from(buf), null, inst);
          } catch (err) {
            console.warn(`orthanc poll: failed to fetch/process instance ${inst}`, err);
          }
        }

        // record that we've seen the study (if not already)
        const exists = await prisma.orthancStudy.findUnique({ where: { studyUid: uid } });
        if (!exists) {
          await prisma.orthancStudy.create({ data: { studyUid: uid } });
        }
      }
    } catch (err) {
      console.warn('orthanc poll error', err);
    }
  };

  setInterval(handle, POLL_INTERVAL);
  // run immediately
  handle();

  const cleanupHandle = async () => {
    try {
      await cleanupOldOrthancStudies();
    } catch (err) {
      console.warn('orthanc cleanup error', err);
    }
  };

  setInterval(cleanupHandle, CLEANUP_INTERVAL);
  // run immediately
  cleanupHandle();
}
