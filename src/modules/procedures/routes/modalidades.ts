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

export default async function modalidadeRoutes(app: FastifyInstance) {
  const normalizeBranchId = (value: string | null | undefined) => (value || "").trim();
  const canAccessModalidade = (modalidadeBranchId: string | null | undefined, loggedBranchId: string) => {
    const normalized = normalizeBranchId(modalidadeBranchId);
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
    modalidadeId?: string;
    action: string;
    performedByUserId?: string | null;
    performedByName?: string | null;
    details?: string;
  }) => {
    try {
      await prisma.modalidadeAuditLog.create({ data: params });
    } catch {
      // Falha ao gravar auditoria nunca deve derrubar a operação principal.
    }
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
      summary: "List modalidades",
      tags: ["Modalidades"],
      querystring: {
        type: "object",
        properties: {
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

    const { search, isActive, limit = 100, offset = 0 } = request.query as any;

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
    if (isActive !== undefined) {
      where.AND.push({ isActive });
    }
    if (search) {
      where.AND.push({
        OR: [
          { name: { contains: search, mode: "insensitive" } },
          { description: { contains: search, mode: "insensitive" } },
        ],
      });
    }

    const [items, total] = await Promise.all([
      prisma.modalidade.findMany({
        where,
        take: limit,
        skip: offset,
        orderBy: { name: "asc" },
      }),
      prisma.modalidade.count({ where }),
    ]);

    return { items, total };
  });

  app.get("/:id", {
    schema: {
      summary: "Get modalidade by ID",
      tags: ["Modalidades"],
      params: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    },
  }, async (request, reply) => {
    const { branchId } = await getLoggedUser(request);
    if (!branchId) return (reply as any).code(403).send({ error: "User not associated with a branch" });

    const { id } = request.params as any;
    const item = await prisma.modalidade.findUnique({ where: { id } });
    if (!item) return reply.code(404).send({ error: "Modalidade not found" });
    if (!canAccessModalidade(item.branchId, branchId)) return reply.code(404).send({ error: "Modalidade not found" });
    return item;
  });

  app.get("/:id/audit", {
    schema: {
      summary: "List audit log entries for a modalidade",
      tags: ["Modalidades"],
      params: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    },
  }, async (request, reply) => {
    const { branchId } = await getLoggedUser(request);
    if (!branchId) return (reply as any).code(403).send({ error: "User not associated with a branch" });

    const { id } = request.params as any;
    const item = await prisma.modalidade.findUnique({ where: { id } });
    if (!item) return reply.code(404).send({ error: "Modalidade not found" });
    if (!canAccessModalidade(item.branchId, branchId)) return reply.code(404).send({ error: "Modalidade not found" });

    const logs = await prisma.modalidadeAuditLog.findMany({
      where: { modalidadeId: id },
      orderBy: { createdAt: "desc" },
    });
    return { items: logs };
  });

  app.post("/", {
    schema: {
      summary: "Create modalidade",
      tags: ["Modalidades"],
      body: {
        type: "object",
        required: ["name"],
        properties: {
          name: { type: "string" },
          description: { type: "string" },
          force: { type: "boolean" },
        },
      },
      response: {
        201: { type: "object", additionalProperties: true },
        400: { type: "object", additionalProperties: true },
        409: { type: "object", additionalProperties: true },
      },
    },
  }, async (request, reply) => {
    const { branchId, userId, userName } = await getLoggedUser(request);
    if (!branchId) return (reply as any).code(403).send({ error: "User not associated with a branch" });

    const data = request.body as any;
    const name = String(data.name || "").trim();
    if (!name) return reply.code(400).send({ error: "Name is required" });

    const normalizedNew = normalizeForCompare(name);

    const activeItems = await prisma.modalidade.findMany({
      where: {
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
      const created = await prisma.modalidade.create({
        data: {
          branchId,
          name,
          description: data.description || null,
          isActive: true,
          createdByUserId: userId,
          createdByName: userName,
          updatedByUserId: userId,
          updatedByName: userName,
        },
      });

      await createAuditLog({
        branchId,
        modalidadeId: created.id,
        action: "CREATE",
        performedByUserId: userId,
        performedByName: userName,
        details: `Modalidade "${created.name}" criada`,
      });

      return reply.code(201).send(created);
    } catch (err: any) {
      request.log.error({ err }, "Failed to create modalidade");
      return reply.code(400).send({ error: "Failed to create modalidade", details: err.message });
    }
  });

  app.put("/:id", {
    schema: {
      summary: "Update modalidade",
      tags: ["Modalidades"],
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

    const existing = await prisma.modalidade.findUnique({ where: { id } });
    if (!existing) return reply.code(404).send({ error: "Modalidade not found" });
    if (!canAccessModalidade(existing.branchId, branchId)) return reply.code(404).send({ error: "Modalidade not found" });

    const nextName = data.name !== undefined ? String(data.name || "").trim() : existing.name;
    if (!nextName) return reply.code(400).send({ error: "Name is required" });

    if (data.name !== undefined) {
      const normalizedNew = normalizeForCompare(nextName);
      const activeItems = await prisma.modalidade.findMany({
        where: {
          id: { not: id },
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

    const updateData: any = { updatedByUserId: userId, updatedByName: userName };
    if (data.name !== undefined) updateData.name = nextName;
    if (data.description !== undefined) updateData.description = data.description || null;
    if (data.isActive !== undefined) updateData.isActive = data.isActive;

    const changeDescriptions: string[] = [];
    if (data.name !== undefined && data.name !== existing.name) {
      changeDescriptions.push(`nome: "${existing.name}" -> "${nextName}"`);
    }
    if (data.isActive !== undefined && data.isActive !== existing.isActive) {
      changeDescriptions.push(`ativo: ${existing.isActive} -> ${data.isActive}`);
    }

    try {
      const updated = await prisma.modalidade.update({
        where: { id },
        data: updateData,
      });

      await createAuditLog({
        branchId,
        modalidadeId: id,
        action: "UPDATE",
        performedByUserId: userId,
        performedByName: userName,
        details: changeDescriptions.length > 0 ? changeDescriptions.join("; ") : "Nenhuma alteração relevante",
      });

      return updated;
    } catch (err: any) {
      request.log.error({ err }, "Failed to update modalidade");
      return reply.code(400).send({ error: "Failed to update modalidade", details: err.message });
    }
  });

  app.delete("/:id", {
    schema: {
      summary: "Delete (deactivate) modalidade",
      tags: ["Modalidades"],
      params: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    },
  }, async (request, reply) => {
    const { branchId, userId, userName } = await getLoggedUser(request);
    if (!branchId) return (reply as any).code(403).send({ error: "User not associated with a branch" });

    const { id } = request.params as any;
    const existing = await prisma.modalidade.findUnique({ where: { id } });
    if (!existing) return reply.code(404).send({ error: "Modalidade not found" });
    if (!canAccessModalidade(existing.branchId, branchId)) return reply.code(404).send({ error: "Modalidade not found" });

    await prisma.modalidade.update({
      where: { id },
      data: { isActive: false, updatedByUserId: userId, updatedByName: userName },
    });

    await createAuditLog({
      branchId,
      modalidadeId: id,
      action: "DELETE",
      performedByUserId: userId,
      performedByName: userName,
      details: `Modalidade "${existing.name}" excluída`,
    });

    return { message: "Deleted" };
  });
}
