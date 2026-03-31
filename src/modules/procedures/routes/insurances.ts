import { FastifyInstance } from "fastify";
import prisma from "../lib/prisma";

export default async function insuranceRoutes(app: FastifyInstance) {
  const normalizeBranchId = (value: string | null | undefined) => (value || "").trim();
  const normalizeSubInsurances = (value: unknown) => {
    if (!Array.isArray(value)) return undefined;
    return Array.from(
      new Set(
        value
          .map((item) => String(item || "").trim())
          .filter((item) => item.length > 0),
      ),
    );
  };
  const canAccessInsurance = (insuranceBranchId: string | null | undefined, loggedBranchId: string) => {
    const normalized = normalizeBranchId(insuranceBranchId);
    return normalized === "" || normalized === loggedBranchId;
  };

  const getLoggedBranchId = async (request: any) => {
    const userId = (request.user as any)?.id;
    if (!userId) return null;
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { sector: { include: { branch: true } } },
    });
    return user?.sector?.branch?.id || null;
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
      summary: "List insurances",
      tags: ["Insurances"],
      querystring: {
        type: "object",
        properties: {
          search: { type: "string" },
          isActive: { type: "boolean" },
          limit: { type: "number", default: 50 },
          offset: { type: "number", default: 0 },
        },
      },
    },
  }, async (request, reply) => {
    const branchId = await getLoggedBranchId(request);
    if (!branchId) return (reply as any).code(403).send({ error: "User not associated with a branch" });

    const { search, isActive, limit = 50, offset = 0 } = request.query as any;

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
          { code: { contains: search, mode: "insensitive" } },
          { description: { contains: search, mode: "insensitive" } },
        ],
      });
    }

    const [items, total] = await Promise.all([
      prisma.insurance.findMany({
        where,
        take: limit,
        skip: offset,
        orderBy: { createdAt: "desc" },
        include: {
          subInsurances: {
            where: { isActive: true },
            orderBy: { name: "asc" },
          },
        },
      }),
      prisma.insurance.count({ where }),
    ]);

    return { items, total };
  });

  app.get("/:id", {
    schema: {
      summary: "Get insurance by ID",
      tags: ["Insurances"],
      params: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    },
  }, async (request, reply) => {
    const branchId = await getLoggedBranchId(request);
    if (!branchId) return (reply as any).code(403).send({ error: "User not associated with a branch" });

    const { id } = request.params as any;
    const item = await prisma.insurance.findUnique({
      where: { id },
      include: {
        subInsurances: {
          where: { isActive: true },
          orderBy: { name: "asc" },
        },
      },
    });
    if (!item) return reply.code(404).send({ error: "Insurance not found" });
    if (!canAccessInsurance(item.branchId, branchId)) return reply.code(404).send({ error: "Insurance not found" });
    return item;
  });

  app.post("/", {
    schema: {
      summary: "Create insurance",
      tags: ["Insurances"],
      body: {
        type: "object",
        required: ["name"],
        properties: {
          name: { type: "string" },
          code: { type: "string" },
          description: { type: "string" },
          tissRegistroAns: { type: "string" },
          tissOperadoraCnpj: { type: "string" },
          tissVersao: { type: "string" },
          tissPrestadorCnpj: { type: "string" },
          tissPrestadorCnes: { type: "string" },
          tissCodigoPrestadorOperadora: { type: "string" },
          isActive: { type: "boolean" },
          subInsurances: { type: "array", items: { type: "string" } },
        },
      },
      response: {
        201: { type: "object" },
        400: { type: "object", additionalProperties: true },
      },
    },
  }, async (request, reply) => {
    const branchId = await getLoggedBranchId(request);
    if (!branchId) return (reply as any).code(403).send({ error: "User not associated with a branch" });

    const data = request.body as any;
    const subInsurances = normalizeSubInsurances(data.subInsurances) || [];
    try {
      const item = await prisma.$transaction(async (tx: any) => {
        const created = await tx.insurance.create({
          data: {
            branchId,
            name: data.name,
            code: data.code || null,
            description: data.description || null,
            tissRegistroAns: data.tissRegistroAns || null,
            tissOperadoraCnpj: data.tissOperadoraCnpj || null,
            tissVersao: data.tissVersao || null,
            tissPrestadorCnpj: data.tissPrestadorCnpj || null,
            tissPrestadorCnes: data.tissPrestadorCnes || null,
            tissCodigoPrestadorOperadora: data.tissCodigoPrestadorOperadora || null,
            isActive: data.isActive ?? true,
          },
        });

        if (subInsurances.length) {
          await tx.subInsurance.createMany({
            data: subInsurances.map((name) => ({
              branchId,
              insuranceId: created.id,
              name,
              isActive: true,
            })),
            skipDuplicates: true,
          });
        }

        return tx.insurance.findUnique({
          where: { id: created.id },
          include: {
            subInsurances: {
              where: { isActive: true },
              orderBy: { name: "asc" },
            },
          },
        });
      });

      return reply.code(201).send(item);
    } catch (err: any) {
      request.log.error({ err }, "Failed to create insurance");
      return reply.code(400).send({ error: "Failed to create insurance", details: err.message });
    }
  });

  app.put("/:id", {
    schema: {
      summary: "Update insurance",
      tags: ["Insurances"],
      params: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      body: { type: "object" },
      response: {
        200: { type: "object" },
        400: { type: "object", additionalProperties: true },
        404: { type: "object", additionalProperties: true },
      },
    },
  }, async (request, reply) => {
    const branchId = await getLoggedBranchId(request);
    if (!branchId) return (reply as any).code(403).send({ error: "User not associated with a branch" });

    const { id } = request.params as any;
    const data = request.body as any;
    const subInsurances = normalizeSubInsurances(data.subInsurances);

    try {
      const existing = await prisma.insurance.findUnique({ where: { id } });
      if (!existing) return reply.code(404).send({ error: "Insurance not found" });
      if (!canAccessInsurance(existing.branchId, branchId)) return reply.code(404).send({ error: "Insurance not found" });

      const updateData: any = {};
      if (data.name !== undefined) updateData.name = data.name;
      if (data.code !== undefined) updateData.code = data.code || null;
      if (data.description !== undefined) updateData.description = data.description || null;
      if (data.tissRegistroAns !== undefined) updateData.tissRegistroAns = data.tissRegistroAns || null;
      if (data.tissOperadoraCnpj !== undefined) updateData.tissOperadoraCnpj = data.tissOperadoraCnpj || null;
      if (data.tissVersao !== undefined) updateData.tissVersao = data.tissVersao || null;
      if (data.tissPrestadorCnpj !== undefined) updateData.tissPrestadorCnpj = data.tissPrestadorCnpj || null;
      if (data.tissPrestadorCnes !== undefined) updateData.tissPrestadorCnes = data.tissPrestadorCnes || null;
      if (data.tissCodigoPrestadorOperadora !== undefined) updateData.tissCodigoPrestadorOperadora = data.tissCodigoPrestadorOperadora || null;
      if (data.isActive !== undefined) updateData.isActive = data.isActive;

      const persistedBranchId = normalizeBranchId(existing.branchId) !== "" ? String(existing.branchId) : branchId;
      const item = await prisma.$transaction(async (tx: any) => {
        await tx.insurance.update({
          where: { id },
          data: { ...updateData, branchId: persistedBranchId },
        });

        if (subInsurances !== undefined) {
          await tx.subInsurance.deleteMany({ where: { insuranceId: id } });
          if (subInsurances.length) {
            await tx.subInsurance.createMany({
              data: subInsurances.map((name) => ({
                insuranceId: id,
                branchId: persistedBranchId,
                name,
                isActive: true,
              })),
              skipDuplicates: true,
            });
          }
        }

        return tx.insurance.findUnique({
          where: { id },
          include: {
            subInsurances: {
              where: { isActive: true },
              orderBy: { name: "asc" },
            },
          },
        });
      });
      return item;
    } catch (err: any) {
      request.log.error({ err }, "Failed to update insurance");
      return reply.code(400).send({ error: "Failed to update insurance", details: err.message });
    }
  });

  app.delete("/:id", {
    schema: {
      summary: "Delete insurance",
      tags: ["Insurances"],
      params: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    },
  }, async (request, reply) => {
    const branchId = await getLoggedBranchId(request);
    if (!branchId) return (reply as any).code(403).send({ error: "User not associated with a branch" });

    const { id } = request.params as any;
    const existing = await prisma.insurance.findUnique({ where: { id } });
    if (!existing) return reply.code(404).send({ error: "Insurance not found" });
    if (!canAccessInsurance(existing.branchId, branchId)) return reply.code(404).send({ error: "Insurance not found" });
    await prisma.insurance.delete({ where: { id } });
    return { message: "Deleted" };
  });
}
