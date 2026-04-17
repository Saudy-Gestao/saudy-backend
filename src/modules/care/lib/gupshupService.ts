/**
 * Gupshup WhatsApp messaging service
 * Docs: https://docs.gupshup.io/docs/send-message
 */

const GUPSHUP_API_URL = 'https://api.gupshup.io/sm/api/v1/msg';

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
  provider: 'gupshup';
  to: string;
  message: string;
  status?: string;
  raw?: unknown;
}

export interface GupshupDirectConfig {
  apiKey: string;
  appName: string;
  sourceNumber: string;
}

/**
 * Sends a WhatsApp text message via Gupshup using explicit credentials.
 */
export async function sendWhatsAppText(
  destination: string,
  text: string,
  config: GupshupDirectConfig,
): Promise<GupshupSendResult> {
  const normalizedDest = normalizePhone(destination);
  const apiKey = String(config?.apiKey || '').trim();
  const appName = String(config?.appName || '').trim();
  const sourceNumber = normalizePhone(String(config?.sourceNumber || ''));
  if (!apiKey || !appName || !sourceNumber) {
    throw new Error('Credenciais do WhatsApp (Gupshup) não informadas.');
  }

  const body = new URLSearchParams({
    channel: 'whatsapp',
    source: sourceNumber,
    destination: normalizedDest,
    message: JSON.stringify({ type: 'text', text }),
    'src.name': appName,
  });

  const response = await fetch(GUPSHUP_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      apikey: apiKey,
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
