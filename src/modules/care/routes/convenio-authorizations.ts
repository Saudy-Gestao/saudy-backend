import { randomBytes } from 'crypto';
import { FastifyInstance } from 'fastify';
import prisma from '../lib/prisma';
import { getAnexosStorage } from '../../../lib/storage';

type AuthorizationStatus = 'PENDING' | 'AUTHORIZED' | 'DENIED';
type SourceType = 'APPOINTMENT' | 'TEA';

const parseCsv = (value: unknown): string[] => (
  String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
);

const toStatus = (value: unknown): AuthorizationStatus => {
  const normalized = String(value || '').toUpperCase().trim();
  if (normalized === 'AUTHORIZED') return 'AUTHORIZED';
  if (normalized === 'DENIED') return 'DENIED';
  return 'PENDING';
};

const sanitizeFileName = (value: string) => String(value || 'arquivo')
  .replace(/[^a-zA-Z0-9._-]/g, '_')
  .replace(/_+/g, '_')
  .slice(0, 120);

const decodeBase64 = (raw: string): Buffer => {
  const trimmed = String(raw || '').trim();
  const normalized = trimmed.includes(',') ? trimmed.split(',').pop() || '' : trimmed;
  return Buffer.from(normalized, 'base64');
};

const makeObjectSuffix = () => randomBytes(8).toString('hex');

const sanitizeAuthorizationNotes = (value?: string | null) => (
  String(value || '')
    .replace(/\[AUTH_DENIED\]\s*/g, '')
    .trim()
);

export default async function convenioAuthorizationRoutes(app: FastifyInstance) {
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
      summary: 'List convenio authorizations',
      tags: ['ConvenioAuthorization'],
      querystring: {
        type: 'object',
        properties: {
          search: { type: 'string' },
          statuses: { type: 'string' },
          sourceTypes: { type: 'string' },
          limit: { type: 'number', default: 2000 },
          offset: { type: 'number', default: 0 },
        },
      },
    },
  }, async (request) => {
    const branchId = await getLoggedBranchId(request);
    if (!branchId) return { total: 0, items: [] };

    const { search, statuses, sourceTypes, limit = 2000, offset = 0 } = request.query as any;
    const statusFilter = new Set(parseCsv(statuses).map((item) => item.toUpperCase()));
    const sourceFilter = new Set(parseCsv(sourceTypes).map((item) => item.toUpperCase()));
    const searchText = String(search || '').trim().toLowerCase();

    const doctors = await prisma.doctor.findMany({
      // `roomId` is an optional physical-room assignment, not how doctors are
      // actually scoped to a branch elsewhere in the app — filtering on
      // `room.branchId` silently dropped any doctor without a room set, which
      // then made every one of their appointments/TEA reservations disappear
      // from this screen (professionalDoctorId never matched `doctorIds`).
      where: {
        branchId,
      },
      select: {
        id: true,
        name: true,
        room: { select: { name: true, branch: { select: { tradeName: true } } } },
      },
    });
    const doctorIds = doctors.map((item: any) => String(item.id));
    const doctorNames = doctors.map((item: any) => String(item.name || '').trim()).filter(Boolean);

    const [appointments, teaReservations] = await Promise.all([
      prisma.appointment.findMany({
        where: {
          isActive: true,
          branchId,
          NOT: {
            type: 'RETORNO TEA',
          },
        },
        orderBy: { createdAt: 'desc' },
        take: Number(limit),
        skip: Number(offset),
      }),
      prisma.teaPreReservation.findMany({
        where: {
          professionalDoctorId: doctorIds.length > 0 ? { in: doctorIds } : undefined,
          pit: {
            status: { notIn: ['Inativo', 'CONCLUIDO', 'Concluído'] },
          },
          pitTherapy: {
            isActive: true,
          },
          OR: [
            // CONVERTED is included so therapies that already went through PIT
            // conversion don't just disappear from this screen — they keep
            // showing as authorized (see mappedStatuses below, which only
            // counts a CONVERTED entry as AUTHORIZED if it actually was).
            { status: { in: ['PENDING_AUTHORIZATION', 'AUTHORIZED', 'CONVERTED'] as any } },
            {
              AND: [
                { status: 'CANCELED' as any },
                { notes: { contains: '[AUTH_DENIED]' } },
              ],
            },
          ],
        },
        include: {
          patient: { select: { name: true, cpf: true, hasHealthInsurance: true, healthInsuranceName: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: Number(limit),
        skip: Number(offset),
      }),
    ]);

    const roomByDoctorName = new Map<string, string>();
    doctors.forEach((doctor: any) => {
      const doctorName = String(doctor?.name || '').trim().toLowerCase();
      const roomName = String(doctor?.room?.name || '').trim();
      const branchName = String(doctor?.room?.branch?.tradeName || '').trim();
      if (!doctorName || !roomName) return;
      roomByDoctorName.set(doctorName, branchName ? `${roomName} (${branchName})` : roomName);
    });

    const mappedAppointments = appointments
      .filter((item: any) => {
        const doctorName = String(item?.doctorName || '').trim();
        return doctorName ? doctorNames.includes(doctorName) : true;
      })
      .map((item: any) => {
        const convenioName = String(item?.convenio || '').trim();
        return {
          id: String(item.id),
          sourceType: 'APPOINTMENT',
          sourceLabel: 'Agendamento',
          patientName: String(item.patientName || ''),
          patientCpf: String(item.patientCpf || ''),
          procedureName: String(item.specialty || item.type || ''),
          doctorName: String(item.doctorName || ''),
          roomName: roomByDoctorName.get(String(item.doctorName || '').trim().toLowerCase()) || null,
          date: String(item.date || ''),
          time: String(item.time || ''),
          insuranceType: convenioName ? 'CONVENIO' : 'PARTICULAR',
          insuranceName: convenioName || 'Particular',
          status: toStatus(item.authorizationStatus),
          rawStatus: String(item.authorizationStatus || 'PENDING'),
          notes: item.authorizationNotes || null,
          updatedAt: item.updatedAt,
        };
      });

    const teaByTherapy = new Map<string, any[]>();
    teaReservations.forEach((item: any) => {
      const key = String(item?.pitTherapyId || '').trim() || `single-${String(item?.id || '')}`;
      if (!teaByTherapy.has(key)) teaByTherapy.set(key, []);
      teaByTherapy.get(key)!.push(item);
    });

    const mappedTeaReservations = Array.from(teaByTherapy.entries()).map(([pitTherapyId, entries]) => {
      const sortedByDate = [...entries].sort((a: any, b: any) => {
        const dateA = a?.suggestedDate ? new Date(a.suggestedDate).getTime() : Number.MAX_SAFE_INTEGER;
        const dateB = b?.suggestedDate ? new Date(b.suggestedDate).getTime() : Number.MAX_SAFE_INTEGER;
        if (dateA !== dateB) return dateA - dateB;
        return String(a?.suggestedTime || '').localeCompare(String(b?.suggestedTime || ''));
      });
      const first = sortedByDate[0] || entries[0];
      const mappedStatuses = entries.map((item: any) => {
        const raw = String(item?.status || '').toUpperCase();
        if (raw === 'AUTHORIZED') return 'AUTHORIZED' as AuthorizationStatus;
        // A converted reservation only reflects a real authorization if it actually
        // went through that step (authorizedAt set) — conversion is also allowed
        // straight from RESERVED, which was never authorized.
        if (raw === 'CONVERTED' && item?.authorizedAt) return 'AUTHORIZED' as AuthorizationStatus;
        if (raw === 'CANCELED' && String(item?.notes || '').includes('[AUTH_DENIED]')) return 'DENIED' as AuthorizationStatus;
        return 'PENDING' as AuthorizationStatus;
      });

      const hasPending = mappedStatuses.includes('PENDING');
      const hasAuthorized = mappedStatuses.includes('AUTHORIZED');
      const hasDenied = mappedStatuses.includes('DENIED');
      let groupedStatus: AuthorizationStatus = 'PENDING';
      if (hasPending) groupedStatus = 'PENDING';
      else if (hasAuthorized && !hasDenied) groupedStatus = 'AUTHORIZED';
      else if (hasDenied && !hasAuthorized) groupedStatus = 'DENIED';
      else groupedStatus = 'PENDING';

      return {
        id: pitTherapyId,
        sourceType: 'TEA',
        sourceLabel: 'Pré-Reserva',
        patientName: String(first?.patient?.name || ''),
        patientCpf: String(first?.patient?.cpf || ''),
        procedureName: String(first?.procedureName || ''),
        doctorName: String(first?.professionalName || ''),
        roomName: roomByDoctorName.get(String(first?.professionalName || '').trim().toLowerCase()) || null,
        date: first?.suggestedDate ? new Date(first.suggestedDate).toISOString().slice(0, 10) : '',
        time: String(first?.suggestedTime || ''),
        insuranceType: String(first?.patient?.healthInsuranceName || '').trim() ? 'CONVENIO' : 'PARTICULAR',
        insuranceName: String(first?.patient?.healthInsuranceName || '').trim() || 'Particular',
        status: groupedStatus,
        rawStatus: entries.map((item: any) => String(item?.status || '')).join(','),
        notes: sanitizeAuthorizationNotes(entries.find((item: any) => item?.notes)?.notes),
        updatedAt: first?.updatedAt,
        sessionsCount: entries.length,
      };
    });

    const appointmentIds = mappedAppointments.map((item: any) => String(item.id));
    const teaTherapyIds = mappedTeaReservations.map((item: any) => String(item.id));
    const attachments = (appointmentIds.length > 0 || teaTherapyIds.length > 0)
      ? await prisma.convenioAuthorizationAttachment.findMany({
          where: {
            branchId,
            isActive: true,
            OR: [
              ...(appointmentIds.length > 0 ? [{ sourceType: 'APPOINTMENT', appointmentId: { in: appointmentIds } }] : []),
              ...(teaTherapyIds.length > 0 ? [{ sourceType: 'TEA', pitTherapyId: { in: teaTherapyIds } }] : []),
            ],
          },
          orderBy: { uploadedAt: 'desc' },
        })
      : [];

    const attachmentMap = new Map<string, any[]>();
    attachments.forEach((item: any) => {
      const sourceType = String(item?.sourceType || '').toUpperCase();
      const sourceId = sourceType === 'TEA' ? String(item?.pitTherapyId || '') : String(item?.appointmentId || '');
      if (!sourceType || !sourceId) return;
      const key = `${sourceType}:${sourceId}`;
      if (!attachmentMap.has(key)) attachmentMap.set(key, []);
      attachmentMap.get(key)!.push(item);
    });

    const withAttachmentSummary = (item: any) => {
      const key = `${String(item.sourceType || '').toUpperCase()}:${String(item.id || '')}`;
      const docs = attachmentMap.get(key) || [];
      return {
        ...item,
        attachmentsCount: docs.length,
        attachments: docs.slice(0, 5).map((doc: any) => ({
          id: doc.id,
          fileName: doc.fileName,
          mimeType: doc.mimeType || null,
          uploadedAt: doc.uploadedAt,
        })),
      };
    };

    const combined = [...mappedAppointments, ...mappedTeaReservations]
      .map(withAttachmentSummary)
      .filter((item) => (sourceFilter.size === 0 || sourceFilter.has(String(item.sourceType).toUpperCase())))
      .filter((item) => (statusFilter.size === 0 || statusFilter.has(String(item.status).toUpperCase())))
      .filter((item) => {
        if (!searchText) return true;
        return [
          item.patientName,
          item.patientCpf,
          item.procedureName,
          item.doctorName,
          item.roomName || '',
          item.date,
          item.time,
        ].some((value) => String(value || '').toLowerCase().includes(searchText));
      })
      .sort((a: any, b: any) => {
        const aDate = `${a.date || '9999-12-31'} ${a.time || '23:59'}`;
        const bDate = `${b.date || '9999-12-31'} ${b.time || '23:59'}`;
        return aDate.localeCompare(bDate);
      });

    return {
      total: combined.length,
      items: combined,
    };
  });

  app.get('/:sourceType/:id/attachments', {
    schema: {
      summary: 'List authorization attachments by source',
      tags: ['ConvenioAuthorization'],
      params: {
        type: 'object',
        required: ['sourceType', 'id'],
        properties: {
          sourceType: { type: 'string' },
          id: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const branchId = await getLoggedBranchId(request);
    if (!branchId) return reply.code(403).send({ error: 'User not associated with a branch' });

    const { sourceType, id } = request.params as { sourceType: string; id: string };
    const source = String(sourceType || '').toUpperCase() as SourceType;
    if (source !== 'APPOINTMENT' && source !== 'TEA') {
      return reply.code(400).send({ error: 'Invalid sourceType. Use APPOINTMENT or TEA.' });
    }

    const where = source === 'TEA'
      ? { branchId, sourceType: source, pitTherapyId: id, isActive: true }
      : { branchId, sourceType: source, appointmentId: id, isActive: true };

    const items = await prisma.convenioAuthorizationAttachment.findMany({
      where,
      orderBy: { uploadedAt: 'desc' },
    });

    return {
      total: items.length,
      items: items.map((item: any) => ({
        id: item.id,
        fileName: item.fileName,
        mimeType: item.mimeType || null,
        sizeBytes: item.sizeBytes || null,
        uploadedAt: item.uploadedAt,
      })),
    };
  });

  app.get('/attachments/:attachmentId/view', {
    schema: {
      summary: 'View authorization attachment',
      tags: ['ConvenioAuthorization'],
      params: {
        type: 'object',
        required: ['attachmentId'],
        properties: {
          attachmentId: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const branchId = await getLoggedBranchId(request);
    if (!branchId) return reply.code(403).send({ error: 'User not associated with a branch' });

    const { attachmentId } = request.params as { attachmentId: string };
    const attachment = await prisma.convenioAuthorizationAttachment.findFirst({
      where: { id: attachmentId, branchId, isActive: true },
    });
    if (!attachment) return reply.code(404).send({ error: 'Attachment not found' });

    const storage = getAnexosStorage();
    const fileExists = await storage.exists(attachment.gcsObjectName);
    if (!fileExists) return reply.code(404).send({ error: 'Arquivo não encontrado no storage' });

    reply.header('Content-Type', attachment.mimeType || 'application/octet-stream');
    reply.header('Content-Disposition', `inline; filename="${attachment.fileName || 'anexo'}"`);
    return reply.send(storage.createReadStream(attachment.gcsObjectName));
  });

  app.post('/:sourceType/:id/attachments', {
    bodyLimit: 10 * 1024 * 1024,
    schema: {
      summary: 'Upload attachment for authorization item',
      tags: ['ConvenioAuthorization'],
      params: {
        type: 'object',
        required: ['sourceType', 'id'],
        properties: {
          sourceType: { type: 'string' },
          id: { type: 'string' },
        },
      },
      body: {
        type: 'object',
        required: ['fileName', 'fileBase64'],
        properties: {
          fileName: { type: 'string' },
          fileBase64: { type: 'string' },
          mimeType: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const branchId = await getLoggedBranchId(request);
    if (!branchId) return reply.code(403).send({ error: 'User not associated with a branch' });

    const userId = String((request.user as any)?.id || '');
    const { sourceType, id } = request.params as { sourceType: string; id: string };
    const payload = request.body as { fileName: string; fileBase64: string; mimeType?: string };
    const source = String(sourceType || '').toUpperCase() as SourceType;

    if (source !== 'APPOINTMENT' && source !== 'TEA') {
      return reply.code(400).send({ error: 'Invalid sourceType. Use APPOINTMENT or TEA.' });
    }

    if (source === 'APPOINTMENT') {
      const existing = await prisma.appointment.findFirst({ where: { id, branchId, isActive: true } });
      if (!existing) return reply.code(404).send({ error: 'Appointment authorization item not found' });
    } else {
      const existingTea = await prisma.teaPreReservation.findFirst({
        where: { pitTherapyId: id },
        select: { id: true },
      });
      if (!existingTea) return reply.code(404).send({ error: 'TEA authorization series not found' });
    }

    const safeFileName = sanitizeFileName(payload.fileName || 'anexo');
    const buffer = decodeBase64(payload.fileBase64);
    if (!buffer || buffer.length === 0) {
      return reply.code(400).send({ error: 'Arquivo inválido' });
    }

    const objectName = `convenio-authorizations/${branchId}/${source.toLowerCase()}/${id}/${Date.now()}_${makeObjectSuffix()}_${safeFileName}`;
    await getAnexosStorage().save(objectName, buffer, {
      contentType: payload.mimeType || 'application/octet-stream',
      metadata: {
        branchId,
        sourceType: source,
        sourceId: id,
        uploadedByUserId: userId || '',
      },
    });

    const created = await prisma.convenioAuthorizationAttachment.create({
      data: {
        branchId,
        sourceType: source,
        appointmentId: source === 'APPOINTMENT' ? id : null,
        pitTherapyId: source === 'TEA' ? id : null,
        fileName: safeFileName,
        mimeType: payload.mimeType || null,
        sizeBytes: buffer.length,
        gcsObjectName: objectName,
        uploadedByUserId: userId || null,
      },
    });

    return reply.code(201).send({
      message: 'Anexo enviado com sucesso',
      item: {
        id: created.id,
        fileName: created.fileName,
        mimeType: created.mimeType,
        sizeBytes: created.sizeBytes,
        uploadedAt: created.uploadedAt,
      },
    });
  });

  app.patch('/:sourceType/:id', {
    schema: {
      summary: 'Update convenio authorization status',
      tags: ['ConvenioAuthorization'],
      params: {
        type: 'object',
        properties: {
          sourceType: { type: 'string' },
          id: { type: 'string' },
        },
        required: ['sourceType', 'id'],
      },
      body: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['PENDING', 'AUTHORIZED', 'DENIED'] },
          notes: { type: 'string' },
        },
        required: ['status'],
      },
    },
  }, async (request, reply) => {
    const branchId = await getLoggedBranchId(request);
    if (!branchId) return reply.code(403).send({ error: 'User not associated with a branch' });

    const { sourceType, id } = request.params as { sourceType: string; id: string };
    const { status, notes } = request.body as { status: AuthorizationStatus; notes?: string };

    const source = String(sourceType || '').toUpperCase();
    const targetStatus = toStatus(status);

    if (source === 'APPOINTMENT') {
      const existing = await prisma.appointment.findFirst({
        where: { id, branchId, isActive: true },
      });
      if (!existing) {
        return reply.code(404).send({ error: 'Appointment authorization item not found' });
      }

      const updated = await prisma.appointment.update({
        where: { id },
        data: {
          authorizationStatus: targetStatus,
          authorizationNotes: notes || null,
          authorizedAt: targetStatus === 'AUTHORIZED' ? new Date() : null,
        },
      });
      return updated;
    }

    if (source === 'TEA') {
      // Same fix as the list endpoint: scope by the doctor's actual branchId,
      // not the optional room assignment — otherwise authorizing/denying a
      // therapy whose professional has no room set fails with a false
      // "not found", even though the reservation is right there.
      const doctors = await prisma.doctor.findMany({
        where: {
          branchId,
        },
        select: { id: true },
      });
      const doctorIds = doctors.map((item: any) => String(item.id));

      const seriesItems = await prisma.teaPreReservation.findMany({
        where: {
          pitTherapyId: id,
          professionalDoctorId: doctorIds.length > 0 ? { in: doctorIds } : undefined,
          OR: [
            { status: { in: ['PROPOSED', 'PENDING_AUTHORIZATION', 'AUTHORIZED'] as any } },
            {
              AND: [
                { status: 'CANCELED' as any },
                { notes: { contains: '[AUTH_DENIED]' } },
              ],
            },
          ],
        },
        select: { id: true },
      });

      if (!seriesItems.length) {
        return reply.code(404).send({ error: 'TEA authorization series not found' });
      }

      const teaStatus = targetStatus === 'AUTHORIZED'
        ? 'AUTHORIZED'
        : (targetStatus === 'DENIED' ? 'CANCELED' : 'PENDING_AUTHORIZATION');

      const mergedNotes = targetStatus === 'DENIED'
        ? `[AUTH_DENIED] ${notes || ''}`.trim()
        : (notes || null);

      const actor = String((request.user as any)?.name || (request.user as any)?.email || 'SYSTEM');
      const now = new Date();

      await prisma.$transaction(async (tx: any) => {
        await tx.teaPreReservation.updateMany({
          where: {
            pitTherapyId: id,
            OR: [
              { status: { in: ['PROPOSED', 'PENDING_AUTHORIZATION', 'AUTHORIZED'] as any } },
              {
                AND: [
                  { status: 'CANCELED' as any },
                  { notes: { contains: '[AUTH_DENIED]' } },
                ],
              },
            ],
          },
          data: {
            status: teaStatus as any,
            notes: mergedNotes,
            authorizedAt: targetStatus === 'AUTHORIZED' ? now : null,
          },
        });

        await tx.teaPreReservationTimeline.createMany({
          data: seriesItems.map((item: any) => ({
            preReservationId: item.id,
            eventType: 'AUTHORIZATION_STATUS_CHANGED',
            eventLabel: `Status de autorização atualizado para ${targetStatus}`,
            actor,
            payload: {
              source: 'CONVENIO_AUTHORIZATION_MODULE',
              scope: 'SERIES',
              status: targetStatus,
              teaStatus,
              notes: mergedNotes,
            },
          })),
        });
      });

      return { ok: true, pitTherapyId: id, affected: seriesItems.length };
    }

    return reply.code(400).send({ error: 'Invalid sourceType. Use APPOINTMENT or TEA.' });
  });
}

