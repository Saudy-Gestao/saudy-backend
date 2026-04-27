import { describe, expect, it, vi } from 'vitest';

vi.mock('dayjs', () => {
  const mockedDayjs = vi.fn(() => {
    throw new Error('forced-dayjs-error');
  });
  mockedDayjs.locale = vi.fn();
  return { default: mockedDayjs };
});

vi.mock('dayjs/locale/pt-br', () => ({}));

import WhatsAppMessageBuilder from '../../src/modules/care/lib/whatsapp-message-builder';

describe('WhatsAppMessageBuilder formatDate fallback', () => {
  it('returns original date when formatter throws', () => {
    expect(WhatsAppMessageBuilder.formatDate('2026-03-18')).toBe('2026-03-18');
  });
});