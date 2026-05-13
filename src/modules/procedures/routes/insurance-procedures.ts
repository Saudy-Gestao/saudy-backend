import { FastifyInstance } from "fastify";
import prisma from "../lib/prisma";

export default async function insuranceProcedureRoutes(app: FastifyInstance) {
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

  // List procedures linked to an insurance
  app.get("/:insuranceId/procedures", {
    schema: {
      summary: "List procedures for an insurance",
      tags: ["Insurances"],
      params: { type: "object", properties: { insuranceId: { type: "string" } }, required: ["insuranceId"] },
      querystring: {
        type: "object",
        properties: {
          subInsuranceId: { type: "string" },
          isActive: { type: "boolean" },
          search: { type: "string" },
        },
      },
    },
  }, async (request, reply) => {
    const branchId = await getLoggedBranchId(request);
    if (!branchId) return (reply as any).code(403).send({ error: "User not associated with a branch" });

    const { insuranceId } = request.params as any;
    const { subInsuranceId, isActive, search } = request.query as any;

    const where: any = { insuranceId };
    if (subInsuranceId !== undefined) where.subInsuranceId = subInsuranceId || null;
    if (isActive !== undefined) where.isActive = isActive;
    if (search) {
      where.procedure = { name: { contains: search, mode: "insensitive" } };
    }

    const items = await prisma.insuranceProcedure.findMany({
      where,
      orderBy: { procedure: { name: "asc" } },
      include: {
        procedure: {
          select: { id: true, name: true, tussCode: true, tussTableCode: true, appointmentType: true },
        },
        subInsurance: { select: { id: true, name: true } },
      },
    });

    return items;
  });

  // Add a procedure to an insurance
  app.post("/:insuranceId/procedures", {
    schema: {
      summary: "Add procedure to insurance",
      tags: ["Insurances"],
      params: { type: "object", properties: { insuranceId: { type: "string" } }, required: ["insuranceId"] },
      body: {
        type: "object",
        required: ["procedureId"],
        properties: {
          procedureId: { type: "string" },
          subInsuranceId: { type: "string" },
          price: { type: ["number", "string", "null"] },
          isActive: { type: "boolean" },
        },
      },
      response: {
        201: { type: "object" },
        400: { type: "object", additionalProperties: true },
        409: { type: "object", additionalProperties: true },
      },
    },
  }, async (request, reply) => {
    const branchId = await getLoggedBranchId(request);
    if (!branchId) return (reply as any).code(403).send({ error: "User not associated with a branch" });

    const { insuranceId } = request.params as any;
    const data = request.body as any;

    try {
      const item = await prisma.insuranceProcedure.create({
        data: {
          insuranceId,
          procedureId: data.procedureId,
          subInsuranceId: data.subInsuranceId || null,
          price: data.price != null ? data.price : null,
          isActive: data.isActive ?? true,
        },
        include: {
          procedure: {
            select: { id: true, name: true, tussCode: true, tussTableCode: true, appointmentType: true },
          },
          subInsurance: { select: { id: true, name: true } },
        },
      });
      return reply.code(201).send(item);
    } catch (err: any) {
      if (err.code === "P2002") {
        return reply.code(409).send({ error: "Este procedimento já está vinculado a este convênio/sub-convênio" });
      }
      request.log.error({ err }, "Failed to add procedure to insurance");
      return reply.code(400).send({ error: "Failed to add procedure to insurance", details: err.message });
    }
  });

  // Update price/status of an insurance procedure link
  app.put("/:insuranceId/procedures/:id", {
    schema: {
      summary: "Update insurance procedure link",
      tags: ["Insurances"],
      params: {
        type: "object",
        properties: { insuranceId: { type: "string" }, id: { type: "string" } },
        required: ["insuranceId", "id"],
      },
      body: { type: "object" },
      response: {
        200: { type: "object" },
        404: { type: "object", additionalProperties: true },
      },
    },
  }, async (request, reply) => {
    const branchId = await getLoggedBranchId(request);
    if (!branchId) return (reply as any).code(403).send({ error: "User not associated with a branch" });

    const { insuranceId, id } = request.params as any;
    const data = request.body as any;

    const existing = await prisma.insuranceProcedure.findFirst({ where: { id, insuranceId } });
    if (!existing) return reply.code(404).send({ error: "Insurance procedure not found" });

    const updateData: any = {};
    if (data.price !== undefined) updateData.price = data.price != null ? data.price : null;
    if (data.isActive !== undefined) updateData.isActive = Boolean(data.isActive);
    if (data.subInsuranceId !== undefined) updateData.subInsuranceId = data.subInsuranceId || null;

    const item = await prisma.insuranceProcedure.update({
      where: { id },
      data: updateData,
      include: {
        procedure: {
          select: { id: true, name: true, tussCode: true, tussTableCode: true, appointmentType: true },
        },
        subInsurance: { select: { id: true, name: true } },
      },
    });
    return item;
  });

  // Remove a procedure from an insurance
  app.delete("/:insuranceId/procedures/:id", {
    schema: {
      summary: "Remove procedure from insurance",
      tags: ["Insurances"],
      params: {
        type: "object",
        properties: { insuranceId: { type: "string" }, id: { type: "string" } },
        required: ["insuranceId", "id"],
      },
    },
  }, async (request, reply) => {
    const branchId = await getLoggedBranchId(request);
    if (!branchId) return (reply as any).code(403).send({ error: "User not associated with a branch" });

    const { insuranceId, id } = request.params as any;
    const existing = await prisma.insuranceProcedure.findFirst({ where: { id, insuranceId } });
    if (!existing) return reply.code(404).send({ error: "Insurance procedure not found" });

    await prisma.insuranceProcedure.delete({ where: { id } });
    return { message: "Deleted" };
  });
}
