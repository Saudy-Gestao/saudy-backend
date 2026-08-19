import { FastifyInstance } from "fastify";
import prisma from "../lib/prisma";

export default async function cboRoutes(app: FastifyInstance) {
  app.addHook("onRequest", async (request, reply) => {
    try {
      await request.jwtVerify();
    } catch (err) {
      return reply.code(401).send({ error: "Unauthorized" });
    }
  });

  app.get("/", {
    schema: {
      summary: "List CBO catalog (área da saúde)",
      tags: ["Cbo"],
      querystring: {
        type: "object",
        properties: {
          search: { type: "string" },
          limit: { type: "number", default: 500 },
          offset: { type: "number", default: 0 },
        },
      },
    },
  }, async (request) => {
    const { search, limit = 500, offset = 0 } = request.query as any;

    const where: any = { isActive: true };
    if (search) {
      where.OR = [
        { title: { contains: search, mode: "insensitive" } },
        { code: { contains: search, mode: "insensitive" } },
      ];
    }

    const [items, total] = await Promise.all([
      prisma.cbo.findMany({
        where,
        take: limit,
        skip: offset,
        orderBy: { title: "asc" },
      }),
      prisma.cbo.count({ where }),
    ]);

    return { items, total };
  });
}
