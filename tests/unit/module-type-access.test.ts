import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  filterModulesForCompanyType,
  getRequestCompanyModuleType,
  isModuleAllowedForCompanyType,
  normalizeCompanyModuleType,
} from '../../src/modules/auth/lib/module-type-access';
import prisma from '../../src/modules/auth/lib/prisma';

vi.mock('../../src/modules/auth/lib/prisma', () => ({
  default: {
    user: {
      findUnique: vi.fn(),
    },
  },
}));

const mockedPrisma = prisma as any;

describe('module type access', () => {
  beforeEach(() => {
    mockedPrisma.user.findUnique.mockReset();
  });

  it('normalizes unknown company module type to padrao', () => {
    expect(normalizeCompanyModuleType('foo')).toBe('padrao');
    expect(normalizeCompanyModuleType('tea')).toBe('tea');
    expect(normalizeCompanyModuleType('apenas-tea')).toBe('apenas-tea');
  });

  it('checks module access rules by module type', () => {
    expect(isModuleAllowedForCompanyType('modulo-tea', 'padrao')).toBe(false);
    expect(isModuleAllowedForCompanyType('modulo-tea', 'tea')).toBe(true);
    expect(isModuleAllowedForCompanyType('modulo-tea', 'apenas-tea')).toBe(true);
    expect(isModuleAllowedForCompanyType('cadastro-paciente', 'apenas-tea')).toBe(true);
    expect(isModuleAllowedForCompanyType('financeiro', 'apenas-tea')).toBe(false);
  });

  it('filters modules list based on company type', () => {
    const modules = [
      { name: 'cadastro-paciente' },
      { name: 'modulo-tea' },
      { name: 'financeiro' },
    ];

    expect(filterModulesForCompanyType(modules, 'padrao')).toEqual([
      { name: 'cadastro-paciente' },
      { name: 'financeiro' },
    ]);
    expect(filterModulesForCompanyType(modules, 'apenas-tea')).toEqual([
      { name: 'cadastro-paciente' },
      { name: 'modulo-tea' },
    ]);
  });

  it('loads company module type from request user', async () => {
    mockedPrisma.user.findUnique.mockResolvedValue({
      sector: {
        branch: {
          company: {
            module_type: 'apenas-tea',
          },
        },
      },
    });

    const result = await getRequestCompanyModuleType('user-123');

    expect(result).toBe('apenas-tea');
    expect(mockedPrisma.user.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'user-123' },
      }),
    );
  });

  it('returns null when user has no company module type', async () => {
    mockedPrisma.user.findUnique.mockResolvedValue({
      sector: {
        branch: {
          company: {
            module_type: null,
          },
        },
      },
    });

    const result = await getRequestCompanyModuleType('user-123');
    expect(result).toBeNull();
  });
});
