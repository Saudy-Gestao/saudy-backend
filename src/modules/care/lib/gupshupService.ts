/**
 * Gupshup WhatsApp messaging service
 * Docs: https://docs.gupshup.io/docs/send-message
 */

const GUPSHUP_API_URL = 'https://api.gupshup.io/sm/api/v1/msg';

const API_KEY = process.env.GUPSHUP_API_KEY || '';
const APP_NAME = process.env.GUPSHUP_APP_NAME || '';
const SOURCE_NUMBER = process.env.GUPSHUP_SOURCE_NUMBER || '';

function isConfigured(): boolean {
  return Boolean(API_KEY && APP_NAME && SOURCE_NUMBER);
}

/**
 * Normalizes a Brazilian phone number to E.164 without the + sign.
 * Accepts formats like: +55 21 93618-7141, 5521936187141, (21) 93618-7141, etc.
 */
function normalizePhone(phone: string): string {
  // Strip everything except digits
  const digits = phone.replace(/\D/g, '');

  // If starts with 55 and has 12-13 digits, use as-is
  if (digits.startsWith('55') && digits.length >= 12 && digits.length <= 13) {
    return digits;
  }

  // Otherwise assume it's a Brazilian number without country code
  return `55${digits}`;
}

export interface GupshupSendResult {
  provider: 'gupshup' | 'mock';
  to: string;
  message: string;
  status?: string;
  raw?: unknown;
}

/**
 * Sends a WhatsApp text message via Gupshup.
 * Falls back to mock mode if env vars are not configured.
 */
export async function sendWhatsAppText(
  destination: string,
  text: string,
): Promise<GupshupSendResult> {
  const normalizedDest = normalizePhone(destination);

  if (!isConfigured()) {
    console.warn('[gupshup] Not configured — running in mock mode');
    return { provider: 'mock', to: normalizedDest, message: text, status: 'MOCK' };
  }

  const body = new URLSearchParams({
    channel: 'whatsapp',
    source: SOURCE_NUMBER,
    destination: normalizedDest,
    message: JSON.stringify({ type: 'text', text }),
    'src.name': APP_NAME,
  });

  const response = await fetch(GUPSHUP_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      apikey: API_KEY,
    },
    body: body.toString(),
  });

  const raw = await response.json().catch(() => null);

  if (!response.ok) {
    console.error('[gupshup] Error sending message', response.status, raw);
    throw new Error(`Gupshup error ${response.status}: ${JSON.stringify(raw)}`);
  }

  return {
    provider: 'gupshup',
    to: normalizedDest,
    message: text,
    status: (raw as any)?.status || 'submitted',
    raw,
  };
}
