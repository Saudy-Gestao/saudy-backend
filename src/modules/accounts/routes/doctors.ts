import { FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';
import prisma from '../lib/prisma';
import { isValidCpf, normalizeCpf } from '../../../lib/cpf';
import { isValidEmail, normalizeEmail } from '../../../lib/email';

const resolveUniqueField = (target: string | string[] | undefined): { field: string; message: string } => {
  const raw = Array.isArray(target) ? target[0] : (target ?? '');
  // Prisma may return index name (e.g. "doctors_email_key") or field name ("email")
  if (raw.includes('email')) return { field: 'email', message: 'Este e-mail já está em uso' };
  if (raw.includes('cpf')) return { field: 'cpf', message: 'CPF já cadastrado' };
  if (raw.includes('crm')) return { field: 'crm', message: 'CRM já cadastrado' };
  return { field: raw, message: `${raw} já existe` };
};

const normalizeRoomIds = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value
        .map((item) => String(item || '').trim())
        .filter(Boolean),
    ),
  );
};

const normalizeEspecialidadeGroups = (
  value: unknown,
  fallback: { registrationType?: unknown; registrationNumber?: unknown; registrationState?: unknown },
) => {
  if (!Array.isArray(value)) return [];

  const fallbackType = String(fallback.registrationType || 'CRM').trim() || 'CRM';
  const fallbackNumber = String(fallback.registrationNumber || '').trim();
  const fallbackState = String(fallback.registrationState || '').trim().toUpperCase();

  return value.map((item) => {
    const group = item && typeof item === 'object' ? item as Record<string, unknown> : {};
    return {
      ...group,
      registrationType: String(group.registrationType || fallbackType).trim() || fallbackType,
      registrationNumber: String(group.registrationNumber || fallbackNumber).trim(),
      registrationState: String(group.registrationState || fallbackState).trim().toUpperCase(),
    };
  });
};

const normalizeProcedureDurations = (value: unknown) => {
  if (!Array.isArray(value)) return [];

  const byProcedure = new Map<string, { procedureId: string; durationMinutes: number; branchIds: string[] }>();
  value.forEach((item) => {
    const record = item && typeof item === 'object' ? item as Record<string, unknown> : {};
    const procedureId = String(record.procedureId || '').trim();
    const durationMinutes = Number(record.durationMinutes);
    if (!procedureId || !Number.isFinite(durationMinutes) || durationMinutes <= 0) return;
    const branchIds = Array.isArray(record.branchIds)
      ? Array.from(new Set(record.branchIds.map((branchId) => String(branchId || '').trim()).filter(Boolean)))
      : [];
    byProcedure.set(procedureId, { procedureId, durationMinutes: Math.round(durationMinutes), branchIds });
  });
  return Array.from(byProcedure.values());
};

const getProcedureDurationLinks = async (doctorId: string) => {
  if (!prisma.procedureDoctor?.findMany) return [];

  const links = await prisma.procedureDoctor.findMany({
    where: { doctorId },
    include: {
      procedure: {
        select: { id: true, name: true, durationMinutes: true, modalidadeId: true },
      },
    },
    orderBy: { createdAt: 'asc' },
  });

  return links.map((link: any) => ({
    procedureId: link.procedureId,
    procedureName: link.procedure?.name || '',
    modalidadeId: link.procedure?.modalidadeId || null,
    durationMinutes: link.durationMinutes ?? link.procedure?.durationMinutes ?? null,
    branchIds: Array.isArray(link.branchIds) ? link.branchIds : [],
  }));
};

const mapDoctorResponse = (doctor: any, procedureDurations: unknown[] = []) => {
  const roomLinks = Array.isArray(doctor?.roomLinks) ? doctor.roomLinks : [];
  const normalizedLinks = roomLinks
    .map((link: any) => ({
      id: String(link?.id || ''),
      roomId: String(link?.roomId || ''),
      room: link?.room
        ? {
            id: String(link.room.id || ''),
            name: String(link.room.name || ''),
            branchId: String(link.room.branchId || ''),
          }
        : null,
    }))
    .filter((link: any) => link.roomId);

  const roomIds = normalizedLinks.map((link: any) => link.roomId);
  const fallbackRoomId = String(doctor?.roomId || '').trim();
  if (fallbackRoomId && !roomIds.includes(fallbackRoomId)) {
    roomIds.unshift(fallbackRoomId);
  }

  const parsedGroups = doctor.especialidadeGroups ? JSON.parse(doctor.especialidadeGroups) : [];

  return {
    ...doctor,
    roomIds,
    rooms: normalizedLinks,
    workingSchedules: doctor.workingSchedules ? JSON.parse(doctor.workingSchedules) : [],
    especialidadeGroups: normalizeEspecialidadeGroups(parsedGroups, {
      registrationType: doctor.crmType,
      registrationNumber: doctor.crm,
      registrationState: doctor.crmState,
    }),
    procedureDurations,
  };
};

export default async function doctorRoutes(app: FastifyInstance) {
  const getLoggedBranchId = async (request: any) => {
    const userId = (request.user as any)?.id;
    if (!userId) return null;
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { sector: { include: { branch: true } } },
    });
    return user?.sector?.branch?.id || null;
  };

  const resolveListBranchId = async (request: any, requestedBranchId?: string) => {
    const userId = (request.user as any)?.id;
    if (!userId) return null;
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { sector: { include: { branch: true } } },
    });
    const currentBranch = user?.sector?.branch;
    if (!currentBranch) return null;
    if (!requestedBranchId) return currentBranch.id;
    const branchId = String(requestedBranchId).trim();
    const branch = await prisma.branch.findFirst({ where: { id: branchId, companyId: currentBranch.companyId }, select: { id: true } });
    return branch?.id || null;
  };

  // Auth hook for all routes in this plugin
  app.addHook('onRequest', async (request, reply) => {
    try {
      await request.jwtVerify();
    } catch (err) {
      reply.code(401).send({ error: 'Unauthorized' });
    }
  });

  // List all doctors
  app.get('/', {
    schema: {
      summary: 'List all doctors',
      tags: ['Doctors'],
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        properties: {
          specialty: { type: 'string' },
          isActive: { type: 'boolean' },
          search: { type: 'string' },
          branchId: { type: 'string' },
        },
      },
      response: {
        200: {
          type: 'array',
          items: { $ref: 'Doctor#' },
        },
      },
    },
  }, async (request, reply) => {
    const { branchId: requestedBranchId } = request.query as { branchId?: string };
    const branchId = await resolveListBranchId(request, requestedBranchId);
    if (!branchId) return (reply as any).code(403).send({ error: 'User not associated with a branch' });

    const { specialty, isActive, search } = request.query as {
      specialty?: string;
      isActive?: boolean;
      search?: string;
    };

    const where: any = { branchId };

    if (specialty) {
      where.OR = [
        { specialty: { contains: specialty, mode: 'insensitive' } },
        { specialties: { has: specialty } },
      ];
    }

    if (isActive !== undefined) {
      where.isActive = isActive;
    }

    if (search) {
      where.OR = [
        ...(where.OR || []),
        { name: { contains: search, mode: 'insensitive' } },
        { crm: { contains: search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } },
      ];
    }

    const doctors = await prisma.doctor.findMany({
      where,
      include: {
        roomLinks: {
          include: {
            room: {
              select: { id: true, name: true, branchId: true },
            },
          },
          orderBy: { createdAt: 'asc' },
        },
      },
      orderBy: { name: 'asc' },
    });

    return Promise.all(doctors.map(async (doctor: any) => mapDoctorResponse(doctor, await getProcedureDurationLinks(doctor.id))));
  });

  // Get doctor by ID
  app.get('/:id', {
    schema: {
      summary: 'Get doctor by ID',
      tags: ['Doctors'],
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        properties: {
          id: { type: 'string' },
        },
        required: ['id'],
      },
      response: {
        200: { $ref: 'Doctor#' },
        404: {
          type: 'object',
          properties: { error: { type: 'string' } },
          additionalProperties: true,
        },
      },
    },
  }, async (request, reply) => {
    const branchId = await getLoggedBranchId(request);
    if (!branchId) return (reply as any).code(403).send({ error: 'User not associated with a branch' });

    const { id } = request.params as { id: string };

    const doctor = await prisma.doctor.findFirst({
      where: { id, branchId },
      include: {
        roomLinks: {
          include: {
            room: {
              select: { id: true, name: true, branchId: true },
            },
          },
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    if (!doctor) {
      return reply.code(404).send({ error: 'Doctor not found' });
    }

    return mapDoctorResponse(doctor, await getProcedureDurationLinks(doctor.id));
  });

  // Get doctor by CRM
  app.get('/crm/:crm/:state', {
    schema: {
      summary: 'Get doctor by CRM and state',
      tags: ['Doctors'],
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        properties: {
          crm: { type: 'string' },
          state: { type: 'string' },
        },
        required: ['crm', 'state'],
      },
      response: {
        200: { $ref: 'Doctor#' },
        404: {
          type: 'object',
          properties: { error: { type: 'string' } },
          additionalProperties: true,
        },
      },
    },
  }, async (request, reply) => {
    const branchId = await getLoggedBranchId(request);
    if (!branchId) return (reply as any).code(403).send({ error: 'User not associated with a branch' });

    const { crm, state } = request.params as { crm: string; state: string };

    const doctor = await prisma.doctor.findFirst({
      where: { crm, crmState: state.toUpperCase(), branchId },
      include: {
        roomLinks: {
          include: {
            room: {
              select: { id: true, name: true, branchId: true },
            },
          },
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    if (!doctor) {
      return reply.code(404).send({ error: 'Doctor not found' });
    }

    return mapDoctorResponse(doctor, await getProcedureDurationLinks(doctor.id));
  });

  // Create new doctor
  app.post('/', {
    schema: {
      summary: 'Create a new doctor',
      tags: ['Doctors'],
      security: [{ bearerAuth: [] }],
      // body schema temporarily removed to diagnose client 400 errors
      response: {
        201: { $ref: 'Doctor#' },
        400: { type: 'object', additionalProperties: true },
      },
    },
  }, async (request, reply) => {
    const branchId = await getLoggedBranchId(request);
    if (!branchId) return (reply as any).code(403).send({ error: 'User not associated with a branch' });

    const data = request.body as any;

    // Explicit check for empty or missing parsed body
    if (!data || (typeof data === 'object' && Object.keys(data).length === 0)) {
      request.log.warn({ body: data }, 'Empty or missing request body for doctor create');
      return reply.code(400).send({ error: 'Bad Request', details: 'Request body is empty or could not be parsed as JSON. Ensure Content-Type: application/json and valid JSON body.' });
    }

    // Server-side validation (return field-level errors)
    const fieldErrors: Record<string,string> = {};
    const normalizedEmail = normalizeEmail(data?.email);
    if (!data?.name || String(data.name).trim() === '') fieldErrors.name = 'Nome é obrigatório';
    if (!data?.crm || String(data.crm).trim() === '') fieldErrors.crm = 'CRM é obrigatório';
    if (!data?.crmState || String(data.crmState).trim() === '') fieldErrors.crmState = 'UF do CRM é obrigatório';
    if (!isValidEmail(normalizedEmail)) fieldErrors.email = 'Email inválido';
    if (!data?.cellphone || !/^\d{10,11}$/.test(String(data.cellphone))) fieldErrors.cellphone = 'Celular inválido';
    if (data?.phone !== undefined && data.phone !== null && String(data.phone).trim() !== '' && !/^\d{10,11}$/.test(String(data.phone))) fieldErrors.phone = 'Telefone inválido';
    const normalizedCpf = normalizeCpf(data?.cpf);
    if (!isValidCpf(normalizedCpf)) fieldErrors.cpf = 'CPF inválido';
    if (!data?.birthDate || isNaN(Date.parse(String(data.birthDate)))) fieldErrors.birthDate = 'Data de nascimento inválida';
    else if (new Date(String(data.birthDate)) > new Date()) fieldErrors.birthDate = 'Data de nascimento inválida';
    if (!data?.gender || !['MALE','FEMALE','OTHER'].includes(String(data.gender).toUpperCase())) fieldErrors.gender = 'Gênero inválido';
    data.specialty = String(data?.specialty || '').trim();

    if (Object.keys(fieldErrors).length > 0) {
      return reply.code(400).send({ error: 'Validation failed', fields: fieldErrors });
    }

    const normalizedPhone = String(data.phone || '').trim();
    const normalizedCellphone = String(data.cellphone || '').trim();
    const normalizedSignatureImageBase64 = String(data.signatureImageBase64 || '').trim();
    data.phone = normalizedPhone || normalizedCellphone;
    data.cellphone = normalizedCellphone || null;
    data.signatureImageBase64 = normalizedSignatureImageBase64 || null;

    const roomIds = normalizeRoomIds(data?.roomIds);
    if (roomIds.length > 0) {
      const rooms = await prisma.sector.findMany({ where: { id: { in: roomIds }, branchId } });
      if (rooms.length !== roomIds.length) {
        return reply.code(400).send({ error: 'Validation failed', fields: { roomIds: 'Uma ou mais salas sao invalidas' } });
      }

      data.roomId = roomIds[0];
    } else if (data?.roomId !== undefined) {
      const roomId = String(data.roomId || '').trim();
      if (roomId) {
        const room = await prisma.sector.findUnique({ where: { id: roomId } });
        if (!room || room.branchId !== branchId) {
          return reply.code(400).send({ error: 'Validation failed', fields: { roomId: 'Sala inválida' } });
        }
        data.roomId = roomId;
      } else {
        data.roomId = null;
      }
    }

    const procedureDurations = normalizeProcedureDurations(data?.procedureDurations);
    if (procedureDurations.length > 0) {
      const procedures = await prisma.procedure.findMany({
        where: { id: { in: procedureDurations.map((item) => item.procedureId) }, branchId },
        select: { id: true },
      });
      if (procedures.length !== procedureDurations.length) {
        return reply.code(400).send({ error: 'Validation failed', fields: { procedureDurations: 'Um ou mais procedimentos são inválidos' } });
      }
    }

    try {
      let workingSchedulesData = null;
      // If workingSchedules is provided, use it; otherwise try to construct from legacy fields
      if (Array.isArray(data.workingSchedules) && data.workingSchedules.length > 0) {
        workingSchedulesData = JSON.stringify(data.workingSchedules);
      } else if (Array.isArray(data.workingDays) && data.workingDays.length > 0 && data.workingHoursStart && data.workingHoursEnd) {
        // Backward compatibility: construct from legacy fields
        workingSchedulesData = JSON.stringify([
          {
            days: data.workingDays,
            hoursStart: data.workingHoursStart,
            hoursEnd: data.workingHoursEnd,
          }
        ]);
      }

      const especialidadeGroupsData = Array.isArray(data.especialidadeGroups)
        ? JSON.stringify(normalizeEspecialidadeGroups(data.especialidadeGroups, {
          registrationType: data.crmType,
          registrationNumber: data.crm,
          registrationState: data.crmState,
        }))
        : '[]';

      const doctor = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        const createData: any = {
          ...data,
          email: normalizedEmail,
          cpf: normalizedCpf,
          branchId,
          birthDate: new Date(data.birthDate),
          specialties: data.specialties || [],
          workingDays: data.workingDays || [],
          workingSchedules: workingSchedulesData || '[]',
          especialidadeGroups: especialidadeGroupsData,
        };
        delete createData.roomIds;

        const createdDoctor = await tx.doctor.create({
          data: createData,
        });

        const roomIdsToSync = roomIds.length > 0
          ? roomIds
          : (createdDoctor.roomId ? [String(createdDoctor.roomId)] : []);

        if (roomIdsToSync.length > 0) {
          await tx.doctorRoom.createMany({
            data: roomIdsToSync.map((roomId) => ({
              doctorId: createdDoctor.id,
              roomId,
            })),
            skipDuplicates: true,
          });
        }

        if (data.procedureDurations !== undefined) {
          await tx.procedureDoctor.deleteMany({ where: { doctorId: createdDoctor.id } });
          if (procedureDurations.length > 0) {
            await tx.procedureDoctor.createMany({
              data: procedureDurations.map((item) => ({
                procedureId: item.procedureId,
                doctorId: createdDoctor.id,
                doctorName: createdDoctor.name,
                durationMinutes: item.durationMinutes,
                branchIds: item.branchIds,
              })),
              skipDuplicates: true,
            });
          }
        }

        return tx.doctor.findUniqueOrThrow({
          where: { id: createdDoctor.id },
          include: {
            roomLinks: {
              include: {
                room: {
                  select: { id: true, name: true, branchId: true },
                },
              },
              orderBy: { createdAt: 'asc' },
            },
          },
        });
      });

      const doctorResponse = mapDoctorResponse(doctor, await getProcedureDurationLinks(doctor.id));

      return reply.code(201).send(doctorResponse);
    } catch (error: any) {
      request.log.error({ err: error }, 'Failed to create doctor');
      if (error.code === 'P2002') {
        const { field, message } = resolveUniqueField(error.meta?.target);
        return reply.code(400).send({ error: 'Validation failed', fields: { [field]: message } });
      }
      return reply.code(400).send({ error: 'Failed to create doctor', details: error.message });
    }
  });

  // Update doctor
  app.put('/:id', {
    schema: {
      summary: 'Update a doctor',
      tags: ['Doctors'],
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        properties: {
          id: { type: 'string' },
        },
        required: ['id'],
      },
      // Accept full payload from edit form (including workingSchedules and legacy fields)
      body: { type: 'object', additionalProperties: true },
      response: {
        200: { $ref: 'Doctor#' },
        400: {
          type: 'object',
          properties: { error: { type: 'string' }, details: { type: 'string' } },
          additionalProperties: true,
        },
        404: {
          type: 'object',
          properties: { error: { type: 'string' } },
          additionalProperties: true,
        },
      },
    },
  }, async (request, reply) => {
    const branchId = await getLoggedBranchId(request);
    if (!branchId) return (reply as any).code(403).send({ error: 'User not associated with a branch' });

    const { id } = request.params as { id: string };
    const data = request.body as any;

    const existing = await prisma.doctor.findFirst({ where: { id, branchId } });

    if (!existing) {
      return reply.code(404).send({ error: 'Doctor not found' });
    }

    // validate provided fields on update
    const fieldErrors: Record<string,string> = {};
    const normalizedEmail = normalizeEmail(data?.email);
    if (data?.email !== undefined && normalizedEmail && !isValidEmail(normalizedEmail)) fieldErrors.email = 'Email inválido';
    const normalizedCpf = normalizeCpf(data?.cpf);
    if (data?.cpf !== undefined && !isValidCpf(normalizedCpf)) fieldErrors.cpf = 'CPF inválido';
    if (data?.birthDate !== undefined && (isNaN(Date.parse(String(data.birthDate))) || new Date(String(data.birthDate)) > new Date())) fieldErrors.birthDate = 'Data de nascimento inválida';
    if (data?.gender !== undefined && data.gender && !['MALE','FEMALE','OTHER'].includes(String(data.gender).toUpperCase())) fieldErrors.gender = 'Gênero inválido';

    if (Object.keys(fieldErrors).length > 0) return reply.code(400).send({ error: 'Validation failed', fields: fieldErrors });

    const roomIds = normalizeRoomIds(data?.roomIds);
    if (roomIds.length > 0) {
      const rooms = await prisma.sector.findMany({ where: { id: { in: roomIds }, branchId } });
      if (rooms.length !== roomIds.length) {
        return reply.code(400).send({ error: 'Validation failed', fields: { roomIds: 'Uma ou mais salas sao invalidas' } });
      }
      data.roomId = roomIds[0];
    } else if (data?.roomId !== undefined) {
      const roomId = String(data.roomId || '').trim();
      if (roomId) {
        const room = await prisma.sector.findUnique({ where: { id: roomId } });
        if (!room || room.branchId !== branchId) {
          return reply.code(400).send({ error: 'Validation failed', fields: { roomId: 'Sala inválida' } });
        }
        data.roomId = roomId;
      } else {
        data.roomId = null;
      }
    }

    const procedureDurations = normalizeProcedureDurations(data?.procedureDurations);
    if (data.procedureDurations !== undefined && procedureDurations.length > 0) {
      const procedures = await prisma.procedure.findMany({
        where: { id: { in: procedureDurations.map((item) => item.procedureId) }, branchId },
        select: { id: true },
      });
      if (procedures.length !== procedureDurations.length) {
        return reply.code(400).send({ error: 'Validation failed', fields: { procedureDurations: 'Um ou mais procedimentos são inválidos' } });
      }
    }

    if (data?.birthDate !== undefined && data.birthDate) {
      data.birthDate = new Date(String(data.birthDate));
    }

    try {
      if (data?.cpf !== undefined) {
        data.cpf = normalizedCpf;
      }
      if (data?.email !== undefined) {
        data.email = normalizedEmail || null;
      }
      if (data?.signatureImageBase64 !== undefined) {
        const normalizedSignatureImageBase64 = String(data.signatureImageBase64 || '').trim();
        data.signatureImageBase64 = normalizedSignatureImageBase64 || null;
      }

      let workingSchedulesData = undefined;
      // If workingSchedules is provided, use it; otherwise try to construct from legacy fields
      if (Array.isArray(data.workingSchedules) && data.workingSchedules.length > 0) {
        workingSchedulesData = JSON.stringify(data.workingSchedules);
      } else if (Array.isArray(data.workingDays) && data.workingDays.length > 0 && data.workingHoursStart && data.workingHoursEnd) {
        // Backward compatibility: construct from legacy fields
        workingSchedulesData = JSON.stringify([
          {
            days: data.workingDays,
            hoursStart: data.workingHoursStart,
            hoursEnd: data.workingHoursEnd,
          }
        ]);
      }

      const updateData: any = { ...data, branchId };
      delete updateData.workingSchedules;
      delete updateData.roomIds;
      delete updateData.especialidadeGroups;
      if (workingSchedulesData !== undefined) {
        updateData.workingSchedules = workingSchedulesData;
      } else if (Array.isArray(data.workingSchedules) && data.workingSchedules.length === 0) {
        updateData.workingSchedules = '[]';
      }
      if (data.especialidadeGroups !== undefined) {
        updateData.especialidadeGroups = Array.isArray(data.especialidadeGroups)
          ? JSON.stringify(normalizeEspecialidadeGroups(data.especialidadeGroups, {
            registrationType: data.crmType ?? existing.crmType,
            registrationNumber: data.crm ?? existing.crm,
            registrationState: data.crmState ?? existing.crmState,
          }))
          : '[]';
      }

      const doctor = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        await tx.doctor.update({
          where: { id },
          data: updateData,
        });

        if (data?.roomIds !== undefined || data?.roomId !== undefined) {
          const roomIdsToSync = roomIds.length > 0
            ? roomIds
            : (updateData.roomId ? [String(updateData.roomId)] : []);

          await tx.doctorRoom.deleteMany({ where: { doctorId: id } });

          if (roomIdsToSync.length > 0) {
            await tx.doctorRoom.createMany({
              data: roomIdsToSync.map((roomId) => ({
                doctorId: id,
                roomId,
              })),
              skipDuplicates: true,
            });
          }
        }

        if (data.procedureDurations !== undefined) {
          await tx.procedureDoctor.deleteMany({ where: { doctorId: id } });
          if (procedureDurations.length > 0) {
            await tx.procedureDoctor.createMany({
              data: procedureDurations.map((item) => ({
                procedureId: item.procedureId,
                doctorId: id,
                doctorName: existing.name,
                durationMinutes: item.durationMinutes,
                branchIds: item.branchIds,
              })),
              skipDuplicates: true,
            });
          }
        }

        return tx.doctor.findUniqueOrThrow({
          where: { id },
          include: {
            roomLinks: {
              include: {
                room: {
                  select: { id: true, name: true, branchId: true },
                },
              },
              orderBy: { createdAt: 'asc' },
            },
          },
        });
      });

      return mapDoctorResponse(doctor, await getProcedureDurationLinks(doctor.id));
    } catch (error: any) {
      if (error.code === 'P2002') {
        const { field, message } = resolveUniqueField(error.meta?.target);
        return reply.code(400).send({ error: 'Validation failed', fields: { [field]: message } });
      }
      return reply.code(400).send({ error: 'Failed to update doctor', details: error.message });
    }
  });

  // Delete doctor
  app.delete('/:id', {
    schema: {
      summary: 'Delete a doctor',
      tags: ['Doctors'],
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        properties: {
          id: { type: 'string' },
        },
        required: ['id'],
      },
      response: {
        200: { type: 'object', properties: { message: { type: 'string' } } },
        400: {
          type: 'object',
          properties: { error: { type: 'string' }, details: { type: 'string' } },
          additionalProperties: true,
        },
        404: {
          type: 'object',
          properties: { error: { type: 'string' } },
          additionalProperties: true,
        },
        500: {
          type: 'object',
          properties: { error: { type: 'string' }, details: { type: 'string' } },
          additionalProperties: true,
        },
      },
    },
  }, async (request, reply) => {
    const branchId = await getLoggedBranchId(request);
    if (!branchId) return (reply as any).code(403).send({ error: 'User not associated with a branch' });

    const { id } = request.params as { id: string };

    const existing = await prisma.doctor.findFirst({ where: { id, branchId } });

    if (!existing) {
      return reply.code(404).send({ error: 'Doctor not found' });
    }

    // Check for appointments. Current Appointment model stores doctorName (not doctorId).
    const appointmentsCount = await prisma.appointment.count({
      where: {
        branchId,
        doctorName: existing.name,
        isActive: true,
      },
    });

    if (appointmentsCount > 0) {
      return reply.code(400).send({
        error: 'Cannot delete doctor',
        details: `This doctor has ${appointmentsCount} appointment(s). Cancel or reassign them first, or deactivate the doctor instead.`,
      });
    }

    try {
      await prisma.doctor.delete({ where: { id } });
      return { message: 'Doctor deleted successfully' };
    } catch (error: any) {
      if (error?.code === 'P2003') {
        return reply.code(400).send({
          error: 'Cannot delete doctor',
          details: 'This doctor is referenced by other records. Remove/reassign dependencies first, or deactivate the doctor instead.',
        });
      }

      request.log.error({ err: error, doctorId: id }, 'Failed to delete doctor');
      return reply.code(500).send({ error: 'Failed to delete doctor', details: error?.message || 'Internal error' });
    }
  });

  // List specialties (distinct)
  app.get('/meta/specialties', {
    schema: {
      summary: 'List all available specialties',
      tags: ['Doctors'],
      security: [{ bearerAuth: [] }],
      response: {
        200: {
          type: 'array',
          items: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const branchId = await getLoggedBranchId(request);
    if (!branchId) return (reply as any).code(403).send({ error: 'User not associated with a branch' });

    const doctors = await prisma.doctor.findMany({
      where: { branchId },
      select: {
        specialty: true,
        specialties: true,
      },
    });

    const specialtiesSet = new Set<string>();
    doctors.forEach((d: { specialty: string; specialties: string[] }) => {
      specialtiesSet.add(d.specialty);
      d.specialties.forEach((s: string) => specialtiesSet.add(s));
    });

    return Array.from(specialtiesSet).sort();
  });
}
