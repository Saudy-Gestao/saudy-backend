import { describe, expect, it } from 'vitest';
import { isValidCpf, normalizeCpf } from '../../src/lib/cpf';

describe('cpf utils', () => {
  it('normalizes non digit characters', () => {
    expect(normalizeCpf('123.456.789-09')).toBe('12345678909');
    expect(normalizeCpf(undefined)).toBe('');
  });

  it('validates known valid cpf values', () => {
    expect(isValidCpf('529.982.247-25')).toBe(true);
    expect(isValidCpf('52998224725')).toBe(true);
    expect(isValidCpf('123.456.789-09')).toBe(true);
  });

  it('rejects invalid cpf values', () => {
    expect(isValidCpf('111.111.111-11')).toBe(false);
    expect(isValidCpf('52998224724')).toBe(false);
    expect(isValidCpf('123')).toBe(false);
  });
});
