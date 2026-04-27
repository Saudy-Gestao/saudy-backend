import { describe, expect, it, vi } from 'vitest';
import {
  findCompanyByNormalizedCnpj,
  isValidNormalizedCnpj,
  normalizeCnpj,
} from '../../src/modules/auth/lib/cnpj';

describe('cnpj utils', () => {
  it('normalizes non-digit characters', () => {
    expect(normalizeCnpj('12.345.678/0001-95')).toBe('12345678000195');
    expect(normalizeCnpj('')).toBe('');
  });

  it('validates normalized cnpj values', () => {
    expect(isValidNormalizedCnpj('12345678000195')).toBe(true);
    expect(isValidNormalizedCnpj('11111111111111')).toBe(false);
    expect(isValidNormalizedCnpj('123')).toBe(false);
  });

  it('returns first matched company from raw query', async () => {
    const db = {
      $queryRaw: vi.fn().mockResolvedValue([
        { id: 'company-1', cnpj: '12.345.678/0001-95' },
        { id: 'company-2', cnpj: '99.999.999/0001-99' },
      ]),
    } as any;

    const result = await findCompanyByNormalizedCnpj(db, '12345678000195');

    expect(result).toEqual({ id: 'company-1', cnpj: '12.345.678/0001-95' });
    expect(db.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('returns null when raw query has no rows', async () => {
    const db = {
      $queryRaw: vi.fn().mockResolvedValue([]),
    } as any;

    const result = await findCompanyByNormalizedCnpj(db, '12345678000195', 'company-1');

    expect(result).toBeNull();
    expect(db.$queryRaw).toHaveBeenCalledTimes(1);
  });
});
