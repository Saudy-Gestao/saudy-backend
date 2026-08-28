import { FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';
import prisma from '../lib/prisma';

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

export default async function internRoutes(app: FastifyInstance) {
  app.addHook('onRequest', async (request, reply) => {
    try { await request.jwtVerify(); } catch { return reply.code(401).send({ error: 'Unauthorized' }); }
  });

  const getBranchId = async (request: any) => {
    const user = await prisma.user.findUnique({
      where: { id: request.user?.id },
      include: { sector: { include: { branch: true } } },
    });
    return user?.sector?.branch?.id || null;
  };

  app.get('/', async (request: any, reply) => {
    const branchId = await getBranchId(request);
    if (!branchId) return reply.code(403).send({ error: 'User not associated with a branch' });
    const search = String(request.query?.search || '').trim();
    const interns = await prisma.intern.findMany({
      where: { branchId, ...(search ? { name: { contains: search, mode: 'insensitive' } } : {}) },
      include: { doctors: { include: { doctor: { select: { id: true, name: true, crm: true, crmState: true } } } } },
      orderBy: { name: 'asc' },
    });
    return interns.map((intern: any) => ({ ...intern, professionalIds: intern.doctors.map((link: any) => link.doctorId), professionals: intern.doctors.map((link: any) => link.doctor) }));
  });

  app.post('/', async (request: any, reply) => {
    const branchId = await getBranchId(request);
    if (!branchId) return reply.code(403).send({ error: 'User not associated with a branch' });
    const body = request.body || {};
    const name = String(body.name || '').trim();
    if (!name) return reply.code(400).send({ error: 'Nome do estagiário é obrigatório' });
    const professionalIds = normalizeIds(body.professionalIds);
    const doctors = professionalIds.length ? await prisma.doctor.findMany({ where: { id: { in: professionalIds }, branchId }, select: { id: true } }) : [];
    if (doctors.length !== professionalIds.length) return reply.code(400).send({ error: 'Profissional inválido para esta filial' });
    const intern = await prisma.intern.create({
      data: {
        branchId, name, cpf: body.cpf ? String(body.cpf).trim() : null, email: body.email ? String(body.email).trim() : null,
        phone: body.phone ? String(body.phone).trim() : null, institution: body.institution ? String(body.institution).trim() : null,
        course: body.course ? String(body.course).trim() : null, startDate: parseDate(body.startDate), endDate: parseDate(body.endDate),
        doctors: { create: professionalIds.map((doctorId) => ({ doctorId })) },
      }, include: { doctors: { include: { doctor: { select: { id: true, name: true, crm: true, crmState: true } } } } },
    });
    return reply.code(201).send({ ...intern, professionalIds, professionals: intern.doctors.map((link: any) => link.doctor) });
  });

  app.put('/:id', async (request: any, reply) => {
    const branchId = await getBranchId(request);
    if (!branchId) return reply.code(403).send({ error: 'User not associated with a branch' });
    const id = String(request.params.id);
    const current = await prisma.intern.findFirst({ where: { id, branchId } });
    if (!current) return reply.code(404).send({ error: 'Intern not found' });
    const body = request.body || {};
    const professionalIds = normalizeIds(body.professionalIds);
    const doctors = professionalIds.length ? await prisma.doctor.findMany({ where: { id: { in: professionalIds }, branchId }, select: { id: true } }) : [];
    if (doctors.length !== professionalIds.length) return reply.code(400).send({ error: 'Profissional inválido para esta filial' });
    const intern = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.internDoctor.deleteMany({ where: { internId: id } });
      return tx.intern.update({ where: { id }, data: {
        name: body.name !== undefined ? String(body.name).trim() : undefined, cpf: body.cpf !== undefined ? (body.cpf ? String(body.cpf).trim() : null) : undefined,
        email: body.email !== undefined ? (body.email ? String(body.email).trim() : null) : undefined, phone: body.phone !== undefined ? (body.phone ? String(body.phone).trim() : null) : undefined,
        institution: body.institution !== undefined ? (body.institution ? String(body.institution).trim() : null) : undefined, course: body.course !== undefined ? (body.course ? String(body.course).trim() : null) : undefined,
        startDate: body.startDate !== undefined ? parseDate(body.startDate) : undefined, endDate: body.endDate !== undefined ? parseDate(body.endDate) : undefined,
        isActive: body.isActive !== undefined ? Boolean(body.isActive) : undefined, doctors: { create: professionalIds.map((doctorId) => ({ doctorId })) },
      }, include: { doctors: { include: { doctor: { select: { id: true, name: true, crm: true, crmState: true } } } } } });
    });
    return { ...intern, professionalIds, professionals: intern.doctors.map((link: any) => link.doctor) };
  });

  app.delete('/:id', async (request: any, reply) => {
    const branchId = await getBranchId(request);
    if (!branchId) return reply.code(403).send({ error: 'User not associated with a branch' });
    const result = await prisma.intern.deleteMany({ where: { id: String(request.params.id), branchId } });
    if (!result.count) return reply.code(404).send({ error: 'Intern not found' });
    return { message: 'Intern deleted successfully' };
  });
}
