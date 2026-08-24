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
        durationMinutes: Number.isFinite(Number(doctor.durationMinutes)) && Number(doctor.durationMinutes) > 0
          ? Math.round(Number(doctor.durationMinutes))
          : null,
      }));
  }

  if (Array.isArray(data?.doctorIds)) {
    return data.doctorIds
      .map((doctorId: any) => String(doctorId).trim())
      .filter((doctorId: string) => doctorId.length > 0)
      .map((doctorId: string) => ({ doctorId, doctorName: null, durationMinutes: null }));
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

const normalizeProcedureMaterialKits = (data: any) => {
  if (!Array.isArray(data?.procedureMaterialKits)) return null;

  return data.procedureMaterialKits
    .map((kit: any, index: number) => {
      const name = String(kit?.name || '').trim() || `Kit ${index + 1}`;
      const insuranceName = String(kit?.insuranceName || '').trim() || null;
      const isDefault = Boolean(kit?.isDefault) || !insuranceName;
      const isActive = kit?.isActive === undefined ? true : Boolean(kit.isActive);
      const items = Array.isArray(kit?.items)
        ? kit.items
          .map((item: any) => {
            const inventoryItemId = String(item?.inventoryItemId || '').trim();
            const quantity = Number(item?.quantity);
            if (!inventoryItemId || !Number.isFinite(quantity) || quantity <= 0) return null;
            return {
              inventoryItemId,
              quantity: Math.floor(quantity),
            };
          })
          .filter(Boolean)
        : [];

      if (items.length === 0) return null;

      return {
        name,
        insuranceName,
        isDefault,
        isActive,
        items,
      };
    })
    .filter(Boolean) as Array<{
      name: string;
      insuranceName: string | null;
      isDefault: boolean;
      isActive: boolean;
      items: Array<{ inventoryItemId: string; quantity: number }>;
    }>;
};

const normalizeProcedureKitBindings = (data: any) => {
  if (!Array.isArray(data?.procedureKitBindings)) return null;
  return data.procedureKitBindings
    .map((binding: any) => {
      const inventoryKitId = String(binding?.inventoryKitId || '').trim();
      const insuranceName = String(binding?.insuranceName || '').trim() || null;
      const isActive = binding?.isActive === undefined ? true : Boolean(binding.isActive);
      if (!inventoryKitId) return null;
      return { inventoryKitId, insuranceName, isActive };
    })
    .filter(Boolean) as Array<{ inventoryKitId: string; insuranceName: string | null; isActive: boolean }>;
};

const normalizeProcedureAppointmentType = (value: unknown): string => {
  const normalized = String(value || '').trim().toUpperCase();
  return normalized === 'EXAME' ? 'EXAME' : 'CONSULTA';
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
          isActive: { type: "boolean" },
          doctorId: { type: "string" },
          limit: { type: "number", default: 50 },
          offset: { type: "number", default: 0 },
        },
      },
    },
  }, async (request, reply) => {
    const branchId = await getLoggedBranchId(request);
    if (!branchId) return (reply as any).code(403).send({ error: "User not associated with a branch" });

    const { search, isActive, doctorId, limit = 50, offset = 0 } = request.query as any;

    const where: any = { branchId };
    if (isActive !== undefined) where.isActive = isActive;
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
        include: {
          modalidade: { select: { id: true, name: true } },
          doctors: true,
          materials: { include: { inventoryItem: true } },
          kitBindings: {
            where: { isActive: true },
            include: {
              inventoryKit: {
                include: {
                  items: { include: { inventoryItem: true } },
                },
              },
            },
          },
          materialKits: {
            where: { isActive: true },
            include: {
              items: { include: { inventoryItem: true } },
            },
            orderBy: [
              { insuranceName: 'asc' },
              { name: 'asc' },
            ],
          },
        },
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
      include: {
        modalidade: { select: { id: true, name: true } },
        doctors: true,
        materials: { include: { inventoryItem: true } },
        kitBindings: {
          where: { isActive: true },
          include: {
            inventoryKit: {
              include: {
                items: { include: { inventoryItem: true } },
              },
            },
          },
        },
        materialKits: {
          where: { isActive: true },
          include: {
            items: { include: { inventoryItem: true } },
          },
          orderBy: [
            { insuranceName: 'asc' },
            { name: 'asc' },
          ],
        },
      },
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
          appointmentType: { type: "string", enum: ["CONSULTA", "EXAME"] },
          price: { type: ["number", "string"] },
          durationMinutes: { type: "number" },
          modalities: { type: "array", items: { type: "string" } },
          modalidadeId: { type: "string" },
          branchIds: { type: "array", items: { type: "string" } },
          doctorIds: { type: "array", items: { type: "string" } },
          doctors: {
            type: "array",
            items: {
              type: "object",
              properties: {
                doctorId: { type: "string" },
                doctorName: { type: "string" },
                durationMinutes: { type: "number", nullable: true },
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
          procedureMaterialKits: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                insuranceName: { type: "string" },
                isDefault: { type: "boolean" },
                isActive: { type: "boolean" },
                items: {
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
          },
          procedureKitBindings: {
            type: "array",
            items: {
              type: "object",
              properties: {
                inventoryKitId: { type: "string" },
                insuranceName: { type: "string" },
                isActive: { type: "boolean" },
              },
            },
          },
        },
      },
      response: {
        201: { type: "object", additionalProperties: true },
        400: { type: "object", additionalProperties: true },
      },
    },
  }, async (request, reply) => {
    const branchId = await getLoggedBranchId(request);
    if (!branchId) return (reply as any).code(403).send({ error: "User not associated with a branch" });

    const data = request.body as any;
    const doctorLinks = normalizeDoctorLinks(data) || [];
    const procedureMaterials = normalizeProcedureMaterials(data) || [];
    const procedureMaterialKits = normalizeProcedureMaterialKits(data) || [];
    const procedureKitBindings = normalizeProcedureKitBindings(data) || [];
    const modalities = normalizeStringArray(data.modalities) || [];
    const branchIds = normalizeStringArray(data.branchIds) || [];
    const appointmentType = normalizeProcedureAppointmentType(data.appointmentType);

    try {
      const item = await prisma.procedure.create({
        data: {
          branchId,
          name: data.name,
          description: data.description || null,
          appointmentType,
          price: data.price ?? null,
          durationMinutes: data.durationMinutes !== undefined && data.durationMinutes !== null
            ? Number(data.durationMinutes)
            : null,
          modalidadeId: data.modalidadeId || null,
          branchIds,
          modalities,
          doctors: doctorLinks.length
            ? {
                createMany: {
                  data: doctorLinks.map((doctor: { doctorId: any; doctorName: any; durationMinutes?: number | null }) => ({
                  doctorId: doctor.doctorId,
                  doctorName: doctor.doctorName,
                  durationMinutes: doctor.durationMinutes,
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
          materialKits: procedureMaterialKits.length
            ? {
                create: procedureMaterialKits.map((kit) => ({
                  name: kit.name,
                  insuranceName: kit.insuranceName,
                  isDefault: kit.isDefault,
                  isActive: kit.isActive,
                  items: {
                    createMany: {
                      data: kit.items,
                      skipDuplicates: true,
                    },
                  },
                })),
              }
            : undefined,
          kitBindings: procedureKitBindings.length
            ? {
                createMany: {
                  data: procedureKitBindings,
                  skipDuplicates: true,
                },
              }
            : undefined,
        },
        include: {
          modalidade: { select: { id: true, name: true } },
          doctors: true,
          materials: { include: { inventoryItem: true } },
          kitBindings: {
            where: { isActive: true },
            include: {
              inventoryKit: {
                include: {
                  items: { include: { inventoryItem: true } },
                },
              },
            },
          },
          materialKits: {
            where: { isActive: true },
            include: {
              items: { include: { inventoryItem: true } },
            },
            orderBy: [
              { insuranceName: 'asc' },
              { name: 'asc' },
            ],
          },
        },
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
        200: { type: "object", additionalProperties: true },
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
    const procedureMaterialKits = normalizeProcedureMaterialKits(data);
    const procedureKitBindings = normalizeProcedureKitBindings(data);

    try {
      const existing = await prisma.procedure.findFirst({ where: { id, branchId } });
      if (!existing) return reply.code(404).send({ error: "Procedure not found" });

      const updateData: any = {};
      if (data.name !== undefined) updateData.name = data.name;
      if (data.description !== undefined) updateData.description = data.description || null;
      if (data.appointmentType !== undefined) {
        updateData.appointmentType = normalizeProcedureAppointmentType(data.appointmentType);
      }
      if (data.price !== undefined) updateData.price = data.price;
      if (data.durationMinutes !== undefined) {
        updateData.durationMinutes = data.durationMinutes === null || data.durationMinutes === ''
          ? null
          : Number(data.durationMinutes);
      }
      if (data.modalidadeId !== undefined) updateData.modalidadeId = data.modalidadeId || null;
      if (data.isActive !== undefined) updateData.isActive = Boolean(data.isActive);

      const modalities = normalizeStringArray(data.modalities);
      if (modalities !== undefined) updateData.modalities = modalities;

      const branchIds = normalizeStringArray(data.branchIds);
      if (branchIds !== undefined) updateData.branchIds = branchIds;

      const actions: any[] = [
        prisma.procedure.update({ where: { id }, data: { ...updateData, branchId } }),
      ];

      if (doctorLinks !== null) {
        const existingDoctorLinks = await prisma.procedureDoctor.findMany({
          where: { procedureId: id },
          select: { doctorId: true, durationMinutes: true, branchIds: true },
        });
        const existingDurationByDoctorId = new Map(
          existingDoctorLinks.map((link: { doctorId: string; durationMinutes: number | null }) => [link.doctorId, link.durationMinutes]),
        );
        const existingBranchIdsByDoctorId = new Map(
          existingDoctorLinks.map((link: { doctorId: string; branchIds: string[] }) => [link.doctorId, link.branchIds]),
        );
        actions.push(prisma.procedureDoctor.deleteMany({ where: { procedureId: id } }));
        if (doctorLinks.length) {
          actions.push(
            prisma.procedureDoctor.createMany({
              data: doctorLinks.map((doctor: { doctorId: any; doctorName: any; durationMinutes?: number | null }) => ({
                procedureId: id,
                doctorId: doctor.doctorId,
                doctorName: doctor.doctorName,
                durationMinutes: doctor.durationMinutes ?? existingDurationByDoctorId.get(doctor.doctorId) ?? null,
                branchIds: existingBranchIdsByDoctorId.get(doctor.doctorId) ?? [],
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

      if (procedureMaterialKits !== null) {
        actions.push(prisma.procedureMaterialKit.deleteMany({ where: { procedureId: id } }));
        if (procedureMaterialKits.length) {
          actions.push(
            prisma.procedureMaterialKit.createMany({
              data: procedureMaterialKits.map((kit) => ({
                procedureId: id,
                name: kit.name,
                insuranceName: kit.insuranceName,
                isDefault: kit.isDefault,
                isActive: kit.isActive,
              })),
              skipDuplicates: false,
            }),
          );
        }
      }

      if (procedureKitBindings !== null) {
        actions.push(prisma.procedureKitBinding.deleteMany({ where: { procedureId: id } }));
        if (procedureKitBindings.length) {
          actions.push(
            prisma.procedureKitBinding.createMany({
              data: procedureKitBindings.map((binding) => ({
                procedureId: id,
                inventoryKitId: binding.inventoryKitId,
                insuranceName: binding.insuranceName,
                isActive: binding.isActive,
              })),
              skipDuplicates: true,
            }),
          );
        }
      }

      await prisma.$transaction(actions);

      if (procedureMaterialKits !== null && procedureMaterialKits.length) {
        const createdKits = await prisma.procedureMaterialKit.findMany({
          where: { procedureId: id },
          orderBy: { createdAt: 'asc' },
        });

        for (const createdKit of createdKits) {
          const matched = procedureMaterialKits.find((kit) => (
            kit.name === createdKit.name
            && (kit.insuranceName || null) === (createdKit.insuranceName || null)
          ));
          if (!matched?.items?.length) continue;
          await prisma.procedureMaterialKitItem.createMany({
            data: matched.items.map((item) => ({
              kitId: createdKit.id,
              inventoryItemId: item.inventoryItemId,
              quantity: item.quantity,
            })),
            skipDuplicates: true,
          });
        }
      }

      const item = await prisma.procedure.findFirst({
        where: { id, branchId },
        include: {
          modalidade: { select: { id: true, name: true } },
          doctors: true,
          materials: { include: { inventoryItem: true } },
          kitBindings: {
            where: { isActive: true },
            include: {
              inventoryKit: {
                include: {
                  items: { include: { inventoryItem: true } },
                },
              },
            },
          },
          materialKits: {
            where: { isActive: true },
            include: {
              items: { include: { inventoryItem: true } },
            },
            orderBy: [
              { insuranceName: 'asc' },
              { name: 'asc' },
            ],
          },
        },
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
