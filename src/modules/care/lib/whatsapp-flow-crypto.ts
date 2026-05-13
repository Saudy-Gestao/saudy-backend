import crypto from 'crypto';

/**
 * WhatsApp Flows Data Exchange Encryption
 *
 * Meta encrypts the AES-128 key with our RSA-2048 public key (OAEP/SHA-256).
 * We decrypt it with our private key, then use it to decrypt the flow data
 * with AES-128-GCM.
 *
 * On response we encrypt with the same AES key but with a flipped IV
 * (each byte XOR'd with 0xFF) as required by the spec.
 *
 * Private key is loaded from WHATSAPP_FLOW_PRIVATE_KEY env var (PEM, base64 or raw).
 */

const PRIVATE_KEY_PEM = (() => {
  const raw = process.env.WHATSAPP_FLOW_PRIVATE_KEY || '';
  if (!raw) return '';
  const trimmed = raw.trim();
  if (trimmed.startsWith('-----')) return trimmed;
  // Assume base64-encoded PEM (newlines stripped)
  return Buffer.from(trimmed, 'base64').toString('utf-8');
})();

export interface FlowDecryptResult {
  decryptedBody: Record<string, unknown>;
  aesKeyBuffer: Buffer;
  ivBuffer: Buffer;
}

export function decryptFlowRequest(
  encryptedAesKey: string,
  encryptedFlowData: string,
  initialVector: string,
): FlowDecryptResult {
  if (!PRIVATE_KEY_PEM) {
    throw new Error('WHATSAPP_FLOW_PRIVATE_KEY not configured');
  }

  const aesKeyBuffer = crypto.privateDecrypt(
    {
      key: PRIVATE_KEY_PEM,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256',
    },
    Buffer.from(encryptedAesKey, 'base64'),
  );

  const ivBuffer = Buffer.from(initialVector, 'base64');

  // Decrypt: AES-128-GCM — last 16 bytes of the ciphertext are the auth tag
  const encryptedData = Buffer.from(encryptedFlowData, 'base64');
  const TAG_LENGTH = 16;
  const encryptedBody = encryptedData.subarray(0, encryptedData.length - TAG_LENGTH);
  const authTag = encryptedData.subarray(encryptedData.length - TAG_LENGTH);

  const decipher = crypto.createDecipheriv('aes-128-gcm', aesKeyBuffer, ivBuffer);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([decipher.update(encryptedBody), decipher.final()]);
  const decryptedBody = JSON.parse(decrypted.toString('utf-8')) as Record<string, unknown>;

  return { decryptedBody, aesKeyBuffer, ivBuffer };
}

export function encryptFlowResponse(
  responseData: Record<string, unknown>,
  aesKeyBuffer: Buffer,
  ivBuffer: Buffer,
): string {
  // Flip every byte of IV as required by Meta spec
  const flippedIv = Buffer.from(ivBuffer.map((b) => b ^ 0xff));

  const cipher = crypto.createCipheriv('aes-128-gcm', aesKeyBuffer, flippedIv);
  const plaintext = Buffer.from(JSON.stringify(responseData), 'utf-8');
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // Concatenate ciphertext + auth tag, then base64
  return Buffer.concat([encrypted, authTag]).toString('base64');
}
