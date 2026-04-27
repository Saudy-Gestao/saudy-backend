import { describe, expect, it } from 'vitest';
import { isValidEmail, normalizeEmail } from '../../src/lib/email';

describe('email utils', () => {
  it('normalizes casing and whitespace', () => {
    expect(normalizeEmail('  TEST@EXAMPLE.COM  ')).toBe('test@example.com');
    expect(normalizeEmail(null)).toBe('');
  });

  it('validates email format', () => {
    expect(isValidEmail('john.doe@clinic.com')).toBe(true);
    expect(isValidEmail('john..doe')).toBe(false);
    expect(isValidEmail('')).toBe(false);
  });
});
