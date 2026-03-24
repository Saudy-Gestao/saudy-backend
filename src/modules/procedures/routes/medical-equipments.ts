import { FastifyInstance } from 'fastify';
import net from 'node:net';
import prisma from '../lib/prisma';

const normalizeString = (value: unknown) => {
  const text = String(value ?? '').trim();
  return text.length > 0 ? text : null;
};

const normalizeProcedureIds = (value: unknown) => {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => String(item || '').trim())
    .filter((item, index, arr) => item.length > 0 && arr.indexOf(item) === index);
};

const serializeEquipment = (item: any) => ({
  ...item,
  procedureIds: Array.isArray(item?.procedures)
    ? item.procedures.map((link: any) => String(link?.procedureId || '')).filter(Boolean)
    : [],
});

const testTcpConnection = async (host: string, port: number, timeoutMs = 3000) => {
  return new Promise<void>((resolve, reject) => {
    const socket = new net.Socket();
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      fn();
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(resolve));
    socket.once('timeout', () => finish(() => reject(new Error(`Timeout ao conectar em ${host}:${port}`))));
    socket.once('error', (err) => finish(() => reject(err)));
    socket.connect(port, host);
  });
};

const testHttpEndpoint = async (url: string, timeoutMs = 5000) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      signal: controller.signal,
    });

    if (!res.ok && res.status !== 401 && res.status !== 403) {
      throw new Error(`HTTP ${res.status}`);
    }
  } finally {
    clearTimeout(timeout);
  }
};

export default async function medicalEquipmentRoutes(app: FastifyInstance) {
  const getLoggedBranchId = async (request: any) => {
    const userId = (request.user as any)?.id;
    if (!userId) return null;
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { sector: { include: { branch: true } } },
    });
    return user?.sector?.branch?.id || null;
  };

  app.addHook('onRequest', async (request, reply) => {
    try {
      await request.jwtVerify();
    } catch {
      return reply.code(401).send({ error: 'Unauthorized' });
    }
  });

  app.get('/', {
    schema: {
      summary: 'List medical equipments',
      tags: ['Medical Equipments'],
      querystring: {
        type: 'object',
        properties: {
          search: { type: 'string' },
          modality: { type: 'string' },
          roomId: { type: 'string' },
          isActive: { type: 'boolean' },
          limit: { type: 'number', default: 50 },
          offset: { type: 'number', default: 0 },
        },
      },
    },
  }, async (request, reply) => {
    const branchId = await getLoggedBranchId(request);
    if (!branchId) return reply.code(403).send({ error: 'User not associated with a branch' });

    const { search, modality, roomId, isActive, limit = 50, offset = 0 } = request.query as any;
    const where: any = { branchId };

    if (modality) where.modality = modality;
    if (roomId) where.roomId = roomId;
    if (isActive !== undefined) where.isActive = isActive;
    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { manufacturer: { contains: search, mode: 'insensitive' } },
        { model: { contains: search, mode: 'insensitive' } },
        { modality: { contains: search, mode: 'insensitive' } },
        { integrationType: { contains: search, mode: 'insensitive' } },
        { bridgeIdentifier: { contains: search, mode: 'insensitive' } },
        { aeTitle: { contains: search, mode: 'insensitive' } },
        { mwlRemoteAeTitle: { contains: search, mode: 'insensitive' } },
        { storeRemoteAeTitle: { contains: search, mode: 'insensitive' } },
        { mwlHost: { contains: search, mode: 'insensitive' } },
        { storeHost: { contains: search, mode: 'insensitive' } },
        { serialNumber: { contains: search, mode: 'insensitive' } },
        { patrimonyCode: { contains: search, mode: 'insensitive' } },
      ];
    }

    const [items, total] = await Promise.all([
      prisma.medicalEquipment.findMany({
        where,
        take: limit,
        skip: offset,
        orderBy: { createdAt: 'desc' },
        include: {
          room: { select: { id: true, name: true, branchId: true } },
          procedures: {
            include: {
              procedure: { select: { id: true, name: true, modalities: true } },
            },
          },
        },
      }),
      prisma.medicalEquipment.count({ where }),
    ]);

    return { items: items.map(serializeEquipment), total };
  });

  app.get('/:id', {
    schema: {
      summary: 'Get medical equipment by ID',
      tags: ['Medical Equipments'],
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
  }, async (request, reply) => {
    const branchId = await getLoggedBranchId(request);
    if (!branchId) return reply.code(403).send({ error: 'User not associated with a branch' });

    const { id } = request.params as any;
    const item = await prisma.medicalEquipment.findFirst({
      where: { id, branchId },
      include: {
        room: { select: { id: true, name: true, branchId: true } },
        procedures: {
          include: {
            procedure: { select: { id: true, name: true, modalities: true } },
          },
        },
      },
    });

    if (!item) return reply.code(404).send({ error: 'Medical equipment not found' });
    return serializeEquipment(item);
  });

  app.post('/', {
    schema: {
      summary: 'Create medical equipment',
      tags: ['Medical Equipments'],
      body: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string' },
          manufacturer: { type: 'string' },
          model: { type: 'string' },
          modality: { type: 'string' },
          integrationType: { type: 'string' },
          bridgeIdentifier: { type: 'string' },
          aeTitle: { type: 'string' },
          mwlRemoteAeTitle: { type: 'string' },
          storeRemoteAeTitle: { type: 'string' },
          stationName: { type: 'string' },
          serialNumber: { type: 'string' },
          patrimonyCode: { type: 'string' },
          roomId: { type: 'string' },
          mwlHost: { type: 'string' },
          mwlPort: { type: 'number' },
          storeHost: { type: 'string' },
          storePort: { type: 'number' },
          dicomWebPath: { type: 'string' },
          supportsWorklist: { type: 'boolean' },
          supportsStore: { type: 'boolean' },
          supportsPrint: { type: 'boolean' },
          procedureIds: { type: 'array', items: { type: 'string' } },
          status: { type: 'string' },
          observations: { type: 'string' },
          isActive: { type: 'boolean' },
        },
      },
    },
  }, async (request, reply) => {
    const branchId = await getLoggedBranchId(request);
    if (!branchId) return reply.code(403).send({ error: 'User not associated with a branch' });

    const data = request.body as any;
    const procedureIds = normalizeProcedureIds(data.procedureIds);

    try {
      if (data.roomId) {
        const room = await prisma.sector.findFirst({ where: { id: String(data.roomId), branchId } });
        if (!room) return reply.code(400).send({ error: 'Room not found in user branch' });
      }

      if (procedureIds.length > 0) {
        const proceduresCount = await prisma.procedure.count({
          where: {
            id: { in: procedureIds },
            branchId,
          },
        });
        if (proceduresCount !== procedureIds.length) {
          return reply.code(400).send({ error: 'One or more procedures are invalid for the user branch' });
        }
      }

      const item = await prisma.medicalEquipment.create({
        data: {
          branchId,
          roomId: normalizeString(data.roomId),
          name: String(data.name).trim(),
          manufacturer: normalizeString(data.manufacturer),
          model: normalizeString(data.model),
          modality: normalizeString(data.modality),
          integrationType: normalizeString(data.integrationType) || 'MWL_BRIDGE',
          bridgeIdentifier: normalizeString(data.bridgeIdentifier),
          aeTitle: normalizeString(data.aeTitle),
          mwlRemoteAeTitle: normalizeString(data.mwlRemoteAeTitle),
          storeRemoteAeTitle: normalizeString(data.storeRemoteAeTitle),
          stationName: normalizeString(data.stationName),
          serialNumber: normalizeString(data.serialNumber),
          patrimonyCode: normalizeString(data.patrimonyCode),
          mwlHost: normalizeString(data.mwlHost),
          mwlPort: data.mwlPort !== undefined && data.mwlPort !== null ? Number(data.mwlPort) : null,
          storeHost: normalizeString(data.storeHost),
          storePort: data.storePort !== undefined && data.storePort !== null ? Number(data.storePort) : null,
          dicomWebPath: normalizeString(data.dicomWebPath),
          supportsWorklist: Boolean(data.supportsWorklist),
          supportsStore: data.supportsStore === undefined ? true : Boolean(data.supportsStore),
          supportsPrint: Boolean(data.supportsPrint),
          status: normalizeString(data.status) || 'Ativo',
          observations: normalizeString(data.observations),
          isActive: data.isActive === undefined ? true : Boolean(data.isActive),
          procedures: procedureIds.length > 0
            ? {
                createMany: {
                  data: procedureIds.map((procedureId) => ({ procedureId })),
                  skipDuplicates: true,
                },
              }
            : undefined,
        },
        include: {
          room: { select: { id: true, name: true, branchId: true } },
          procedures: {
            include: {
              procedure: { select: { id: true, name: true, modalities: true } },
            },
          },
        },
      });

      return reply.code(201).send(serializeEquipment(item));
    } catch (err: any) {
      request.log.error({ err }, 'Failed to create medical equipment');
      return reply.code(400).send({ error: 'Failed to create medical equipment', details: err.message });
    }
  });

  app.put('/:id', {
    schema: {
      summary: 'Update medical equipment',
      tags: ['Medical Equipments'],
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      body: { type: 'object' },
    },
  }, async (request, reply) => {
    const branchId = await getLoggedBranchId(request);
    if (!branchId) return reply.code(403).send({ error: 'User not associated with a branch' });

    const { id } = request.params as any;
    const data = request.body as any;
    const procedureIds = data.procedureIds !== undefined ? normalizeProcedureIds(data.procedureIds) : null;

    try {
      const existing = await prisma.medicalEquipment.findFirst({ where: { id, branchId } });
      if (!existing) return reply.code(404).send({ error: 'Medical equipment not found' });

      if (data.roomId !== undefined && data.roomId !== null && String(data.roomId).trim()) {
        const room = await prisma.sector.findFirst({ where: { id: String(data.roomId), branchId } });
        if (!room) return reply.code(400).send({ error: 'Room not found in user branch' });
      }

      if (procedureIds) {
        if (procedureIds.length > 0) {
          const proceduresCount = await prisma.procedure.count({
            where: {
              id: { in: procedureIds },
              branchId,
            },
          });
          if (proceduresCount !== procedureIds.length) {
            return reply.code(400).send({ error: 'One or more procedures are invalid for the user branch' });
          }
        }
      }

      const updateData: any = {};
      if (data.name !== undefined) updateData.name = String(data.name).trim();
      if (data.manufacturer !== undefined) updateData.manufacturer = normalizeString(data.manufacturer);
      if (data.model !== undefined) updateData.model = normalizeString(data.model);
      if (data.modality !== undefined) updateData.modality = normalizeString(data.modality);
      if (data.integrationType !== undefined) updateData.integrationType = normalizeString(data.integrationType) || 'MWL_BRIDGE';
      if (data.bridgeIdentifier !== undefined) updateData.bridgeIdentifier = normalizeString(data.bridgeIdentifier);
      if (data.aeTitle !== undefined) updateData.aeTitle = normalizeString(data.aeTitle);
      if (data.mwlRemoteAeTitle !== undefined) updateData.mwlRemoteAeTitle = normalizeString(data.mwlRemoteAeTitle);
      if (data.storeRemoteAeTitle !== undefined) updateData.storeRemoteAeTitle = normalizeString(data.storeRemoteAeTitle);
      if (data.stationName !== undefined) updateData.stationName = normalizeString(data.stationName);
      if (data.serialNumber !== undefined) updateData.serialNumber = normalizeString(data.serialNumber);
      if (data.patrimonyCode !== undefined) updateData.patrimonyCode = normalizeString(data.patrimonyCode);
      if (data.roomId !== undefined) updateData.roomId = normalizeString(data.roomId);
      if (data.mwlHost !== undefined) updateData.mwlHost = normalizeString(data.mwlHost);
      if (data.mwlPort !== undefined) updateData.mwlPort = data.mwlPort === null || data.mwlPort === '' ? null : Number(data.mwlPort);
      if (data.storeHost !== undefined) updateData.storeHost = normalizeString(data.storeHost);
      if (data.storePort !== undefined) updateData.storePort = data.storePort === null || data.storePort === '' ? null : Number(data.storePort);
      if (data.dicomWebPath !== undefined) updateData.dicomWebPath = normalizeString(data.dicomWebPath);
      if (data.supportsWorklist !== undefined) updateData.supportsWorklist = Boolean(data.supportsWorklist);
      if (data.supportsStore !== undefined) updateData.supportsStore = Boolean(data.supportsStore);
      if (data.supportsPrint !== undefined) updateData.supportsPrint = Boolean(data.supportsPrint);
      if (data.status !== undefined) updateData.status = normalizeString(data.status) || 'Ativo';
      if (data.observations !== undefined) updateData.observations = normalizeString(data.observations);
      if (data.isActive !== undefined) updateData.isActive = Boolean(data.isActive);

      const item = await prisma.$transaction(async (tx: any) => {
        if (procedureIds) {
          await tx.medicalEquipmentProcedure.deleteMany({ where: { medicalEquipmentId: id } });
        }

        return tx.medicalEquipment.update({
          where: { id },
          data: {
            ...updateData,
            procedures: procedureIds && procedureIds.length > 0
              ? {
                  createMany: {
                    data: procedureIds.map((procedureId) => ({ procedureId })),
                    skipDuplicates: true,
                  },
                }
              : undefined,
          },
          include: {
            room: { select: { id: true, name: true, branchId: true } },
            procedures: {
              include: {
                procedure: { select: { id: true, name: true, modalities: true } },
              },
            },
          },
        });
      });

      return serializeEquipment(item);
    } catch (err: any) {
      request.log.error({ err }, 'Failed to update medical equipment');
      return reply.code(400).send({ error: 'Failed to update medical equipment', details: err.message });
    }
  });

  app.post('/:id/test-connection', {
    schema: {
      summary: 'Test medical equipment connection',
      tags: ['Medical Equipments'],
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
  }, async (request, reply) => {
    const branchId = await getLoggedBranchId(request);
    if (!branchId) return reply.code(403).send({ error: 'User not associated with a branch' });

    const { id } = request.params as any;
    const equipment = await prisma.medicalEquipment.findFirst({ where: { id, branchId } });
    if (!equipment) return reply.code(404).send({ error: 'Medical equipment not found' });

    const checks: string[] = [];
    let resultStatus = 'SUCCESS';
    let resultMessage = 'Teste executado com sucesso.';

    try {
      if (equipment.integrationType === 'MANUAL') {
        resultStatus = 'SKIPPED';
        resultMessage = 'Equipamento configurado como manual. Nenhum teste automatizado foi executado.';
      } else {
        if (equipment.supportsWorklist && equipment.mwlHost && equipment.mwlPort) {
          await testTcpConnection(equipment.mwlHost, equipment.mwlPort);
          checks.push(`MWL ${equipment.mwlHost}:${equipment.mwlPort} OK`);
        }

        if (equipment.supportsStore && equipment.storeHost && equipment.storePort) {
          await testTcpConnection(equipment.storeHost, equipment.storePort);
          checks.push(`STORE ${equipment.storeHost}:${equipment.storePort} OK`);
        }

        if (equipment.dicomWebPath) {
          await testHttpEndpoint(equipment.dicomWebPath);
          checks.push('DICOMweb respondeu');
        }

        if (checks.length === 0) {
          resultStatus = 'WARNING';
          resultMessage = 'Nenhum endpoint testável foi configurado para este equipamento.';
        } else {
          resultMessage = checks.join(' | ');
        }
      }
    } catch (err: any) {
      resultStatus = 'ERROR';
      resultMessage = err?.message || 'Falha ao testar comunicação';
    }

    const updated = await prisma.medicalEquipment.update({
      where: { id },
      data: {
        lastTestStatus: resultStatus,
        lastTestMessage: resultMessage,
        lastTestedAt: new Date(),
      },
      include: {
        room: { select: { id: true, name: true, branchId: true } },
        procedures: {
          include: {
            procedure: { select: { id: true, name: true, modalities: true } },
          },
        },
      },
    });

    return {
      ok: resultStatus !== 'ERROR',
      status: resultStatus,
      message: resultMessage,
      equipment: serializeEquipment(updated),
    };
  });
}
