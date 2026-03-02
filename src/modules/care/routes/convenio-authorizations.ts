import { FastifyInstance } from 'fastify';
import prisma from '../lib/prisma';

type AuthorizationStatus = 'PENDING' | 'AUTHORIZED' | 'DENIED';

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

export default async function convenioAuthorizationRoutes(app: FastifyInstance) {
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
    const { search, statuses, sourceTypes, limit = 2000, offset = 0 } = request.query as any;
    const statusFilter = new Set(parseCsv(statuses).map((item) => item.toUpperCase()));
    const sourceFilter = new Set(parseCsv(sourceTypes).map((item) => item.toUpperCase()));
    const searchText = String(search || '').trim().toLowerCase();

    const [appointments, teaReservations, doctors] = await Promise.all([
      prisma.appointment.findMany({
        where: {
          isActive: true,
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
          OR: [
            { status: { in: ['PENDING_AUTHORIZATION', 'AUTHORIZED'] as any } },
            {
              AND: [
                { status: 'CANCELED' as any },
                { notes: { contains: '[AUTH_DENIED]' } },
              ],
            },
          ],
        },
        include: {
          patient: { select: { name: true, cpf: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: Number(limit),
        skip: Number(offset),
      }),
      prisma.doctor.findMany({
        select: {
          id: true,
          name: true,
          room: { select: { name: true, branch: { select: { tradeName: true, socialName: true } } } },
        },
      }),
    ]);

    const roomByDoctorName = new Map<string, string>();
    doctors.forEach((doctor: any) => {
      const doctorName = String(doctor?.name || '').trim().toLowerCase();
      const roomName = String(doctor?.room?.name || '').trim();
      const branchName = String(doctor?.room?.branch?.tradeName || doctor?.room?.branch?.socialName || '').trim();
      if (!doctorName || !roomName) return;
      roomByDoctorName.set(doctorName, branchName ? `${roomName} (${branchName})` : roomName);
    });

    const mappedAppointments = appointments.map((item: any) => ({
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
      status: toStatus(item.authorizationStatus),
      rawStatus: String(item.authorizationStatus || 'PENDING'),
      notes: item.authorizationNotes || null,
      updatedAt: item.updatedAt,
    }));

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
        status: groupedStatus,
        rawStatus: entries.map((item: any) => String(item?.status || '')).join(','),
        notes: entries.find((item: any) => item?.notes)?.notes || null,
        updatedAt: first?.updatedAt,
        sessionsCount: entries.length,
      };
    });

    const combined = [...mappedAppointments, ...mappedTeaReservations]
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
    const { sourceType, id } = request.params as { sourceType: string; id: string };
    const { status, notes } = request.body as { status: AuthorizationStatus; notes?: string };

    const source = String(sourceType || '').toUpperCase();
    const targetStatus = toStatus(status);

    if (source === 'APPOINTMENT') {
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
      const seriesItems = await prisma.teaPreReservation.findMany({
        where: {
          pitTherapyId: id,
          OR: [
            { status: { in: ['PENDING_AUTHORIZATION', 'AUTHORIZED'] as any } },
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
              { status: { in: ['PENDING_AUTHORIZATION', 'AUTHORIZED'] as any } },
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
