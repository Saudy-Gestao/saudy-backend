import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveWhatsAppConfigForBranch } from '../../src/modules/care/lib/whatsapp-config-resolver';
import prisma from '../../src/modules/care/lib/prisma';

vi.mock('../../src/modules/care/lib/prisma', () => ({
  default: {
    whatsAppConfig: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
    },
    branch: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
    },
  },
}));

const mockedPrisma = prisma as any;

describe('resolveWhatsAppConfigForBranch', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns null for an empty branchId', async () => {
    expect(await resolveWhatsAppConfigForBranch('')).toBeNull();
    expect(mockedPrisma.whatsAppConfig.findUnique).not.toHaveBeenCalled();
  });

  it('returns the branch own config when it is active and has credentials', async () => {
    mockedPrisma.whatsAppConfig.findUnique.mockResolvedValue({
      branchId: 'b-1',
      isActive: true,
      accountSid: 'AC1',
      authToken: 'tok',
      fromNumber: '+551199990000',
      appId: 'app-1',
    });

    const result = await resolveWhatsAppConfigForBranch('b-1');

    expect(result).toEqual({
      sourceBranchId: 'b-1',
      isInherited: false,
      accountSid: 'AC1',
      authToken: 'tok',
      fromNumber: '+551199990000',
      appId: 'app-1',
    });
    expect(mockedPrisma.branch.findUnique).not.toHaveBeenCalled();
  });

  it('ignores own config when inactive and requireActive is not disabled', async () => {
    mockedPrisma.whatsAppConfig.findUnique.mockResolvedValue({
      branchId: 'b-1', isActive: false, accountSid: 'AC1', authToken: 'tok', fromNumber: '+55', appId: null,
    });
    mockedPrisma.branch.findUnique.mockResolvedValue({ companyId: 'c-1' });
    mockedPrisma.branch.findMany.mockResolvedValue([]);

    const result = await resolveWhatsAppConfigForBranch('b-1');
    expect(result).toBeNull();
  });

  it('accepts an inactive own config when requireActive is false', async () => {
    mockedPrisma.whatsAppConfig.findUnique.mockResolvedValue({
      branchId: 'b-1', isActive: false, accountSid: 'AC1', authToken: 'tok', fromNumber: '+55', appId: null,
    });

    const result = await resolveWhatsAppConfigForBranch('b-1', { requireActive: false });
    expect(result?.sourceBranchId).toBe('b-1');
  });

  it('returns null when own config is missing and branch has no company', async () => {
    mockedPrisma.whatsAppConfig.findUnique.mockResolvedValue(null);
    mockedPrisma.branch.findUnique.mockResolvedValue(null);

    const result = await resolveWhatsAppConfigForBranch('b-1');
    expect(result).toBeNull();
  });

  it('returns null when there are no sibling branches with configs', async () => {
    mockedPrisma.whatsAppConfig.findUnique.mockResolvedValue(null);
    mockedPrisma.branch.findUnique.mockResolvedValue({ companyId: 'c-1' });
    mockedPrisma.branch.findMany.mockResolvedValue([{ id: 'b-1', isMatriz: false }]);

    const result = await resolveWhatsAppConfigForBranch('b-1');
    expect(result).toBeNull();
    expect(mockedPrisma.whatsAppConfig.findMany).not.toHaveBeenCalled();
  });

  it('inherits config from the matriz branch even if it was updated earlier than another branch', async () => {
    mockedPrisma.whatsAppConfig.findUnique.mockResolvedValue(null);
    mockedPrisma.branch.findUnique.mockResolvedValue({ companyId: 'c-1' });
    mockedPrisma.branch.findMany.mockResolvedValue([
      { id: 'b-1', isMatriz: false },
      { id: 'b-2', isMatriz: false },
      { id: 'b-3', isMatriz: true },
    ]);
    mockedPrisma.whatsAppConfig.findMany.mockResolvedValue([
      {
        branchId: 'b-2', isActive: true, accountSid: 'AC2', authToken: 'tok2', fromNumber: '+552',
        appId: null, updatedAt: new Date('2024-06-01'),
      },
      {
        branchId: 'b-3', isActive: true, accountSid: 'AC3', authToken: 'tok3', fromNumber: '+553',
        appId: 'app-3', updatedAt: new Date('2024-01-01'),
      },
    ]);

    const result = await resolveWhatsAppConfigForBranch('b-1');

    expect(result).toEqual({
      sourceBranchId: 'b-3',
      isInherited: true,
      accountSid: 'AC3',
      authToken: 'tok3',
      fromNumber: '+553',
      appId: 'app-3',
    });
  });

  it('falls back to the most recently updated non-matriz branch when no matriz has a usable config', async () => {
    mockedPrisma.whatsAppConfig.findUnique.mockResolvedValue(null);
    mockedPrisma.branch.findUnique.mockResolvedValue({ companyId: 'c-1' });
    mockedPrisma.branch.findMany.mockResolvedValue([
      { id: 'b-1', isMatriz: false },
      { id: 'b-2', isMatriz: false },
      { id: 'b-3', isMatriz: false },
    ]);
    mockedPrisma.whatsAppConfig.findMany.mockResolvedValue([
      {
        branchId: 'b-2', isActive: true, accountSid: 'AC2', authToken: 'tok2', fromNumber: '+552',
        appId: null, updatedAt: new Date('2024-01-01'),
      },
      {
        branchId: 'b-3', isActive: true, accountSid: 'AC3', authToken: 'tok3', fromNumber: '+553',
        appId: null, updatedAt: new Date('2024-06-01'),
      },
    ]);

    const result = await resolveWhatsAppConfigForBranch('b-1');
    expect(result?.sourceBranchId).toBe('b-3');
  });

  it('filters out configs without credentials when finding a sibling to inherit from', async () => {
    mockedPrisma.whatsAppConfig.findUnique.mockResolvedValue(null);
    mockedPrisma.branch.findUnique.mockResolvedValue({ companyId: 'c-1' });
    mockedPrisma.branch.findMany.mockResolvedValue([
      { id: 'b-1', isMatriz: false },
      { id: 'b-2', isMatriz: false },
    ]);
    mockedPrisma.whatsAppConfig.findMany.mockResolvedValue([
      {
        branchId: 'b-2', isActive: true, accountSid: '', authToken: '', fromNumber: '',
        appId: null, updatedAt: new Date('2024-01-01'),
      },
    ]);

    const result = await resolveWhatsAppConfigForBranch('b-1');
    expect(result).toBeNull();
  });
});
