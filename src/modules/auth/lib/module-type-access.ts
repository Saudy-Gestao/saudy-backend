import prisma from './prisma';

export type CompanyModuleType = 'padrao' | 'tea' | 'apenas-tea';

const TEA_MODULE_NAMES = new Set([
  'modulo-tea',
]);

const TEA_DEPENDENCY_MODULE_NAMES = new Set([
  'cadastro-paciente',
  'cadastro-procedimento',
  'cadastro-medico',
  'autorizacao-convenio',
]);

export const normalizeCompanyModuleType = (value: unknown): CompanyModuleType => {
  if (value === 'tea' || value === 'apenas-tea') return value;
  return 'padrao';
};

export const isModuleAllowedForCompanyType = (moduleName: string, moduleType: CompanyModuleType) => {
  if (moduleType === 'tea') return true;
  if (moduleType === 'apenas-tea') {
    return TEA_MODULE_NAMES.has(moduleName) || TEA_DEPENDENCY_MODULE_NAMES.has(moduleName);
  }
  return !TEA_MODULE_NAMES.has(moduleName);
};

export const filterModulesForCompanyType = <T extends { name?: string | null }>(
  modules: T[],
  moduleType: CompanyModuleType,
) => modules.filter((module) => isModuleAllowedForCompanyType(String(module?.name || ''), moduleType));

export const getRequestCompanyModuleType = async (requestUserId: string): Promise<CompanyModuleType | null> => {
  const loggedUser = await prisma.user.findUnique({
    where: { id: requestUserId },
    include: {
      sector: {
        include: {
          branch: {
            include: {
              company: {
                select: {
                  module_type: true,
                },
              },
            },
          },
        },
      },
    },
  });

  const moduleType = loggedUser?.sector?.branch?.company?.module_type;
  if (!moduleType) return null;
  return normalizeCompanyModuleType(moduleType);
};
