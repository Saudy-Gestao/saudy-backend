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
            oneOf: [
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

  // list all files linked to an item (by item id or study UID)
  app.get('/:key/files', async (request, reply) => {
    const { key } = request.params as any;
    const item = await prisma.reportWorklistItem.findFirst({
      where: { OR: [{ id: key }, { dicomStudyUid: key }] },
    });
    if (!item) return reply.code(404).send({ error: 'DICOM not found' });

    const files = await prisma.dicomFile.findMany({
      where: { worklistItemId: item.id },
      orderBy: { createdAt: 'asc' },
    });

    const list = files.map((f: { id: string }) => ({
      id: f.id,
      url: `/dicom/file/${f.id}`,
    }));
    return { files: list };
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

