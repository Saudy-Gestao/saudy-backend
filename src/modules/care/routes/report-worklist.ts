import { FastifyInstance } from 'fastify';
import prisma from '../lib/prisma';

const APPOINTMENT_SELECT = {
  id: true,
  patientName: true,
  patientCpf: true,
  specialty: true,
  date: true,
  time: true,
  convenio: true,
  doctorName: true,
  status: true,
  branchId: true,
  isActive: true,
};

const composeScheduledAtFromAppointment = (appointment: any) => {
  if (!appointment?.date) return null;
  return appointment.time ? `${appointment.date} ${appointment.time}` : String(appointment.date);
};

const toWorklistView = (item: any, appointment: any | null) => ({
  ...item,
  appointmentId: item.appointmentId || appointment?.id || null,
  patientName: appointment?.patientName || item.patientName,
  patientCpf: appointment?.patientCpf || item.patientCpf,
  examType: appointment?.specialty || item.examType,
  scheduledAt: composeScheduledAtFromAppointment(appointment) || item.scheduledAt,
  convenio: appointment?.convenio || item.convenio,
  requestingDoctor: appointment?.doctorName || item.requestingDoctor,
  appointment: appointment || null,
});

export default async function reportWorklistRoutes(app: FastifyInstance) {
  const getLoggedContext = async (request: any) => {
    const userId = (request.user as any)?.id;
    if (!userId) return { branchId: null, doctorName: null, doctorId: null };
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        sector: { include: { branch: true } },
        doctor: { select: { id: true, name: true } },
      },
    });
    return {
      branchId: user?.sector?.branch?.id || null,
      doctorName: user?.doctor?.name || null,
      doctorId: user?.doctor?.id || null,
    };
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
      summary: 'List report worklist items',
      tags: ['Report Worklist'],
      querystring: {
        type: 'object',
        properties: {
          search: { type: 'string' },
          status: { type: 'string' },
          examType: { type: 'string' },
          appointmentId: { type: 'string' },
          limit: { type: 'number', default: 50 },
          offset: { type: 'number', default: 0 },
        },
      },
    },
  }, async (request, reply) => {
    const context = await getLoggedContext(request);
    const branchId = context?.branchId;
    if (!branchId) return (reply as any).code(403).send({ error: 'User not associated with a branch' });

    const { search, status, examType, appointmentId, limit = 50, offset = 0 } = request.query as any;

    // show items that either belong to this branch or have no branch assigned (imported by poller)
    const where: any = { isActive: true, OR: [{ branchId }, { branchId: null }] };
    if (status) where.status = status;
    if (examType) where.examType = examType;
    if (appointmentId) where.appointmentId = String(appointmentId);
    if (search) {
      where.AND = where.AND || [];
      where.AND.push({
        OR: [
          { patientName: { contains: search, mode: 'insensitive' } },
          { patientCpf: { contains: search, mode: 'insensitive' } },
          { examType: { contains: search, mode: 'insensitive' } },
          { accessionNumber: { contains: search, mode: 'insensitive' } },
        ],
      });
    }
    if (context?.doctorName) {
      where.AND = where.AND || [];
      where.AND.push({
        OR: [
          { requestingDoctor: { equals: context.doctorName, mode: 'insensitive' } },
          { appointment: { doctorName: { equals: context.doctorName, mode: 'insensitive' } } },
        ],
      });
    }

    const [items, total] = await Promise.all([
      prisma.reportWorklistItem.findMany({ where, take: limit, skip: offset, orderBy: { createdAt: 'desc' } }),
      prisma.reportWorklistItem.count({ where }),
    ]);

    const appointmentIds = Array.from(
      new Set((items as any[]).map((item: any) => item.appointmentId).filter(Boolean)),
    );
    const appointments = appointmentIds.length
      ? await prisma.appointment.findMany({
          where: {
            id: { in: appointmentIds as string[] },
            isActive: true,
          },
          select: APPOINTMENT_SELECT,
        })
      : [];
    const appointmentById = new Map<string, any>((appointments as any[]).map((it: any) => [it.id, it]));

    const itemIds = (items as any[]).map((item: any) => item.id);
    const addendumCounts = itemIds.length
      ? await prisma.reportAddendum.groupBy({
          by: ['worklistItemId'],
          where: {
            branchId,
            isActive: true,
            status: 'finalizado',
            worklistItemId: { in: itemIds },
          },
          _count: { _all: true },
        })
      : [];

    const addendumCountByItemId = new Map<string, number>(
      (addendumCounts as any[]).map((row: any) => [String(row.worklistItemId), Number(row._count?._all || 0)]),
    );

    const itemsWithFlags = (items as any[]).map((item: any) => ({
      ...toWorklistView(item, item.appointmentId ? appointmentById.get(item.appointmentId) || null : null),
      hasFinalizedAddendum: Boolean((addendumCountByItemId.get(item.id) || 0) > 0),
    }));

    return { items: itemsWithFlags, total };
  });

  app.get('/:id', {
    schema: {
      summary: 'Get report worklist item by ID',
      tags: ['Report Worklist'],
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
  }, async (request, reply) => {
    const context = await getLoggedContext(request);
    const branchId = context?.branchId;
    if (!branchId) return (reply as any).code(403).send({ error: 'User not associated with a branch' });

    const { id } = request.params as any;
    const item = await prisma.reportWorklistItem.findFirst({ where: { id, OR: [{ branchId }, { branchId: null }] } });
    if (!item) return reply.code(404).send({ error: 'Report worklist item not found' });

    const appointment = item.appointmentId
      ? await prisma.appointment.findFirst({
          where: {
            id: item.appointmentId,
            isActive: true,
          },
          select: APPOINTMENT_SELECT,
        })
      : null;

    if (context?.doctorName) {
      const isRequestingDoctorMatch = String(item.requestingDoctor || '').trim().toLowerCase() === String(context.doctorName || '').trim().toLowerCase();
      const isAppointmentDoctorMatch = String(appointment?.doctorName || '').trim().toLowerCase() === String(context.doctorName || '').trim().toLowerCase();
      if (!isRequestingDoctorMatch && !isAppointmentDoctorMatch) {
        return reply.code(404).send({ error: 'Report worklist item not found' });
      }
    }

    const finalizedAddendumCount = await prisma.reportAddendum.count({
      where: {
        branchId,
        worklistItemId: id,
        isActive: true,
        status: 'finalizado',
      },
    });

    return {
      ...toWorklistView(item, appointment),
      hasFinalizedAddendum: finalizedAddendumCount > 0,
    };
  });

  app.post('/', {
    schema: {
      summary: 'Create report worklist item',
      tags: ['Report Worklist'],
      body: {
        type: 'object',
        properties: {
          appointmentId: { type: 'string' },
          externalStudyId: { type: 'string' },
          accessionNumber: { type: 'string' },
          patientCpf: { type: 'string' },
          patientBirthDate: { type: 'string' },
          reportText: { type: 'string' },
          issuerSignedAt: { type: 'string' },
          reviewerSignedAt: { type: 'string' },
          dicomStudyUid: { type: 'string' },
          dicomSeriesUid: { type: 'string' },
          dicomPath: { type: 'string' },
          dicomUrl: { type: 'string' },
          dicomReceivedAt: { type: 'string', format: 'date-time' },
          metadata: { type: 'object', additionalProperties: true },
        },
      },
      response: {
        201: { type: 'object' },
        400: { type: 'object', additionalProperties: true },
      },
    },
  }, async (request, reply) => {
    const context = await getLoggedContext(request);
    const branchId = context?.branchId;
    if (!branchId) return (reply as any).code(403).send({ error: 'User not associated with a branch' });

    const data = request.body as any;

    try {
      const appointmentId = data.appointmentId ? String(data.appointmentId) : null;
      const appointment = appointmentId
        ? await prisma.appointment.findFirst({
            where: {
              id: appointmentId,
              branchId,
              isActive: true,
            },
            select: APPOINTMENT_SELECT,
          })
        : null;

      if (appointmentId && !appointment) {
        return reply.code(400).send({ error: 'Invalid appointmentId for this branch' });
      }

      const patientName = String(appointment?.patientName || data.patientName || '').trim();
      const examType = String(appointment?.specialty || data.examType || '').trim();

      if (!appointment && !data.patientCpf) {
        return reply.code(400).send({ error: 'patientCpf is required when no appointmentId provided' });
      }

      if (!appointment && !patientName) {
        return reply.code(400).send({ error: 'patientName is required when no appointmentId provided' });
      }

      if (!appointment && !examType) {
        return reply.code(400).send({ error: 'examType is required when no appointmentId provided' });
      }

      const baseData: any = {
        branchId,
        appointmentId,
        externalStudyId: data.externalStudyId || null,
        accessionNumber: data.accessionNumber || null,
        patientCpf: appointment?.patientCpf || data.patientCpf || null,
        patientBirthDate: data.patientBirthDate || null,
        reportText: data.reportText || null,
        issuerSignedAt: data.issuerSignedAt || null,
        reviewerSignedAt: data.reviewerSignedAt || null,
        dicomStudyUid: data.dicomStudyUid || null,
        dicomSeriesUid: data.dicomSeriesUid || null,
        dicomPath: data.dicomPath || null,
        dicomUrl: data.dicomUrl || null,
        dicomReceivedAt: data.dicomReceivedAt || null,
        metadata: data.metadata || null,
      };

      const existingByAppointment = appointmentId
        ? await prisma.reportWorklistItem.findFirst({
            where: {
              appointmentId,
              OR: [{ branchId }, { branchId: null }],
            },
          })
        : null;

      const item = existingByAppointment
        ? await prisma.reportWorklistItem.update({
            where: { id: existingByAppointment.id },
            data: baseData,
          })
        : await prisma.reportWorklistItem.create({
            data: baseData,
          });

      const linkedAppointment = item.appointmentId
        ? await prisma.appointment.findUnique({ where: { id: item.appointmentId }, select: APPOINTMENT_SELECT })
        : null;

      return reply.code(201).send(toWorklistView(item, linkedAppointment));
    } catch (err: any) {
      request.log.error({ err }, 'Failed to create report worklist item');
      return reply.code(400).send({ error: 'Failed to create report worklist item', details: err.message });
    }
  });

  app.put('/:id', {
    schema: {
      summary: 'Update report worklist item',
      tags: ['Report Worklist'],
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      body: { type: 'object' },
      response: {
        200: { type: 'object' },
        400: { type: 'object', additionalProperties: true },
        404: { type: 'object', additionalProperties: true },
      },
    },
  }, async (request, reply) => {
    const context = await getLoggedContext(request);
    const branchId = context?.branchId;
    if (!branchId) return (reply as any).code(403).send({ error: 'User not associated with a branch' });

    const { id } = request.params as any;
    const data = request.body as any;

    try {
      const existing = await prisma.reportWorklistItem.findFirst({ where: { id, OR: [{ branchId }, { branchId: null }] } });
      if (!existing) return reply.code(404).send({ error: 'Report worklist item not found' });

      const isAttemptingUnfinalize =
        existing.status === 'finalizado'
        && typeof data?.status === 'string'
        && data.status !== 'finalizado';

      if (isAttemptingUnfinalize) {
        const finalizedAddendumCount = await prisma.reportAddendum.count({
          where: {
            branchId,
            worklistItemId: id,
            isActive: true,
            status: 'finalizado',
          },
        });

        if (finalizedAddendumCount > 0) {
          return reply.code(400).send({ error: 'Cannot unfinalize report with finalized addendum' });
        }
      }

      const nextAppointmentId = typeof data.appointmentId !== 'undefined'
        ? (data.appointmentId ? String(data.appointmentId) : null)
        : existing.appointmentId;

      const appointment = nextAppointmentId
        ? await prisma.appointment.findFirst({
            where: {
              id: nextAppointmentId,
              branchId,
              isActive: true,
            },
            select: APPOINTMENT_SELECT,
          })
        : null;

      if (nextAppointmentId && !appointment) {
        return reply.code(400).send({ error: 'Invalid appointmentId for this branch' });
      }

      const updateData: any = {
        ...data,
        branchId,
        appointmentId: nextAppointmentId,
      };

      if (appointment) {
        updateData.patientName = appointment.patientName || existing.patientName;
        updateData.patientCpf = appointment.patientCpf || existing.patientCpf;
        updateData.examType = appointment.specialty || existing.examType;
        updateData.scheduledAt = composeScheduledAtFromAppointment(appointment) || existing.scheduledAt;
        updateData.convenio = appointment.convenio || existing.convenio;
        updateData.requestingDoctor = appointment.doctorName || existing.requestingDoctor;
      }

      const item = await prisma.reportWorklistItem.update({ where: { id }, data: updateData });
      const linkedAppointment = item.appointmentId
        ? await prisma.appointment.findUnique({ where: { id: item.appointmentId }, select: APPOINTMENT_SELECT })
        : null;

      return toWorklistView(item, linkedAppointment);
    } catch (err: any) {
      request.log.error({ err }, 'Failed to update report worklist item');
      return reply.code(400).send({ error: 'Failed to update report worklist item', details: err.message });
    }
  });

  app.delete('/:id', {
    schema: {
      summary: 'Delete report worklist item',
      tags: ['Report Worklist'],
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
  }, async (request, reply) => {
    const context = await getLoggedContext(request);
    const branchId = context?.branchId;
    if (!branchId) return (reply as any).code(403).send({ error: 'User not associated with a branch' });

    const { id } = request.params as any;
    const existing = await prisma.reportWorklistItem.findFirst({ where: { id, OR: [{ branchId }, { branchId: null }] } });
    if (!existing) return reply.code(404).send({ error: 'Report worklist item not found' });
    await prisma.reportWorklistItem.delete({ where: { id } });
    return { message: 'Deleted' };
  });
}
