import prismaModule from '../../../lib/prisma';

const prisma: any = (prismaModule as any)?.default ?? prismaModule;

export default prisma;
