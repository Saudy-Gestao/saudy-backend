import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalStorageProvider } from '../../src/lib/storage/local-provider';

async function readStreamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

describe('LocalStorageProvider', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => fs.promises.rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  it('saves, reads, checks existence and deletes files', async () => {
    const baseDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'storage-test-'));
    tempDirs.push(baseDir);

    const provider = new LocalStorageProvider(baseDir, 'dicom');
    const objectName = 'reports/2026/exam.txt';
    const payload = Buffer.from('hello-storage');

    await provider.save(objectName, payload);
    await expect(provider.exists(objectName)).resolves.toBe(true);
    await expect(provider.download(objectName)).resolves.toEqual(payload);

    const streamBuffer = await readStreamToBuffer(provider.createReadStream(objectName));
    expect(streamBuffer).toEqual(payload);

    await provider.delete(objectName);
    await expect(provider.exists(objectName)).resolves.toBe(false);
  });

  it('sanitizes path traversal attempts', async () => {
    const baseDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'storage-test-'));
    tempDirs.push(baseDir);

    const provider = new LocalStorageProvider(baseDir, 'anexos');
    const payload = Buffer.from('safe-content');

    await provider.save('../outside.txt', payload);

    const expectedSanitizedPath = path.join(baseDir, 'anexos', 'outside.txt');
    const outsidePath = path.join(baseDir, 'outside.txt');

    await expect(fs.promises.readFile(expectedSanitizedPath)).resolves.toEqual(payload);
    await expect(fs.promises.access(outsidePath)).rejects.toBeTruthy();
  });

  it('does not throw when deleting a missing file', async () => {
    const baseDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'storage-test-'));
    tempDirs.push(baseDir);

    const provider = new LocalStorageProvider(baseDir, 'dicom');
    await expect(provider.delete('missing/file.txt')).resolves.toBeUndefined();
  });
});
