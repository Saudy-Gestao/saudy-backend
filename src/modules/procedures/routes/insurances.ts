import { FastifyInstance } from "fastify";
import prisma from "../lib/prisma";

export default async function insuranceRoutes(app: FastifyInstance) {
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
  }, async (request) => {
    const { search, isActive, limit = 50, offset = 0 } = request.query as any;

    const where: any = {};
    if (isActive !== undefined) where.isActive = isActive;
    if (search) {
      where.OR = [
        { name: { contains: search, mode: "insensitive" } },
        { code: { contains: search, mode: "insensitive" } },
        { description: { contains: search, mode: "insensitive" } },
      ];
    }

    const [items, total] = await Promise.all([
      prisma.insurance.findMany({
        where,
        take: limit,
        skip: offset,
        orderBy: { createdAt: "desc" },
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
    const { id } = request.params as any;
    const item = await prisma.insurance.findUnique({ where: { id } });
    if (!item) return reply.code(404).send({ error: "Insurance not found" });
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
          isActive: { type: "boolean" },
        },
      },
      response: {
        201: { type: "object" },
        400: { type: "object", additionalProperties: true },
      },
    },
  }, async (request, reply) => {
    const data = request.body as any;
    try {
      const item = await prisma.insurance.create({
        data: {
          name: data.name,
          code: data.code || null,
          description: data.description || null,
          isActive: data.isActive ?? true,
        },
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
    const { id } = request.params as any;
    const data = request.body as any;

    try {
      const existing = await prisma.insurance.findUnique({ where: { id } });
      if (!existing) return reply.code(404).send({ error: "Insurance not found" });

      const updateData: any = {};
      if (data.name !== undefined) updateData.name = data.name;
      if (data.code !== undefined) updateData.code = data.code || null;
      if (data.description !== undefined) updateData.description = data.description || null;
      if (data.isActive !== undefined) updateData.isActive = data.isActive;

      const item = await prisma.insurance.update({ where: { id }, data: updateData });
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
    const { id } = request.params as any;
    await prisma.insurance.delete({ where: { id } });
    return { message: "Deleted" };
  });
}
