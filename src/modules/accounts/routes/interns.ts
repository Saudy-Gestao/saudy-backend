import { FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';
import prisma from '../lib/prisma';

type WorkingSchedule = { days: string[]; hoursStart: string; hoursEnd: string };

const normalizeIds = (value: unknown) => Array.from(new Set(
  (Array.isArray(value) ? value : [])
    .map((id) => String(id || '').trim())
    .filter(Boolean),
));

const parseDate = (value: unknown) => {
  if (!value) return null;
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
};

const normalizeTime = (value: unknown) => String(value || '').trim();

const normalizeSchedules = (value: unknown): WorkingSchedule[] => {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const schedule = item && typeof item === 'object' ? item as Record<string, unknown> : {};
      return {
        days: normalizeIds(schedule.days),
        hoursStart: normalizeTime(schedule.hoursStart),
        hoursEnd: normalizeTime(schedule.hoursEnd),
      };
    })
    .filter((schedule) => schedule.days.length && schedule.hoursStart && schedule.hoursEnd);
};

const getSchedules = (body: any, current?: any): WorkingSchedule[] => {
  if (body.workingSchedules !== undefined) return normalizeSchedules(body.workingSchedules);
  if (body.workingDays !== undefined || body.workingHoursStart !== undefined || body.workingHoursEnd !== undefined) {
    const days = normalizeIds(body.workingDays);
    const hoursStart = normalizeTime(body.workingHoursStart);
    const hoursEnd = normalizeTime(body.workingHoursEnd);
    return days.length && hoursStart && hoursEnd ? [{ days, hoursStart, hoursEnd }] : [];
  }
  if (current?.workingSchedules) {
    try { return normalizeSchedules(JSON.parse(current.workingSchedules)); } catch { return []; }
  }
  return [];
};

const scheduleData = (schedules: WorkingSchedule[]) => ({
  workingDays: schedules[0]?.days || [],
  workingHoursStart: schedules[0]?.hoursStart || null,
  workingHoursEnd: schedules[0]?.hoursEnd || null,
  workingSchedules: JSON.stringify(schedules),
});

const mapIntern = (intern: any) => {
  let workingSchedules: WorkingSchedule[] = [];
  try { workingSchedules = normalizeSchedules(JSON.parse(intern.workingSchedules || '[]')); } catch { workingSchedules = []; }
  return {
    ...intern,
    workingSchedules,
    professionalIds: intern.doctors.map((link: any) => link.doctorId),
    professionals: intern.doctors.map((link: any) => link.doctor),
  };
};

export default async function internRoutes(app: FastifyInstance) {
  app.addHook('onRequest', async (request, reply) => {
    try { await request.jwtVerify(); } catch { return reply.code(401).send({ error: 'Unauthorized' }); }
  });

  const getLoggedContext = async (request: any) => {
    const user = await prisma.user.findUnique({
      where: { id: request.user?.id },
      include: { sector: { include: { branch: true } } },
    });
    const branch = user?.sector?.branch;
    return branch ? { branchId: branch.id, companyId: branch.companyId } : null;
  };

  const resolveTargetBranch = async (context: { branchId: string; companyId: string }, requested: unknown) => {
    const branchId = String(requested || context.branchId).trim() || context.branchId;
    const branch = await prisma.branch.findFirst({ where: { id: branchId, companyId: context.companyId }, select: { id: true } });
    return branch?.id || null;
  };

  const validateEspecialidade = async (especialidadeId: unknown, branchId: string) => {
    const id = String(especialidadeId || '').trim();
    if (!id) return null;
    const especialidade = await prisma.especialidade.findFirst({
      where: {
        id,
        isActive: true,
        OR: [{ branchId }, { branchId: null }],
        modalidade: { OR: [{ branchId }, { branchId: null }] },
      },
      select: { id: true },
    });
    return especialidade?.id || null;
  };

  const validateDoctors = async (professionalIds: string[], branchId: string) => {
    if (!professionalIds.length) return true;
    const doctors = await prisma.doctor.findMany({ where: { id: { in: professionalIds }, branchId }, select: { id: true } });
    return doctors.length === professionalIds.length;
  };

  const include = {
    branch: { select: { id: true, tradeName: true, isMatriz: true } },
    especialidade: { select: { id: true, name: true } },
    doctors: { include: { doctor: { select: { id: true, name: true, crm: true, crmState: true } } } },
  } as const;

  app.get('/', async (request: any, reply) => {
    const context = await getLoggedContext(request);
    if (!context) return reply.code(403).send({ error: 'User not associated with a branch' });
    const search = String(request.query?.search || '').trim();
    const requestedBranchId = String(request.query?.branchId || '').trim();
    const branchId = requestedBranchId ? await resolveTargetBranch(context, requestedBranchId) : null;
    if (requestedBranchId && !branchId) return reply.code(400).send({ error: 'Unidade inválida' });
    const interns = await prisma.intern.findMany({
      where: {
        branch: { companyId: context.companyId },
        ...(branchId ? { branchId } : {}),
        ...(search ? { name: { contains: search, mode: 'insensitive' } } : {}),
      },
      include,
      orderBy: { name: 'asc' },
    });
    return interns.map(mapIntern);
  });

  app.post('/', async (request: any, reply) => {
    const context = await getLoggedContext(request);
    if (!context) return reply.code(403).send({ error: 'User not associated with a branch' });
    const body = request.body || {};
    const name = String(body.name || '').trim();
    if (!name) return reply.code(400).send({ error: 'Nome do estagiário é obrigatório' });
    const branchId = await resolveTargetBranch(context, body.branchId);
    if (!branchId) return reply.code(400).send({ error: 'Unidade inválida' });
    const professionalIds = normalizeIds(body.professionalIds);
    if (!(await validateDoctors(professionalIds, branchId))) return reply.code(400).send({ error: 'Profissional inválido para esta unidade' });
    const especialidadeId = await validateEspecialidade(body.especialidadeId, branchId);
    if (body.especialidadeId && !especialidadeId) return reply.code(400).send({ error: 'Especialidade inválida para esta unidade' });
    const schedules = getSchedules(body);
    const intern = await prisma.intern.create({
      data: {
        branchId, especialidadeId, name, cpf: body.cpf ? String(body.cpf).trim() : null, email: body.email ? String(body.email).trim() : null,
        phone: body.phone ? String(body.phone).trim() : null, institution: body.institution ? String(body.institution).trim() : null,
        course: body.course ? String(body.course).trim() : null, startDate: parseDate(body.startDate), endDate: parseDate(body.endDate),
        ...scheduleData(schedules),
        doctors: { create: professionalIds.map((doctorId) => ({ doctorId })) },
      }, include,
    });
    return reply.code(201).send(mapIntern(intern));
  });

  app.put('/:id', async (request: any, reply) => {
    const context = await getLoggedContext(request);
    if (!context) return reply.code(403).send({ error: 'User not associated with a branch' });
    const id = String(request.params.id);
    const current = await prisma.intern.findFirst({ where: { id, branch: { companyId: context.companyId } } });
    if (!current) return reply.code(404).send({ error: 'Intern not found' });
    const body = request.body || {};
    const branchId = await resolveTargetBranch(context, body.branchId ?? current.branchId);
    if (!branchId) return reply.code(400).send({ error: 'Unidade inválida' });
    const professionalIds = normalizeIds(body.professionalIds);
    if (!(await validateDoctors(professionalIds, branchId))) return reply.code(400).send({ error: 'Profissional inválido para esta unidade' });
    const especialidadeId = body.especialidadeId !== undefined ? await validateEspecialidade(body.especialidadeId, branchId) : current.especialidadeId;
    if (body.especialidadeId && !especialidadeId) return reply.code(400).send({ error: 'Especialidade inválida para esta unidade' });
    const schedules = getSchedules(body, current);
    const intern = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.internDoctor.deleteMany({ where: { internId: id } });
      return tx.intern.update({ where: { id }, data: {
        branchId, especialidadeId, ...scheduleData(schedules),
        name: body.name !== undefined ? String(body.name).trim() : undefined, cpf: body.cpf !== undefined ? (body.cpf ? String(body.cpf).trim() : null) : undefined,
        email: body.email !== undefined ? (body.email ? String(body.email).trim() : null) : undefined, phone: body.phone !== undefined ? (body.phone ? String(body.phone).trim() : null) : undefined,
        institution: body.institution !== undefined ? (body.institution ? String(body.institution).trim() : null) : undefined, course: body.course !== undefined ? (body.course ? String(body.course).trim() : null) : undefined,
        startDate: body.startDate !== undefined ? parseDate(body.startDate) : undefined, endDate: body.endDate !== undefined ? parseDate(body.endDate) : undefined,
        isActive: body.isActive !== undefined ? Boolean(body.isActive) : undefined, doctors: { create: professionalIds.map((doctorId) => ({ doctorId })) },
      }, include });
    });
    return mapIntern(intern);
  });

  app.delete('/:id', async (request: any, reply) => {
    const context = await getLoggedContext(request);
    if (!context) return reply.code(403).send({ error: 'User not associated with a branch' });
    const result = await prisma.intern.deleteMany({ where: { id: String(request.params.id), branch: { companyId: context.companyId } } });
    if (!result.count) return reply.code(404).send({ error: 'Intern not found' });
    return { message: 'Intern deleted successfully' };
  });
}
