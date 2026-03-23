import prisma from '../../lib/prisma';

export interface MwlQuery {
  accessionNumber?: string;
  patientId?: string;
  patientName?: string;
  studyInstanceUid?: string;
  scheduledStationAeTitle?: string;
  modality?: string;
}

export class MwlScp {
  constructor() {
    // Stub service for now.
  }

  public start() {
    console.log('MWL stub service started (DICOM SCP not implemented).');
  }

  public stop() {
    console.log('MWL stub service stopped.');
  }

  public async queryMwlEntries(query: MwlQuery) {
    const where: any = {
      isActive: true,
      status: { not: 'cancelado' },
    };

    if (query.accessionNumber) {
      where.accessionNumber = query.accessionNumber;
    }
    if (query.patientId) {
      where.patientCpf = query.patientId;
    }
    if (query.patientName) {
      where.patientName = { contains: query.patientName, mode: 'insensitive' };
    }
    if (query.modality) {
      where.examType = { contains: query.modality, mode: 'insensitive' };
    }

    return prisma.mwlEntry.findMany({
      where,
      include: {
        appointment: {
          select: {
            patientName: true,
            patientCpf: true,
            doctorName: true,
            date: true,
            time: true,
            specialty: true,
            convenio: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }
}
