const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

function iso(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

async function main() {
  const todayIso = iso(new Date());
  const rows = await prisma.teaPreReservation.findMany({
    where: {
      status: 'CONVERTED',
      pit: { status: 'Inativo' },
      suggestedDate: { gte: new Date(`${todayIso}T00:00:00`) },
    },
    select: {
      patientId: true,
      suggestedDate: true,
      suggestedTime: true,
      professionalName: true,
    },
  });

  let updatedTotal = 0;

  for (const row of rows) {
    if (!row || !row.suggestedDate || !row.suggestedTime) continue;
    const dateIso = iso(new Date(row.suggestedDate));
    const conflictClauses = [{ patientId: row.patientId }];
    if (row.professionalName) {
      conflictClauses.push({ doctorName: row.professionalName });
    }

    const updated = await prisma.appointment.updateMany({
      where: {
        isActive: true,
        date: dateIso,
        time: row.suggestedTime,
        type: 'RETORNO TEA',
        OR: conflictClauses,
        NOT: [
          { status: 'CANCELED' },
          { status: 'CANCELADO' },
          { status: 'COMPLETED' },
          { status: 'CONCLUIDO' },
        ],
      },
      data: {
        status: 'CANCELED',
        isActive: false,
      },
    });

    updatedTotal += Number(updated.count || 0);
  }

  console.log(JSON.stringify({ scannedReservations: rows.length, canceledAppointments: updatedTotal }));
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
