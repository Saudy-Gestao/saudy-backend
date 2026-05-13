export const DEFAULT_SECTOR_TEMPLATES = [
  { name: 'Recepção', description: 'Atendimento e recepção de pacientes' },
  { name: 'Médicos', description: 'Consultórios e atendimento médico' },
  { name: 'Enfermagem', description: 'Triagem e cuidados de enfermagem' },
  { name: 'Financeiro', description: 'Gestão financeira e faturamento' },
  { name: 'Administrativo', description: 'Gestão administrativa e back-office' },
  { name: 'Exames', description: 'Execução e laudo de exames' },
];

export async function createDefaultSectorsForBranch(branchId: string, tx: any): Promise<void> {
  const existing = await tx.sector.findMany({
    where: { branchId },
    select: { name: true },
  });

  const existingNames = new Set(existing.map((s: { name: string }) => s.name.toLowerCase()));

  const toCreate = DEFAULT_SECTOR_TEMPLATES.filter(
    (t) => !existingNames.has(t.name.toLowerCase()),
  );

  for (const template of toCreate) {
    await tx.sector.create({
      data: {
        branchId,
        name: template.name,
        description: template.description,
        workingDays: [],
      },
    });
  }
}
