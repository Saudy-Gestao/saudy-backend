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

const normalizeProcedureMaterials = (data: any) => {
  if (!Array.isArray(data?.procedureMaterials)) return null;

  return data.procedureMaterials
    .map((material: any) => {
      const inventoryItemId = String(material?.inventoryItemId || '').trim();
      const quantity = Number(material?.quantity);
      if (!inventoryItemId || !Number.isFinite(quantity) || quantity <= 0) return null;
      return {
        inventoryItemId,
        quantity: Math.floor(quantity),
      };
    })
    .filter(Boolean) as { inventoryItemId: string; quantity: number }[];
};

export default async function procedureRoutes(app: FastifyInstance) {
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
  }, async (request, reply) => {
    const branchId = await getLoggedBranchId(request);
    if (!branchId) return (reply as any).code(403).send({ error: "User not associated with a branch" });

    const { search, acceptsInsurance, doctorId, limit = 50, offset = 0 } = request.query as any;

    const where: any = { isActive: true, branchId };
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
        include: { doctors: true, materials: { include: { inventoryItem: true } } },
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
    const branchId = await getLoggedBranchId(request);
    if (!branchId) return (reply as any).code(403).send({ error: "User not associated with a branch" });

    const { id } = request.params as any;
    const item = await prisma.procedure.findFirst({
      where: { id, branchId },
      include: { doctors: true, materials: { include: { inventoryItem: true } } },
    });
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
          procedureMaterials: {
            type: "array",
            items: {
              type: "object",
              properties: {
                inventoryItemId: { type: "string" },
                quantity: { type: "number" },
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
    const branchId = await getLoggedBranchId(request);
    if (!branchId) return (reply as any).code(403).send({ error: "User not associated with a branch" });

    const data = request.body as any;
    const doctorLinks = normalizeDoctorLinks(data) || [];
    const procedureMaterials = normalizeProcedureMaterials(data) || [];
    const acceptedInsurances = normalizeStringArray(data.acceptedInsurances) || [];
    const modalities = normalizeStringArray(data.modalities) || [];
    const acceptsInsurance = Boolean(data.acceptsInsurance);

    try {
      const item = await prisma.procedure.create({
        data: {
          branchId,
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
          materials: procedureMaterials.length
            ? {
                createMany: {
                  data: procedureMaterials,
                  skipDuplicates: true,
                },
              }
            : undefined,
        },
        include: { doctors: true, materials: { include: { inventoryItem: true } } },
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
    const branchId = await getLoggedBranchId(request);
    if (!branchId) return (reply as any).code(403).send({ error: "User not associated with a branch" });

    const { id } = request.params as any;
    const data = request.body as any;
    const doctorLinks = normalizeDoctorLinks(data);
    const procedureMaterials = normalizeProcedureMaterials(data);

    try {
      const existing = await prisma.procedure.findFirst({ where: { id, branchId } });
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
        prisma.procedure.update({ where: { id }, data: { ...updateData, branchId } }),
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

      if (procedureMaterials !== null) {
        actions.push(prisma.procedureMaterial.deleteMany({ where: { procedureId: id } }));
        if (procedureMaterials.length) {
          actions.push(
            prisma.procedureMaterial.createMany({
              data: procedureMaterials.map((material) => ({
                procedureId: id,
                inventoryItemId: material.inventoryItemId,
                quantity: material.quantity,
              })),
              skipDuplicates: true,
            }),
          );
        }
      }

      await prisma.$transaction(actions);
      const item = await prisma.procedure.findFirst({
        where: { id, branchId },
        include: { doctors: true, materials: { include: { inventoryItem: true } } },
      });
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
    const branchId = await getLoggedBranchId(request);
    if (!branchId) return (reply as any).code(403).send({ error: "User not associated with a branch" });

    const { id } = request.params as any;
    const existing = await prisma.procedure.findFirst({ where: { id, branchId } });
    if (!existing) return reply.code(404).send({ error: "Procedure not found" });
    await prisma.procedure.delete({ where: { id } });
    return { message: "Deleted" };
  });
}
