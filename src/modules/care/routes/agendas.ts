import { FastifyInstance } from "fastify";
import prisma from "../lib/prisma";

const VALID_WEEKDAYS = new Set(["domingo", "segunda", "terca", "quarta", "quinta", "sexta", "sabado"]);
const VALID_STATUS = new Set(["ATIVA", "INATIVA", "BLOQUEADA"]);

function normalizeWeekday(value?: string | null) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim()
    .toLowerCase();
}

function normalizeTime(value?: string | null): string | null {
  const raw = String(value || "").trim();
  if (!raw) return null;
  return /^\d{2}:\d{2}$/.test(raw) ? raw : null;
}

function timeRangesOverlap(startA: string, endA: string, startB: string, endB: string) {
  return startA < endB && startB < endA;
}

function dateRangesOverlap(startA?: Date | null, endA?: Date | null, startB?: Date | null, endB?: Date | null) {
  if (startA && endB && startA > endB) return false;
  if (startB && endA && startB > endA) return false;
  return true;
}

export default async function agendaRoutes(app: FastifyInstance) {
  const getLoggedContext = async (userId: string) => {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { sector: { include: { branch: true } } },
    });
    const branch = user?.sector?.branch;
    if (!branch?.companyId) return null;
    return { companyId: branch.companyId, userId: user?.id, userName: (user as any)?.name || null };
  };

  const include = {
    branch: { select: { id: true, tradeName: true } },
    doctor: { select: { id: true, name: true } },
    especialidade: { select: { id: true, name: true, modalidadeId: true } },
    room: { select: { id: true, name: true } },
  } as const;

  app.addHook("onRequest", async (request, reply) => {
    try {
      await request.jwtVerify();
    } catch (err) {
      return reply.code(401).send({ error: "Unauthorized" });
    }
  });

  app.get("/", {
    schema: {
      summary: "List agendas",
      tags: ["Agendas"],
      querystring: {
        type: "object",
        properties: {
          branchId: { type: "string" },
          doctorId: { type: "string" },
          status: { type: "string" },
        },
      },
    },
  }, async (request, reply) => {
    const userId = (request.user as any).id;
    const context = await getLoggedContext(userId);
    if (!context) return reply.code(403).send({ error: "User not associated with a company" });

    const { branchId, doctorId, status } = request.query as any;

    const companyBranches = await prisma.branch.findMany({
      where: { companyId: context.companyId },
      select: { id: true },
    });
    const companyBranchIds = companyBranches.map((b: any) => b.id);

    const where: any = { branchId: { in: companyBranchIds } };
    if (branchId) where.branchId = branchId;
    if (doctorId) where.doctorId = doctorId;
    if (status) where.status = status;

    const items = await prisma.agenda.findMany({
      where,
      include,
      orderBy: [{ doctorId: "asc" }, { weekday: "asc" }, { shiftStart: "asc" }],
    });
    return { items, total: items.length };
  });

  app.get("/:id", {
    schema: {
      summary: "Get agenda by id",
      tags: ["Agendas"],
      params: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    },
  }, async (request, reply) => {
    const userId = (request.user as any).id;
    const context = await getLoggedContext(userId);
    if (!context) return reply.code(403).send({ error: "User not associated with a company" });

    const { id } = request.params as any;
    const item = await prisma.agenda.findUnique({ where: { id }, include });
    if (!item) return reply.code(404).send({ error: "Agenda not found" });
    const branch = await prisma.branch.findFirst({ where: { id: item.branchId, companyId: context.companyId } });
    if (!branch) return reply.code(404).send({ error: "Agenda not found" });
    return item;
  });

  const validateAndNormalizeBody = async (data: any, context: { companyId: string }, currentBranchId?: string) => {
    const branchId = String(data.branchId || currentBranchId || "").trim();
    if (!branchId) return { error: "Unidade é obrigatória" };

    const branch = await prisma.branch.findFirst({ where: { id: branchId, companyId: context.companyId } });
    if (!branch) return { error: "Unidade inválida para sua empresa" };

    const doctorId = String(data.doctorId || "").trim();
    if (!doctorId) return { error: "Profissional é obrigatório" };
    const doctor = await prisma.doctor.findUnique({ where: { id: doctorId } });
    if (!doctor) return { error: "Profissional inválido" };
    const doctorBranchIds = Array.isArray(doctor.branchIds) ? doctor.branchIds : [];
    if (!doctorBranchIds.includes(branchId) && doctor.branchId !== branchId) {
      return { error: "Profissional não atende nessa unidade" };
    }

    const weekday = normalizeWeekday(data.weekday);
    if (!VALID_WEEKDAYS.has(weekday)) return { error: "Dia da semana inválido" };

    const shiftStart = normalizeTime(data.shiftStart);
    const shiftEnd = normalizeTime(data.shiftEnd);
    if (!shiftStart || !shiftEnd) return { error: "Turno deve ter início e fim no formato HH:mm" };
    if (shiftEnd <= shiftStart) return { error: "O fim do turno deve ser maior que o início" };

    let especialidadeId: string | null = null;
    if (data.especialidadeId) {
      const especialidade = await prisma.especialidade.findUnique({ where: { id: data.especialidadeId } });
      if (!especialidade) return { error: "Especialidade inválida" };
      let groups: any[] = [];
      try {
        const parsed = JSON.parse(doctor.especialidadeGroups || "[]");
        groups = Array.isArray(parsed) ? parsed : [];
      } catch {
        groups = [];
      }
      const belongsToDoctor = groups.some((g: any) => g?.especialidadeId === especialidade.id);
      if (!belongsToDoctor) return { error: "Especialidade não vinculada a esse profissional" };
      especialidadeId = especialidade.id;
    }

    let roomId: string | null = null;
    if (data.roomId) {
      const room = await prisma.sector.findUnique({ where: { id: data.roomId } });
      if (!room || room.branchId !== branchId) return { error: "Sala inválida para essa unidade" };
      roomId = room.id;
    }

    const startDate = data.startDate ? new Date(data.startDate) : null;
    const endDate = data.endDate ? new Date(data.endDate) : null;
    if (startDate && Number.isNaN(startDate.getTime())) return { error: "Data de ativação inválida" };
    if (endDate && Number.isNaN(endDate.getTime())) return { error: "Data de finalização inválida" };
    if (startDate && endDate && endDate < startDate) return { error: "Data de finalização deve ser após a de ativação" };

    const status = data.status !== undefined ? String(data.status).toUpperCase() : "ATIVA";
    if (!VALID_STATUS.has(status)) return { error: "Status inválido" };

    return {
      value: {
        branchId, doctorId, weekday, shiftStart, shiftEnd, especialidadeId, roomId, startDate, endDate, status,
      },
    };
  };

  const checkOverlap = async (value: any, excludeId?: string) => {
    const siblings = await prisma.agenda.findMany({
      where: {
        doctorId: value.doctorId,
        weekday: value.weekday,
        status: "ATIVA",
        ...(excludeId ? { id: { not: excludeId } } : {}),
      },
    });
    const conflict = siblings.find((s: any) => (
      timeRangesOverlap(value.shiftStart, value.shiftEnd, s.shiftStart, s.shiftEnd)
      && dateRangesOverlap(value.startDate, value.endDate, s.startDate, s.endDate)
    ));
    return conflict || null;
  };

  app.post("/", {
    schema: {
      summary: "Create agenda",
      tags: ["Agendas"],
      body: {
        type: "object",
        required: ["branchId", "doctorId", "weekday", "shiftStart", "shiftEnd"],
        properties: {
          branchId: { type: "string" },
          doctorId: { type: "string" },
          weekday: { type: "string" },
          shiftStart: { type: "string" },
          shiftEnd: { type: "string" },
          especialidadeId: { type: "string", nullable: true },
          roomId: { type: "string", nullable: true },
          startDate: { type: "string", nullable: true },
          endDate: { type: "string", nullable: true },
          status: { type: "string", nullable: true },
        },
      },
      response: {
        201: { type: "object", additionalProperties: true },
        400: { type: "object", additionalProperties: true },
        403: { type: "object", additionalProperties: true },
        409: { type: "object", additionalProperties: true },
      },
    },
  }, async (request, reply) => {
    const userId = (request.user as any).id;
    const context = await getLoggedContext(userId);
    if (!context) return reply.code(403).send({ error: "User not associated with a company" });

    const result = await validateAndNormalizeBody(request.body, context);
    if ("error" in result) return reply.code(400).send({ error: result.error });
    const value = result.value!;

    const overlap = await checkOverlap(value);
    if (overlap) {
      return reply.code(409).send({ error: "AGENDA_OVERLAP", message: "Já existe uma agenda ativa nesse dia/turno para esse profissional", conflict: overlap });
    }

    try {
      const created = await prisma.agenda.create({
        data: {
          ...value,
          createdByUserId: context.userId,
          createdByName: context.userName,
          updatedByUserId: context.userId,
          updatedByName: context.userName,
        },
        include,
      });
      return reply.code(201).send(created);
    } catch (err: any) {
      request.log.error({ err }, "Failed to create agenda");
      return reply.code(400).send({ error: "Failed to create agenda", details: err.message });
    }
  });

  app.put("/:id", {
    schema: {
      summary: "Update agenda",
      tags: ["Agendas"],
      params: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      body: { type: "object" },
      response: {
        200: { type: "object", additionalProperties: true },
        400: { type: "object", additionalProperties: true },
        403: { type: "object", additionalProperties: true },
        404: { type: "object", additionalProperties: true },
        409: { type: "object", additionalProperties: true },
      },
    },
  }, async (request, reply) => {
    const userId = (request.user as any).id;
    const context = await getLoggedContext(userId);
    if (!context) return reply.code(403).send({ error: "User not associated with a company" });

    const { id } = request.params as any;
    const existing = await prisma.agenda.findUnique({ where: { id } });
    if (!existing) return reply.code(404).send({ error: "Agenda not found" });

    const branch = await prisma.branch.findFirst({ where: { id: existing.branchId, companyId: context.companyId } });
    if (!branch) return reply.code(404).send({ error: "Agenda not found" });

    const data = request.body as any;
    const merged = {
      branchId: data.branchId !== undefined ? data.branchId : existing.branchId,
      doctorId: data.doctorId !== undefined ? data.doctorId : existing.doctorId,
      weekday: data.weekday !== undefined ? data.weekday : existing.weekday,
      shiftStart: data.shiftStart !== undefined ? data.shiftStart : existing.shiftStart,
      shiftEnd: data.shiftEnd !== undefined ? data.shiftEnd : existing.shiftEnd,
      especialidadeId: data.especialidadeId !== undefined ? data.especialidadeId : existing.especialidadeId,
      roomId: data.roomId !== undefined ? data.roomId : existing.roomId,
      startDate: data.startDate !== undefined ? data.startDate : existing.startDate,
      endDate: data.endDate !== undefined ? data.endDate : existing.endDate,
      status: data.status !== undefined ? data.status : existing.status,
    };

    const result = await validateAndNormalizeBody(merged, context, existing.branchId);
    if ("error" in result) return reply.code(400).send({ error: result.error });
    const value = result.value!;

    const overlap = await checkOverlap(value, id);
    if (overlap) {
      return reply.code(409).send({ error: "AGENDA_OVERLAP", message: "Já existe uma agenda ativa nesse dia/turno para esse profissional", conflict: overlap });
    }

    try {
      const updated = await prisma.agenda.update({
        where: { id },
        data: { ...value, updatedByUserId: context.userId, updatedByName: context.userName },
        include,
      });
      return updated;
    } catch (err: any) {
      request.log.error({ err }, "Failed to update agenda");
      return reply.code(400).send({ error: "Failed to update agenda", details: err.message });
    }
  });

  app.delete("/:id", {
    schema: {
      summary: "Delete agenda",
      tags: ["Agendas"],
      params: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    },
  }, async (request, reply) => {
    const userId = (request.user as any).id;
    const context = await getLoggedContext(userId);
    if (!context) return reply.code(403).send({ error: "User not associated with a company" });

    const { id } = request.params as any;
    const existing = await prisma.agenda.findUnique({ where: { id } });
    if (!existing) return reply.code(404).send({ error: "Agenda not found" });
    const branch = await prisma.branch.findFirst({ where: { id: existing.branchId, companyId: context.companyId } });
    if (!branch) return reply.code(404).send({ error: "Agenda not found" });

    await prisma.agenda.delete({ where: { id } });
    return { message: "Deleted" };
  });
}
