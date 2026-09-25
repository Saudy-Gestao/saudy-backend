import { FastifyInstance } from "fastify";
import { Prisma } from "@prisma/client";
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

function agendaValuesOverlap(a: any, b: any) {
  return a.branchId === b.branchId
    && a.doctorId === b.doctorId
    && (a.internId || null) === (b.internId || null)
    && a.weekday === b.weekday
    && a.status === "ATIVA"
    && b.status === "ATIVA"
    && timeRangesOverlap(a.shiftStart, a.shiftEnd, b.shiftStart, b.shiftEnd)
    && dateRangesOverlap(a.startDate, a.endDate, b.startDate, b.endDate);
}

function formatWeekday(value?: string | null) {
  const labels: Record<string, string> = {
    domingo: "domingo-feira",
    segunda: "segunda-feira",
    terca: "terça-feira",
    quarta: "quarta-feira",
    quinta: "quinta-feira",
    sexta: "sexta-feira",
    sabado: "sábado",
  };
  return labels[String(value || "").toLowerCase()] || String(value || "dia não informado");
}

function formatAgendaConflictMessage(value: any, conflict: any, itemIndex?: number) {
  const prefix = itemIndex === undefined ? "Existe um conflito" : `Existe um conflito no horário ${itemIndex + 1} da escala`;
  const requested = `${formatWeekday(value.weekday)}, das ${value.shiftStart} às ${value.shiftEnd}`;
  const existing = conflict
    ? `A agenda existente está configurada das ${conflict.shiftStart} às ${conflict.shiftEnd} no mesmo dia.`
    : "Já existe uma agenda ativa para esse profissional nesse período.";
  return `${prefix}: ${requested}. ${existing}`;
}

class AgendaOverlapError extends Error {
  conflict: unknown;

  constructor(message: string, conflict: unknown) {
    super(message);
    this.name = "AgendaOverlapError";
    this.conflict = conflict;
  }
}

function normalizeEspecialidadeIds(data: { especialidadeIds?: unknown; especialidadeId?: unknown } | null | undefined): string[] {
  const ids = [
    ...(Array.isArray(data?.especialidadeIds) ? data.especialidadeIds : []),
    data?.especialidadeId,
  ];

  return Array.from(new Set(ids
    .map((id) => String(id || '').trim())
    .filter(Boolean)));
}

function getAgendaEspecialidadeIds(agenda: { especialidadeIds?: unknown; especialidadeId?: unknown }): string[] {
  return normalizeEspecialidadeIds(agenda);
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
    intern: { select: { id: true, name: true } },
    especialidade: { select: { id: true, name: true, modalidadeId: true } },
    room: { select: { id: true, name: true } },
  } as const;

  const hydrateAgendaEspecialidades = async (items: any[]) => {
    const ids = Array.from(new Set(items.flatMap((item) => getAgendaEspecialidadeIds(item))));
    if (ids.length === 0) return items.map((item) => ({ ...item, especialidades: [] }));

    const records = await prisma.especialidade.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true, modalidadeId: true },
    });
    const byId = new Map(records.map((record: any) => [String(record.id), record]));

    return items.map((item) => ({
      ...item,
      especialidades: getAgendaEspecialidadeIds(item)
        .map((id) => byId.get(id))
        .filter(Boolean),
    }));
  };

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
    return { items: await hydrateAgendaEspecialidades(items), total: items.length };
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
    const [hydratedItem] = await hydrateAgendaEspecialidades([item]);
    return hydratedItem;
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

    const internId = String(data.internId || "").trim() || null;
    if (internId) {
      const intern = await prisma.intern.findFirst({
        where: {
          id: internId,
          branchId,
          doctors: { some: { doctorId } },
        },
        select: { id: true },
      });
      if (!intern) return { error: "Estagiário não está vinculado a esse profissional e unidade" };
    }

    const weekday = normalizeWeekday(data.weekday);
    if (!VALID_WEEKDAYS.has(weekday)) return { error: "Dia da semana inválido" };

    const shiftStart = normalizeTime(data.shiftStart);
    const shiftEnd = normalizeTime(data.shiftEnd);
    if (!shiftStart || !shiftEnd) return { error: "Turno deve ter início e fim no formato HH:mm" };
    if (shiftEnd <= shiftStart) return { error: "O fim do turno deve ser maior que o início" };

    const especialidadeIds = normalizeEspecialidadeIds(data);
    let especialidadeId: string | null = especialidadeIds[0] || null;
    if (especialidadeIds.length > 0) {
      const especialidades = await Promise.all(especialidadeIds.map((id) => (
        prisma.especialidade.findUnique({ where: { id } })
      )));
      if (especialidades.some((especialidade) => !especialidade)) return { error: "Especialidade inválida" };
      let groups: Array<{ especialidadeId?: unknown; especialidadeIds?: unknown }> = [];
      try {
        const parsed = JSON.parse(doctor.especialidadeGroups || "[]");
        groups = Array.isArray(parsed) ? parsed : [];
      } catch {
        groups = [];
      }
      const doctorEspecialidadeIds = new Set(
        groups.flatMap((group) => [
          group?.especialidadeId,
          ...(Array.isArray(group?.especialidadeIds) ? group.especialidadeIds : []),
        ]).map((id: unknown) => String(id || '').trim()).filter(Boolean),
      );
      if (especialidadeIds.some((id) => !doctorEspecialidadeIds.has(id))) {
        return { error: "Especialidade não vinculada a esse profissional" };
      }
    }

    let roomId: string | null = null;
    if (data.roomId) {
      const room = await prisma.sector.findUnique({ where: { id: data.roomId } });
      if (!room || room.branchId !== branchId) return { error: "Sala inválida para essa unidade" };
      const roomEspecialidadeIds = normalizeEspecialidadeIds(room);
      if (especialidadeIds.length > 0 && roomEspecialidadeIds.length > 0
        && especialidadeIds.some((id) => !roomEspecialidadeIds.includes(id))) {
        return { error: "Sala não está vinculada a todas as especialidades selecionadas" };
      }
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
        branchId, doctorId, internId, weekday, shiftStart, shiftEnd, especialidadeId, especialidadeIds, roomId, startDate, endDate, status,
      },
    };
  };

  const checkOverlap = async (value: any, excludeId?: string, db: any = prisma) => {
    const siblings = await db.agenda.findMany({
      where: {
        branchId: value.branchId,
        doctorId: value.doctorId,
        internId: value.internId,
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

  const agendaCreateBodySchema = {
    type: "object",
    required: ["branchId", "doctorId", "weekday", "shiftStart", "shiftEnd"],
    properties: {
      branchId: { type: "string" },
      doctorId: { type: "string" },
      internId: { type: "string", nullable: true },
      weekday: { type: "string" },
      shiftStart: { type: "string" },
      shiftEnd: { type: "string" },
      especialidadeId: { type: "string", nullable: true },
      especialidadeIds: { type: "array", items: { type: "string" } },
      roomId: { type: "string", nullable: true },
      startDate: { type: "string", nullable: true },
      endDate: { type: "string", nullable: true },
      status: { type: "string", nullable: true },
    },
  } as const;

  app.post("/bulk", {
    schema: {
      summary: "Create agenda scale atomically",
      tags: ["Agendas"],
      body: {
        type: "object",
        required: ["items"],
        properties: {
          items: { type: "array", minItems: 1, items: agendaCreateBodySchema },
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

    const rawItems = (request.body as any)?.items;
    if (!Array.isArray(rawItems) || rawItems.length === 0) {
      return reply.code(400).send({ error: "A escala precisa ter pelo menos um horário" });
    }

    const values: any[] = [];
    for (let index = 0; index < rawItems.length; index += 1) {
      const result = await validateAndNormalizeBody(rawItems[index], context);
      if ("error" in result) {
        return reply.code(400).send({ error: result.error, itemIndex: index });
      }
      values.push(result.value);
    }

    // Validate the complete payload before opening the write transaction. This
    // catches overlaps between items in the same scale without persisting a
    // valid prefix of the batch.
    for (let index = 0; index < values.length; index += 1) {
      const value = values[index];
      const batchConflictIndex = values
        .slice(0, index)
        .findIndex((previous) => agendaValuesOverlap(value, previous));
      if (batchConflictIndex >= 0) {
        const conflict = values[batchConflictIndex];
        return reply.code(409).send({
          error: "AGENDA_OVERLAP",
          message: formatAgendaConflictMessage(value, conflict, index),
          itemIndex: index,
          conflictItemIndex: batchConflictIndex,
          conflict,
        });
      }

      const existing = await checkOverlap(value);
      if (existing) {
        return reply.code(409).send({
          error: "AGENDA_OVERLAP",
          message: formatAgendaConflictMessage(value, existing, index),
          itemIndex: index,
          conflict: existing,
        });
      }
    }

    try {
      const created = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        // Re-check inside the transaction to protect the batch from another
        // request that creates an overlapping agenda after the preflight.
        for (let index = 0; index < values.length; index += 1) {
          const existing = await checkOverlap(values[index], undefined, tx);
          if (existing) throw new AgendaOverlapError(formatAgendaConflictMessage(values[index], existing, index), existing);
        }

        return Promise.all(values.map((value) => tx.agenda.create({
          data: {
            ...value,
            createdByUserId: context.userId,
            createdByName: context.userName,
            updatedByUserId: context.userId,
            updatedByName: context.userName,
          },
          include,
        })));
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

      return reply.code(201).send({ items: created, total: created.length });
    } catch (err: any) {
      if (err instanceof AgendaOverlapError) {
        return reply.code(409).send({ error: "AGENDA_OVERLAP", message: err.message, conflict: err.conflict });
      }
      request.log.error({ err }, "Failed to create agenda scale");
      return reply.code(409).send({ error: "AGENDA_SCALE_CONFLICT", message: "A escala não pôde ser salva porque os horários foram alterados. Revise e tente novamente." });
    }
  });

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
          internId: { type: "string", nullable: true },
          weekday: { type: "string" },
          shiftStart: { type: "string" },
          shiftEnd: { type: "string" },
          especialidadeId: { type: "string", nullable: true },
          especialidadeIds: { type: "array", items: { type: "string" } },
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
    const hasEspecialidadeIds = data.especialidadeIds !== undefined;
    const merged = {
      branchId: data.branchId !== undefined ? data.branchId : existing.branchId,
      doctorId: data.doctorId !== undefined ? data.doctorId : existing.doctorId,
      internId: data.internId !== undefined ? data.internId : existing.internId,
      weekday: data.weekday !== undefined ? data.weekday : existing.weekday,
      shiftStart: data.shiftStart !== undefined ? data.shiftStart : existing.shiftStart,
      shiftEnd: data.shiftEnd !== undefined ? data.shiftEnd : existing.shiftEnd,
      especialidadeId: hasEspecialidadeIds
        ? (Array.isArray(data.especialidadeIds) ? data.especialidadeIds[0] || null : null)
        : (data.especialidadeId !== undefined ? data.especialidadeId : existing.especialidadeId),
      especialidadeIds: hasEspecialidadeIds ? data.especialidadeIds : existing.especialidadeIds,
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
