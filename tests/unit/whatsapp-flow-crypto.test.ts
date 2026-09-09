import crypto from 'crypto';
import { beforeAll, describe, expect, it } from 'vitest';

let privateKeyPem: string;
let publicKey: crypto.KeyObject;
let decryptFlowRequest: typeof import('../../src/modules/care/lib/whatsapp-flow-crypto').decryptFlowRequest;
let encryptFlowResponse: typeof import('../../src/modules/care/lib/whatsapp-flow-crypto').encryptFlowResponse;

function encryptAesKeyForRequest(aesKey: Buffer) {
  return crypto.publicEncrypt(
    { key: publicKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    aesKey,
  );
}

function encryptFlowData(aesKey: Buffer, iv: Buffer, payload: Record<string, unknown>) {
  const cipher = crypto.createCipheriv('aes-128-gcm', aesKey, iv);
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf-8');
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([encrypted, authTag]);
}

beforeAll(async () => {
  const { privateKey, publicKey: pub } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  publicKey = pub;
  privateKeyPem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
  process.env.WHATSAPP_FLOW_PRIVATE_KEY = privateKeyPem;

  const mod = await import('../../src/modules/care/lib/whatsapp-flow-crypto');
  decryptFlowRequest = mod.decryptFlowRequest;
  encryptFlowResponse = mod.encryptFlowResponse;
});

describe('whatsapp-flow-crypto', () => {
  it('decrypts a request encrypted with the matching public key', () => {
    const aesKey = crypto.randomBytes(16);
    const iv = crypto.randomBytes(12);
    const payload = { action: 'ping', data: { hello: 'world' } };

    const encryptedAesKey = encryptAesKeyForRequest(aesKey).toString('base64');
    const encryptedFlowData = encryptFlowData(aesKey, iv, payload).toString('base64');
    const initialVector = iv.toString('base64');

    const result = decryptFlowRequest(encryptedAesKey, encryptedFlowData, initialVector);

    expect(result.decryptedBody).toEqual(payload);
    expect(result.aesKeyBuffer.equals(aesKey)).toBe(true);
    expect(result.ivBuffer.equals(iv)).toBe(true);
  });

  it('encrypts a response using a flipped IV that the client can reverse', () => {
    const aesKey = crypto.randomBytes(16);
    const iv = crypto.randomBytes(12);
    const responseData = { status: 'ok', value: 42 };

    const encoded = encryptFlowResponse(responseData, aesKey, iv);
    const raw = Buffer.from(encoded, 'base64');
    const TAG_LENGTH = 16;
    const ciphertext = raw.subarray(0, raw.length - TAG_LENGTH);
    const authTag = raw.subarray(raw.length - TAG_LENGTH);

    const flippedIv = Buffer.from(iv.map((b) => b ^ 0xff));
    const decipher = crypto.createDecipheriv('aes-128-gcm', aesKey, flippedIv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

    expect(JSON.parse(decrypted.toString('utf-8'))).toEqual(responseData);
  });
});
