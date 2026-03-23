import { FastifyInstance } from 'fastify';
import prisma from '../lib/prisma';
import { isValidCpf, normalizeCpf } from '../../../lib/cpf';
import { isValidEmail, normalizeEmail } from '../../../lib/email';

const normalizeStatusKey = (value?: string | null) => String(value || '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .trim()
  .toUpperCase();

const canonicalStatus = (value?: string | null) => {
  const key = normalizeStatusKey(value);
  if (!key) return '';
  if (key === 'EM ATENDIMENTO') return 'EM_ATENDIMENTO_NA_RECEPCAO';
  return key.replace(/\s+/g, '_');
};

const TRANSITION_RULES: Record<string, string[]> = {
  NA_FILA_DA_RECEPCAO: ['EM_ATENDIMENTO_NA_RECEPCAO', 'CHECKLIST_EM_ANDAMENTO', 'CANCELADO', 'CANCELADA'],
  EM_ATENDIMENTO_NA_RECEPCAO: ['CHECKLIST_EM_ANDAMENTO', 'RECEPCAO_CONCLUIDA', 'CANCELADO', 'CANCELADA'],
  CHECKLIST_EM_ANDAMENTO: ['EM_ATENDIMENTO_NA_RECEPCAO', 'RECEPCAO_CONCLUIDA', 'CANCELADO', 'CANCELADA'],
  RECEPCAO_CONCLUIDA: ['FINALIZADO', 'FINALIZADA', 'CANCELADO', 'CANCELADA'],
  FINALIZADO: [],
  FINALIZADA: [],
  CANCELADO: [],
  CANCELADA: [],
};

const canTransitionStatus = (fromRaw?: string | null, toRaw?: string | null) => {
  const from = canonicalStatus(fromRaw);
  const to = canonicalStatus(toRaw);
  if (!to || from === to) return true;
  if (!from) return true;
  const allowed = TRANSITION_RULES[from];
  if (!Array.isArray(allowed)) return true;
  return allowed.includes(to);
};

const appendStatusAudit = (previousNotes: string | null | undefined, fromStatus?: string | null, toStatus?: string | null, userId?: string | null) => {
  const from = String(fromStatus || '').trim() || 'SEM_STATUS';
  const to = String(toStatus || '').trim() || 'SEM_STATUS';
  if (from === to) return previousNotes || null;

  const timestamp = new Date().toISOString();
  const actor = userId ? `user:${userId}` : 'user:unknown';
  const line = `[status-transition] ${timestamp} ${actor} "${from}" -> "${to}"`;
  return [String(previousNotes || '').trim(), line].filter(Boolean).join('\n');
};

export default async function preAttendanceRoutes(app: FastifyInstance) {
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
      summary: 'List pre-attendances',
      tags: ['PreAttendance'],
      querystring: {
        type: 'object',
        properties: {
          search: { type: 'string' },
          status: { type: 'string' },
          queueType: { type: 'string' },
          limit: { type: 'number', default: 50 },
          offset: { type: 'number', default: 0 },
        },
      },
    },
  }, async (request) => {
    const branchId = await getLoggedBranchId(request);
    if (!branchId) return { items: [], total: 0 };

    const { search, status, queueType, limit = 50, offset = 0 } = request.query as any;

    const where: any = { isActive: true, branchId };
    if (status) where.status = status;
    if (queueType) where.queueType = queueType;
    if (search) {
      where.OR = [
        { fullName: { contains: search, mode: 'insensitive' } },
        { cpf: { contains: search, mode: 'insensitive' } },
        { phone: { contains: search, mode: 'insensitive' } },
      ];
    }

    const [items, total] = await Promise.all([
      prisma.preAttendance.findMany({ where, take: limit, skip: offset, orderBy: { createdAt: 'desc' } }),
      prisma.preAttendance.count({ where }),
    ]);

    return { items, total };
  });

  app.get('/:id', {
    schema: {
      summary: 'Get pre-attendance by ID',
      tags: ['PreAttendance'],
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
  }, async (request, reply) => {
    const branchId = await getLoggedBranchId(request);
    if (!branchId) return reply.code(403).send({ error: 'User not associated with a branch' });

    const { id } = request.params as any;
    const item = await prisma.preAttendance.findFirst({ where: { id, branchId } });
    if (!item) return reply.code(404).send({ error: 'Pre-attendance not found' });
    return item;
  });

  app.post('/', {
    schema: {
      summary: 'Create pre-attendance',
      tags: ['PreAttendance'],
      body: {
        type: 'object',
        required: ['fullName', 'cpf'],
        properties: {
          fullName: { type: 'string' },
          cpf: { type: 'string' },
          patientId: { type: 'string' },
          appointmentId: { type: 'string' },
          birthDate: { type: 'string' },
          gender: { type: 'string' },
          phone: { type: 'string' },
          email: { type: 'string' },
          address: { type: 'string' },
          convenio: { type: 'string' },
          convenioType: { type: 'string' },
          convenioValidUntil: { type: 'string' },
          convenioNumber: { type: 'string' },
          convenioStatus: { type: 'string' },
          convenioNotes: { type: 'string' },
          bloodPressure: { type: 'string' },
          heartRate: { type: 'string' },
          temperature: { type: 'string' },
          oxygenSaturation: { type: 'string' },
          weight: { type: 'string' },
          height: { type: 'string' },
          glucose: { type: 'string' },
          bmi: { type: 'string' },
          mainComplaint: { type: 'string' },
          diseaseHistory: { type: 'string' },
          allergies: { type: 'string' },
          medications: { type: 'string' },
          antecedentes: { type: 'string' },
          triageNotes: { type: 'string' },
          notes: { type: 'string' },
          totem: { type: 'number' },
          status: { type: 'string' },
          queue: { type: 'string' },
          queueType: { type: 'string' },
          agenda: { type: 'string' },
          doctorId: { type: 'string' },
          doctorName: { type: 'string' },
        },
      },
      response: {
        201: { type: 'object' },
        400: { type: 'object', additionalProperties: true },
        403: { type: 'object' },
      },
    },
  }, async (request, reply) => {
    const branchId = await getLoggedBranchId(request);
    if (!branchId) return reply.code(403).send({ error: 'User not associated with a branch' });

    const data = request.body as any;
    const normalizedCpf = normalizeCpf(data?.cpf);
    const normalizedEmail = normalizeEmail(data?.email);
    if (!isValidCpf(normalizedCpf)) {
      return reply.code(400).send({ error: 'CPF inválido' });
    }
    if (data?.email !== undefined && normalizedEmail && !isValidEmail(normalizedEmail)) {
      return reply.code(400).send({ error: 'Email inválido' });
    }

    try {
      const item = await prisma.preAttendance.create({ data: {
        branchId,
        fullName: data.fullName,
        cpf: normalizedCpf,
        patientId: data.patientId || null,
        appointmentId: data.appointmentId || null,
        birthDate: data.birthDate || null,
        gender: data.gender || null,
        phone: data.phone || null,
        email: normalizedEmail || null,
        address: data.address || null,
        convenio: data.convenio || null,
        convenioType: data.convenioType || null,
        convenioValidUntil: data.convenioValidUntil || null,
        convenioNumber: data.convenioNumber || null,
        convenioStatus: data.convenioStatus || null,
        convenioNotes: data.convenioNotes || null,
        bloodPressure: data.bloodPressure || null,
        heartRate: data.heartRate || null,
        temperature: data.temperature || null,
        oxygenSaturation: data.oxygenSaturation || null,
        weight: data.weight || null,
        height: data.height || null,
        glucose: data.glucose || null,
        bmi: data.bmi || null,
        mainComplaint: data.mainComplaint || null,
        diseaseHistory: data.diseaseHistory || null,
        allergies: data.allergies || null,
        medications: data.medications || null,
        antecedentes: data.antecedentes || null,
        triageNotes: data.triageNotes || null,
        notes: data.notes || null,
        totem: data.totem ?? null,
        status: data.status || null,
        queue: data.queue || null,
        queueType: data.queueType || null,
        agenda: data.agenda || null,
        doctorId: data.doctorId || null,
        doctorName: data.doctorName || null,
      } });

      return reply.code(201).send(item);
    } catch (err: any) {
      request.log.error({ err }, 'Failed to create pre-attendance');
      return reply.code(400).send({ error: 'Failed to create pre-attendance', details: err.message });
    }
  });

  app.put('/:id', {
    schema: {
      summary: 'Update pre-attendance',
      tags: ['PreAttendance'],
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      body: { type: 'object' },
      response: {
        200: { type: 'object' },
        400: { type: 'object', additionalProperties: true },
        403: { type: 'object' },
        404: { type: 'object', additionalProperties: true },
      },
    },
  }, async (request, reply) => {
    const branchId = await getLoggedBranchId(request);
    if (!branchId) return reply.code(403).send({ error: 'User not associated with a branch' });

    const { id } = request.params as any;
    const data = request.body as any;
    const normalizedEmail = normalizeEmail(data?.email);
    const userId = String((request.user as any)?.id || '');

    try {
      const existing = await prisma.preAttendance.findFirst({ where: { id, branchId } });
      if (!existing) return reply.code(404).send({ error: 'Pre-attendance not found' });

      const hasStatusChange = typeof data.status === 'string' && data.status.trim().length > 0;
      if (hasStatusChange && !canTransitionStatus(existing.status, data.status)) {
        return reply.code(400).send({
          error: 'Invalid status transition',
          message: `Não é permitido mudar de "${existing.status || 'SEM_STATUS'}" para "${data.status}".`,
        });
      }

      if (data?.email !== undefined && normalizedEmail && !isValidEmail(normalizedEmail)) {
        return reply.code(400).send({ error: 'Email inválido' });
      }

      const nextData = {
        ...data,
        ...(data?.email !== undefined ? { email: normalizedEmail || null } : {}),
        branchId,
        ...(hasStatusChange
          ? { notes: appendStatusAudit(data.notes ?? existing.notes, existing.status, data.status, userId || null) }
          : {}),
      };

      const item = await prisma.preAttendance.update({ where: { id }, data: nextData });
      return item;
    } catch (err: any) {
      request.log.error({ err }, 'Failed to update pre-attendance');
      return reply.code(400).send({ error: 'Failed to update pre-attendance', details: err.message });
    }
  });

  app.delete('/:id', {
    schema: {
      summary: 'Delete pre-attendance',
      tags: ['PreAttendance'],
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
  }, async (request, reply) => {
    const branchId = await getLoggedBranchId(request);
    if (!branchId) return reply.code(403).send({ error: 'User not associated with a branch' });

    const { id } = request.params as any;
    const existing = await prisma.preAttendance.findFirst({ where: { id, branchId } });
    if (!existing) return reply.code(404).send({ error: 'Pre-attendance not found' });
    await prisma.preAttendance.delete({ where: { id } });
    return { message: 'Deleted' };
  });
}
