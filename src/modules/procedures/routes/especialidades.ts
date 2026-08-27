import { FastifyInstance } from "fastify";
import prisma from "../lib/prisma";

const SIMILARITY_THRESHOLD = 0.75;

function normalizeForCompare(value: string) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function levenshteinDistance(a: string, b: string) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  const dp: number[] = new Array(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;

  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const temp = dp[j];
      dp[j] = a[i - 1] === b[j - 1]
        ? prev
        : 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = temp;
    }
  }
  return dp[n];
}

function similarityRatio(a: string, b: string) {
  const maxLength = Math.max(a.length, b.length);
  if (maxLength === 0) return 1;
  return 1 - levenshteinDistance(a, b) / maxLength;
}

function normalizeMetodos(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return Array.from(
    new Set(
      value
        .map((item) => String(item || "").trim())
        .filter((item) => item.length > 0),
    ),
  );
}

export default async function especialidadeRoutes(app: FastifyInstance) {
  const normalizeBranchId = (value: string | null | undefined) => (value || "").trim();
  const canAccessRecord = (recordBranchId: string | null | undefined, loggedBranchId: string) => {
    const normalized = normalizeBranchId(recordBranchId);
    return normalized === "" || normalized === loggedBranchId;
  };

  const getLoggedUser = async (request: any) => {
    const userId = (request.user as any)?.id;
    if (!userId) return { userId: null, userName: null, branchId: null };
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { sector: { include: { branch: true } } },
    });
    return {
      userId: user?.id || null,
      userName: (user as any)?.name || null,
      branchId: user?.sector?.branch?.id || null,
    };
  };

  const createAuditLog = async (params: {
    branchId: string;
    especialidadeId?: string;
    action: string;
    performedByUserId?: string | null;
    performedByName?: string | null;
    details?: string;
  }) => {
    try {
      await prisma.especialidadeAuditLog.create({ data: params });
    } catch {
      // Falha ao gravar auditoria nunca deve derrubar a operação principal.
    }
  };

  const modalidadeInclude = {
    modalidade: { select: { id: true, name: true } },
    cbo: { select: { id: true, code: true, title: true } },
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
      summary: "List especialidades",
      tags: ["Especialidades"],
      querystring: {
        type: "object",
        properties: {
          modalidadeId: { type: "string" },
          search: { type: "string" },
          isActive: { type: "boolean" },
          limit: { type: "number", default: 100 },
          offset: { type: "number", default: 0 },
        },
      },
    },
  }, async (request, reply) => {
    const { branchId } = await getLoggedUser(request);
    if (!branchId) return (reply as any).code(403).send({ error: "User not associated with a branch" });

    const { modalidadeId, search, isActive, limit = 100, offset = 0 } = request.query as any;

    const where: any = {
      AND: [
        {
          OR: [
            { branchId },
            { branchId: null },
            { branchId: "" },
          ],
        },
      ],
    };
    if (modalidadeId) where.AND.push({ modalidadeId });
    if (isActive !== undefined) where.AND.push({ isActive });
    if (search) {
      where.AND.push({
        OR: [
          { name: { contains: search, mode: "insensitive" } },
        ],
      });
    }

    const [items, total] = await Promise.all([
      prisma.especialidade.findMany({
        where,
        take: limit,
        skip: offset,
        orderBy: { name: "asc" },
        include: modalidadeInclude,
      }),
      prisma.especialidade.count({ where }),
    ]);

    return { items, total };
  });

  app.get("/:id", {
    schema: {
      summary: "Get especialidade by ID",
      tags: ["Especialidades"],
      params: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    },
  }, async (request, reply) => {
    const { branchId } = await getLoggedUser(request);
    if (!branchId) return (reply as any).code(403).send({ error: "User not associated with a branch" });

    const { id } = request.params as any;
    const item = await prisma.especialidade.findUnique({ where: { id }, include: modalidadeInclude });
    if (!item) return reply.code(404).send({ error: "Especialidade not found" });
    if (!canAccessRecord(item.branchId, branchId)) return reply.code(404).send({ error: "Especialidade not found" });
    return item;
  });

  app.get("/:id/audit", {
    schema: {
      summary: "List audit log entries for an especialidade",
      tags: ["Especialidades"],
      params: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    },
  }, async (request, reply) => {
    const { branchId } = await getLoggedUser(request);
    if (!branchId) return (reply as any).code(403).send({ error: "User not associated with a branch" });

    const { id } = request.params as any;
    const item = await prisma.especialidade.findUnique({ where: { id } });
    if (!item) return reply.code(404).send({ error: "Especialidade not found" });
    if (!canAccessRecord(item.branchId, branchId)) return reply.code(404).send({ error: "Especialidade not found" });

    const logs = await prisma.especialidadeAuditLog.findMany({
      where: { especialidadeId: id },
      orderBy: { createdAt: "desc" },
    });
    return { items: logs };
  });

  app.post("/", {
    schema: {
      summary: "Create especialidade",
      tags: ["Especialidades"],
      body: {
        type: "object",
        required: ["modalidadeId", "name"],
        properties: {
          modalidadeId: { type: "string" },
          name: { type: "string" },
          metodos: { type: "array", items: { type: "string" } },
          cboId: { type: "string", nullable: true },
          force: { type: "boolean" },
        },
      },
      response: {
        201: { type: "object", additionalProperties: true },
        400: { type: "object", additionalProperties: true },
        404: { type: "object", additionalProperties: true },
        409: { type: "object", additionalProperties: true },
      },
    },
  }, async (request, reply) => {
    const { branchId, userId, userName } = await getLoggedUser(request);
    if (!branchId) return (reply as any).code(403).send({ error: "User not associated with a branch" });

    const data = request.body as any;
    const name = String(data.name || "").trim();
    if (!name) return reply.code(400).send({ error: "Name is required" });

    const modalidade = await prisma.modalidade.findUnique({ where: { id: data.modalidadeId } });
    if (!modalidade) return reply.code(404).send({ error: "Modalidade not found" });
    if (!canAccessRecord(modalidade.branchId, branchId)) return reply.code(404).send({ error: "Modalidade not found" });

    let cboId: string | null = null;
    if (data.cboId) {
      const cbo = await prisma.cbo.findUnique({ where: { id: data.cboId } });
      if (!cbo || !cbo.isActive) return reply.code(404).send({ error: "Cbo not found" });
      cboId = cbo.id;
    }

    const metodos = normalizeMetodos(data.metodos) || [];
    const normalizedNew = normalizeForCompare(name);

    const activeItems = await prisma.especialidade.findMany({
      where: {
        modalidadeId: data.modalidadeId,
        isActive: true,
        OR: [{ branchId }, { branchId: null }, { branchId: "" }],
      },
    });

    const exactMatch = activeItems.find((item: any) => normalizeForCompare(item.name) === normalizedNew);
    if (exactMatch) {
      return reply.code(409).send({ error: "DUPLICATE_EXACT", existing: exactMatch });
    }

    if (!data.force) {
      const similar = activeItems.filter((item: any) => {
        const ratio = similarityRatio(normalizedNew, normalizeForCompare(item.name));
        return ratio >= SIMILARITY_THRESHOLD && ratio < 1;
      });
      if (similar.length > 0) {
        return reply.code(409).send({
          error: "SIMILAR_EXISTS",
          similar: similar.map((item: any) => ({ id: item.id, name: item.name })),
        });
      }
    }

    try {
      const created = await prisma.especialidade.create({
        data: {
          branchId,
          modalidadeId: data.modalidadeId,
          name,
          metodos,
          cboId,
          isActive: true,
          createdByUserId: userId,
          createdByName: userName,
          updatedByUserId: userId,
          updatedByName: userName,
        },
        include: modalidadeInclude,
      });

      await createAuditLog({
        branchId,
        especialidadeId: created.id,
        action: "CREATE",
        performedByUserId: userId,
        performedByName: userName,
        details: `Especialidade "${created.name}" criada em "${modalidade.name}"`,
      });

      return reply.code(201).send(created);
    } catch (err: any) {
      request.log.error({ err }, "Failed to create especialidade");
      return reply.code(400).send({ error: "Failed to create especialidade", details: err.message });
    }
  });

  app.put("/:id", {
    schema: {
      summary: "Update especialidade",
      tags: ["Especialidades"],
      params: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      body: { type: "object" },
      response: {
        200: { type: "object", additionalProperties: true },
        400: { type: "object", additionalProperties: true },
        404: { type: "object", additionalProperties: true },
        409: { type: "object", additionalProperties: true },
      },
    },
  }, async (request, reply) => {
    const { branchId, userId, userName } = await getLoggedUser(request);
    if (!branchId) return (reply as any).code(403).send({ error: "User not associated with a branch" });

    const { id } = request.params as any;
    const data = request.body as any;

    const existing = await prisma.especialidade.findUnique({ where: { id } });
    if (!existing) return reply.code(404).send({ error: "Especialidade not found" });
    if (!canAccessRecord(existing.branchId, branchId)) return reply.code(404).send({ error: "Especialidade not found" });

    const nextName = data.name !== undefined ? String(data.name || "").trim() : existing.name;
    if (!nextName) return reply.code(400).send({ error: "Name is required" });

    if (data.name !== undefined) {
      const normalizedNew = normalizeForCompare(nextName);
      const activeItems = await prisma.especialidade.findMany({
        where: {
          id: { not: id },
          modalidadeId: existing.modalidadeId,
          isActive: true,
          OR: [{ branchId }, { branchId: null }, { branchId: "" }],
        },
      });

      const exactMatch = activeItems.find((item: any) => normalizeForCompare(item.name) === normalizedNew);
      if (exactMatch) {
        return reply.code(409).send({ error: "DUPLICATE_EXACT", existing: exactMatch });
      }

      if (!data.force) {
        const similar = activeItems.filter((item: any) => {
          const ratio = similarityRatio(normalizedNew, normalizeForCompare(item.name));
          return ratio >= SIMILARITY_THRESHOLD && ratio < 1;
        });
        if (similar.length > 0) {
          return reply.code(409).send({
            error: "SIMILAR_EXISTS",
            similar: similar.map((item: any) => ({ id: item.id, name: item.name })),
          });
        }
      }
    }

    if (data.cboId !== undefined && data.cboId !== null) {
      const cbo = await prisma.cbo.findUnique({ where: { id: data.cboId } });
      if (!cbo || !cbo.isActive) return reply.code(404).send({ error: "Cbo not found" });
    }

    const updateData: any = { updatedByUserId: userId, updatedByName: userName };
    if (data.name !== undefined) updateData.name = nextName;
    if (data.metodos !== undefined) updateData.metodos = normalizeMetodos(data.metodos) || [];
    if (data.cboId !== undefined) updateData.cboId = data.cboId || null;
    if (data.isActive !== undefined) updateData.isActive = data.isActive;

    const changeDescriptions: string[] = [];
    if (data.name !== undefined && data.name !== existing.name) {
      changeDescriptions.push(`nome: "${existing.name}" -> "${nextName}"`);
    }
    if (data.metodos !== undefined) {
      changeDescriptions.push(`métodos: [${existing.metodos.join(", ")}] -> [${(updateData.metodos as string[]).join(", ")}]`);
    }
    if (data.isActive !== undefined && data.isActive !== existing.isActive) {
      changeDescriptions.push(`ativo: ${existing.isActive} -> ${data.isActive}`);
    }

    try {
      const updated = await prisma.especialidade.update({
        where: { id },
        data: updateData,
        include: modalidadeInclude,
      });

      await createAuditLog({
        branchId,
        especialidadeId: id,
        action: "UPDATE",
        performedByUserId: userId,
        performedByName: userName,
        details: changeDescriptions.length > 0 ? changeDescriptions.join("; ") : "Nenhuma alteração relevante",
      });

      return updated;
    } catch (err: any) {
      request.log.error({ err }, "Failed to update especialidade");
      return reply.code(400).send({ error: "Failed to update especialidade", details: err.message });
    }
  });

  app.delete("/:id", {
    schema: {
      summary: "Delete (deactivate) especialidade",
      tags: ["Especialidades"],
      params: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    },
  }, async (request, reply) => {
    const { branchId, userId, userName } = await getLoggedUser(request);
    if (!branchId) return (reply as any).code(403).send({ error: "User not associated with a branch" });

    const { id } = request.params as any;
    const existing = await prisma.especialidade.findUnique({ where: { id } });
    if (!existing) return reply.code(404).send({ error: "Especialidade not found" });
    if (!canAccessRecord(existing.branchId, branchId)) return reply.code(404).send({ error: "Especialidade not found" });

    await prisma.especialidade.update({
      where: { id },
      data: { isActive: false, updatedByUserId: userId, updatedByName: userName },
    });

    await createAuditLog({
      branchId,
      especialidadeId: id,
      action: "DELETE",
      performedByUserId: userId,
      performedByName: userName,
      details: `Especialidade "${existing.name}" excluída`,
    });

    return { message: "Deleted" };
  });
}
