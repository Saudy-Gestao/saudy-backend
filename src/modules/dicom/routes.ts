import { FastifyInstance } from 'fastify';
import prisma from './lib/prisma';
import { processDicomBuffer } from './processor';
import { getDicomStreamFromGcs } from './gcs';
import { ensureOrthancStudyFromGcs } from './orthanc';

export default async function dicomRoutes(app: FastifyInstance) {
  // require authentication similar to other modules
  app.addHook('onRequest', async (request, reply) => {
    try {
      await request.jwtVerify();
    } catch {
      return reply.code(401).send({ error: 'Unauthorized' });
    }
  });

  const getLoggedBranchId = async (request: any) => {
    const userId = (request.user as any)?.id;
    if (!userId) return null;
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { sector: { include: { branch: true } } },
    });
    return user?.sector?.branch?.id || null;
  };

  app.post('/', {
    schema: {
      summary: 'Upload/process a DICOM file',
      tags: ['DICOM'],
      body: {
        type: 'object',
        required: ['base64'],
        properties: {
          base64: {
            anyOf: [
              { type: 'string' },
              { type: 'array', items: { type: 'string' } },
            ],
          },
        },
      },
    },
  }, async (request, reply) => {
    const branchId = await getLoggedBranchId(request);
    // allow null branchId, processing will still work

    const { base64 } = request.body as any;
    const entries: string[] = Array.isArray(base64) ? base64 : [base64];
    const items: any[] = [];

    for (const b64 of entries) {
      let buffer: Buffer;
      try {
        buffer = Buffer.from(b64, 'base64');
      } catch (err: any) {
        return reply.code(400).send({ error: 'Invalid base64 payload', details: err.message });
      }

      try {
        const item = await processDicomBuffer(buffer, branchId);
        items.push(item);
      } catch (err: any) {
        request.log.error({ err }, 'failed to process dicom');
        return reply.code(500).send({ error: 'Failed to process DICOM', details: err.message });
      }
    }

    return { items };
  });

  // ensure a DICOM study exists in Orthanc (cache hit or rehydrate from GCS)
  app.post('/:key/ensure-orthanc', async (request, reply) => {
    const { key } = request.params as any;

    const item = await prisma.reportWorklistItem.findFirst({
      where: {
        OR: [{ id: key }, { dicomStudyUid: key }],
      },
      select: {
        id: true,
        dicomStudyUid: true,
      },
    });

    if (!item) {
      return reply.code(404).send({ error: 'Report worklist item not found' });
    }

    let studyInstanceUid = item.dicomStudyUid || null;
    if (!studyInstanceUid) {
      const file = await prisma.dicomFile.findFirst({
        where: { worklistItemId: item.id },
        orderBy: { createdAt: 'asc' },
        select: { studyUid: true },
      });
      studyInstanceUid = file?.studyUid || null;
    }

    if (!studyInstanceUid) {
      return reply.code(400).send({ error: 'This exam has no DICOM StudyInstanceUID' });
    }

    try {
      const result = await ensureOrthancStudyFromGcs(studyInstanceUid);
      return {
        key,
        ...result,
      };
    } catch (err: any) {
      request.log.error({ err, key, studyInstanceUid }, 'failed to ensure Orthanc study');
      return reply.code(500).send({
        error: 'Failed to prepare study in Orthanc',
        details: err?.message || 'Unknown error',
      });
    }
  });

  // serve the stored file by worklist id or by study uid
  // this endpoint returns the most-recently ingested file for the item
  app.get('/:key/file', async (request, reply) => {
    const { key } = request.params as any;
    // find item by id or by dicomStudyUid
    const item = await prisma.reportWorklistItem.findFirst({
      where: {
        OR: [{ id: key }, { dicomStudyUid: key }],
      },
    });
    if (!item) {
      return reply.code(404).send({ error: 'DICOM not found' });
    }

    // fetch the latest dicomFile record
    const record = await prisma.dicomFile.findFirst({
      where: { worklistItemId: item.id },
      orderBy: { createdAt: 'desc' },
    });
    if (!record) {
      return reply.code(404).send({ error: 'DICOM not found' });
    }
    // always stream from GCS bucket
    let stream;
    try {
      stream = getDicomStreamFromGcs(record.path);
    } catch (err: any) {
      request.log.error({ err }, 'failed to open gcs stream');
      return reply.code(404).send({ error: 'File not found in cloud storage' });
    }
    reply.header('Content-Type', 'application/dicom');
    return reply.send(stream);
  });

  // list DICOMs linked to an item (by item id or study UID)
  // default view groups by series, but each series can expose its own instances
  app.get('/:key/files', async (request, reply) => {
    const { key } = request.params as any;
    const { view = 'instances', includeInstances = 'true', seriesUid } = (request.query || {}) as {
      view?: string;
      includeInstances?: string;
      seriesUid?: string;
    };
    const shouldIncludeInstances = String(includeInstances).toLowerCase() !== 'false';
    const item = await prisma.reportWorklistItem.findFirst({
      where: { OR: [{ id: key }, { dicomStudyUid: key }] },
    });
    if (!item) return reply.code(404).send({ error: 'DICOM not found' });

    const files = await prisma.dicomFile.findMany({
      where: { worklistItemId: item.id },
      orderBy: { createdAt: 'asc' },
      select: { id: true, seriesUid: true, createdAt: true, instanceId: true },
    });

    // common viewer pattern: request all instances from one selected series
    if (typeof seriesUid === 'string' && seriesUid.length > 0) {
      const resolvedSeriesUid = seriesUid === '__NO_SERIES__' ? null : seriesUid;
      const selected = files.filter(
        (f: { id: string; seriesUid: string | null; createdAt: Date; instanceId: string | null }) =>
          f.seriesUid === resolvedSeriesUid,
      );
      const list = selected.map((f: { id: string; seriesUid: string | null; instanceId: string | null }) => ({
        id: f.id,
        seriesUid: f.seriesUid,
        instanceId: f.instanceId,
        url: `/dicom/file/${f.id}`,
      }));
      return {
        view: 'instances',
        key,
        seriesUid: resolvedSeriesUid,
        totalInstances: list.length,
        files: list,
        instances: list,
      };
    }

    if (view === 'instances') {
      const list = files.map((f: { id: string; seriesUid: string | null; instanceId: string | null }) => ({
        id: f.id,
        seriesUid: f.seriesUid,
        instanceId: f.instanceId,
        url: `/dicom/file/${f.id}`,
      }));
      return {
        view: 'instances',
        totalInstances: list.length,
        files: list,
      };
    }

    const bySeries = new Map<
      string,
      {
        id: string;
        seriesUid: string | null;
        instancesCount: number;
        instances: Array<{ id: string; instanceId: string | null; url: string }>;
      }
    >();

    for (const f of files) {
      const seriesKey = f.seriesUid || '__NO_SERIES__';
      const existing = bySeries.get(seriesKey);
      if (existing) {
        existing.instancesCount += 1;
        if (shouldIncludeInstances) {
          existing.instances.push({
            id: f.id,
            instanceId: f.instanceId,
            url: `/dicom/file/${f.id}`,
          });
        }
      } else {
        bySeries.set(seriesKey, {
          id: f.id,
          seriesUid: f.seriesUid,
          instancesCount: 1,
          instances: shouldIncludeInstances
            ? [{ id: f.id, instanceId: f.instanceId, url: `/dicom/file/${f.id}` }]
            : [],
        });
      }
    }

    const series = Array.from(bySeries.values()).map((s) => ({
      id: s.id,
      seriesUid: s.seriesUid,
      instancesCount: s.instancesCount,
      url: `/dicom/file/${s.id}`,
      instances: s.instances,
      files: s.instances,
    }));

    // backward-compatible key name: `files` now represents series when view=series
    return {
      view: 'series',
      totalInstances: files.length,
      totalSeries: series.length,
      files: series,
      series,
    };
  });

  // list all instances from one selected series for a given item/study
  app.get('/:key/series/:seriesUid/files', async (request, reply) => {
    const { key, seriesUid } = request.params as any;
    const resolvedSeriesUid = seriesUid === '__NO_SERIES__' ? null : seriesUid;

    const item = await prisma.reportWorklistItem.findFirst({
      where: { OR: [{ id: key }, { dicomStudyUid: key }] },
      select: { id: true },
    });
    if (!item) return reply.code(404).send({ error: 'DICOM not found' });

    const files = await prisma.dicomFile.findMany({
      where: {
        worklistItemId: item.id,
        seriesUid: resolvedSeriesUid,
      },
      orderBy: { createdAt: 'asc' },
      select: { id: true, seriesUid: true, instanceId: true },
    });

    const list = files.map((f: { id: string; seriesUid: string | null; instanceId: string | null }) => ({
      id: f.id,
      seriesUid: f.seriesUid,
      instanceId: f.instanceId,
      url: `/dicom/file/${f.id}`,
    }));

    return {
      view: 'instances',
      key,
      seriesUid: resolvedSeriesUid,
      totalInstances: list.length,
      files: list,
    };
  });

  // fetch a specific file by its own ID
  app.get('/file/:fileId', async (request, reply) => {
    const { fileId } = request.params as any;
    const f = await prisma.dicomFile.findUnique({ where: { id: fileId } });
    if (!f) return reply.code(404).send({ error: 'DICOM not found' });
    // always stream from cloud
    let stream;
    try {
      stream = getDicomStreamFromGcs(f.path);
    } catch (err: any) {
      request.log.error({ err }, 'failed to open gcs stream');
      return reply.code(404).send({ error: 'File not found in cloud storage' });
    }
    reply.header('Content-Type', 'application/dicom');
    return reply.send(stream);
  });
}

