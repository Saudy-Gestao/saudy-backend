import { FastifyInstance } from "fastify";
import prisma from "../lib/prisma";

const normalizeStringArray = (value: unknown) => {
  if (!Array.isArray(value)) return undefined;
  return value
    .map((item) => String(item).trim())
    .filter((item) => item.length > 0);
};

const normalizeDoctorLinks = (data: any) => {
  if (Array.isArray(data?.doctors)) {
    return data.doctors
      .filter((doctor: any) => doctor && doctor.doctorId)
      .map((doctor: any) => ({
        doctorId: String(doctor.doctorId),
        doctorName: doctor.doctorName ? String(doctor.doctorName) : null,
      }));
  }

  if (Array.isArray(data?.doctorIds)) {
    return data.doctorIds
      .map((doctorId: any) => String(doctorId).trim())
      .filter((doctorId: string) => doctorId.length > 0)
      .map((doctorId: string) => ({ doctorId, doctorName: null }));
  }

  return null;
};

export default async function procedureRoutes(app: FastifyInstance) {
  app.get("/", {
    schema: {
      summary: "List procedures",
      tags: ["Procedures"],
      querystring: {
        type: "object",
        properties: {
          search: { type: "string" },
          acceptsInsurance: { type: "boolean" },
          doctorId: { type: "string" },
          limit: { type: "number", default: 50 },
          offset: { type: "number", default: 0 },
        },
      },
    },
  }, async (request) => {
    const { search, acceptsInsurance, doctorId, limit = 50, offset = 0 } = request.query as any;

    const where: any = { isActive: true };
    if (acceptsInsurance !== undefined) where.acceptsInsurance = acceptsInsurance;
    if (doctorId) where.doctors = { some: { doctorId } };
    if (search) {
      where.OR = [
        { name: { contains: search, mode: "insensitive" } },
        { description: { contains: search, mode: "insensitive" } },
      ];
    }

    const [items, total] = await Promise.all([
      prisma.procedure.findMany({
        where,
        take: limit,
        skip: offset,
        orderBy: { createdAt: "desc" },
        include: { doctors: true },
      }),
      prisma.procedure.count({ where }),
    ]);

    return { items, total };
  });

  app.get("/:id", {
    schema: {
      summary: "Get procedure by ID",
      tags: ["Procedures"],
      params: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    },
  }, async (request, reply) => {
    const { id } = request.params as any;
    const item = await prisma.procedure.findUnique({ where: { id }, include: { doctors: true } });
    if (!item) return reply.code(404).send({ error: "Procedure not found" });
    return item;
  });

  app.post("/", {
    schema: {
      summary: "Create procedure",
      tags: ["Procedures"],
      body: {
        type: "object",
        required: ["name"],
        properties: {
          name: { type: "string" },
          description: { type: "string" },
          price: { type: ["number", "string"] },
          durationMinutes: { type: "number" },
          acceptsInsurance: { type: "boolean" },
          acceptedInsurances: { type: "array", items: { type: "string" } },
          modalities: { type: "array", items: { type: "string" } },
          doctorIds: { type: "array", items: { type: "string" } },
          doctors: {
            type: "array",
            items: {
              type: "object",
              properties: {
                doctorId: { type: "string" },
                doctorName: { type: "string" },
              },
            },
          },
        },
      },
      response: {
        201: { type: "object" },
        400: { type: "object", additionalProperties: true },
      },
    },
  }, async (request, reply) => {
    const data = request.body as any;
    const doctorLinks = normalizeDoctorLinks(data) || [];
    const acceptedInsurances = normalizeStringArray(data.acceptedInsurances) || [];
    const modalities = normalizeStringArray(data.modalities) || [];
    const acceptsInsurance = Boolean(data.acceptsInsurance);

    try {
      const item = await prisma.procedure.create({
        data: {
          name: data.name,
          description: data.description || null,
          price: data.price ?? null,
          durationMinutes: data.durationMinutes !== undefined && data.durationMinutes !== null
            ? Number(data.durationMinutes)
            : null,
          acceptsInsurance,
          acceptedInsurances: acceptsInsurance ? acceptedInsurances : [],
          modalities,
          doctors: doctorLinks.length
            ? {
                createMany: {
                  data: doctorLinks.map((doctor: { doctorId: any; doctorName: any; }) => ({
                    doctorId: doctor.doctorId,
                    doctorName: doctor.doctorName,
                  })),
                  skipDuplicates: true,
                },
              }
            : undefined,
        },
        include: { doctors: true },
      });

      return reply.code(201).send(item);
    } catch (err: any) {
      request.log.error({ err }, "Failed to create procedure");
      return reply.code(400).send({ error: "Failed to create procedure", details: err.message });
    }
  });

  app.put("/:id", {
    schema: {
      summary: "Update procedure",
      tags: ["Procedures"],
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
    const doctorLinks = normalizeDoctorLinks(data);

    try {
      const existing = await prisma.procedure.findUnique({ where: { id } });
      if (!existing) return reply.code(404).send({ error: "Procedure not found" });

      const updateData: any = {};
      if (data.name !== undefined) updateData.name = data.name;
      if (data.description !== undefined) updateData.description = data.description || null;
      if (data.price !== undefined) updateData.price = data.price;
      if (data.durationMinutes !== undefined) {
        updateData.durationMinutes = data.durationMinutes === null || data.durationMinutes === ''
          ? null
          : Number(data.durationMinutes);
      }
      if (data.acceptsInsurance !== undefined) updateData.acceptsInsurance = Boolean(data.acceptsInsurance);

      const acceptedInsurances = normalizeStringArray(data.acceptedInsurances);
      const modalities = normalizeStringArray(data.modalities);

      if (modalities !== undefined) updateData.modalities = modalities;
      if (acceptedInsurances !== undefined) updateData.acceptedInsurances = acceptedInsurances;
      if (data.acceptsInsurance === false) updateData.acceptedInsurances = [];

      const actions: any[] = [
        prisma.procedure.update({ where: { id }, data: updateData }),
      ];

      if (doctorLinks !== null) {
        actions.push(prisma.procedureDoctor.deleteMany({ where: { procedureId: id } }));
        if (doctorLinks.length) {
          actions.push(
            prisma.procedureDoctor.createMany({
              data: doctorLinks.map((doctor: { doctorId: any; doctorName: any; }) => ({
                procedureId: id,
                doctorId: doctor.doctorId,
                doctorName: doctor.doctorName,
              })),
              skipDuplicates: true,
            }),
          );
        }
      }

      await prisma.$transaction(actions);
      const item = await prisma.procedure.findUnique({ where: { id }, include: { doctors: true } });
      return item;
    } catch (err: any) {
      request.log.error({ err }, "Failed to update procedure");
      return reply.code(400).send({ error: "Failed to update procedure", details: err.message });
    }
  });

  app.delete("/:id", {
    schema: {
      summary: "Delete procedure",
      tags: ["Procedures"],
      params: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    },
  }, async (request, reply) => {
    const { id } = request.params as any;
    await prisma.procedure.delete({ where: { id } });
    return { message: "Deleted" };
  });
}
