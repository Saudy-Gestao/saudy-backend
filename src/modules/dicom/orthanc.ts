import prisma from './lib/prisma';
import { processDicomBuffer } from './processor';

const ORTHANC_URL = process.env.ORTHANC_URL || 'http://localhost:8042';
const ORTHANC_AUTH = process.env.ORTHANC_AUTH || 'orthanc:orthanc';
const POLL_INTERVAL = Number(process.env.ORTHANC_POLL_INTERVAL || '10000'); // ms

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
          if (seen) continue;

          console.log(`orthanc poll: fetching new instance ${inst} for study ${uid}`);
          try {
            const buf = await fetchBuffer(`/instances/${inst}/file`);
            await processDicomBuffer(Buffer.from(buf), null, inst);
          } catch (err) {
            console.warn(`orthanc poll: failed to fetch instance ${inst}`, err);
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
}
