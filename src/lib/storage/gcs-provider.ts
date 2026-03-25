/**
 * GCS Storage Provider
 * Encapsula o @google-cloud/storage para uso via StorageProvider.
 */

import { Readable } from 'stream';
import { Storage } from '@google-cloud/storage';
import type { StorageProvider, StorageUploadOptions } from './index';

export class GcsStorageProvider implements StorageProvider {
  private readonly storage: Storage;
  private readonly bucketName: string;

  constructor(bucketName: string) {
    this.bucketName = bucketName;
    this.storage = new Storage();
  }

  private get bucket() {
    if (!this.bucketName) throw new Error('GCS bucket não configurado');
    return this.storage.bucket(this.bucketName);
  }

  async save(objectName: string, buffer: Buffer, options?: StorageUploadOptions): Promise<void> {
    const file = this.bucket.file(objectName);
    await file.save(buffer, {
      resumable: false,
      contentType: options?.contentType || 'application/octet-stream',
      metadata: {
        contentType: options?.contentType || 'application/octet-stream',
        metadata: options?.metadata || {},
      },
    });
  }

  async download(objectName: string): Promise<Buffer> {
    const file = this.bucket.file(objectName);
    const [buffer] = await file.download();
    return buffer;
  }

  createReadStream(objectName: string): Readable {
    return this.bucket.file(objectName).createReadStream() as unknown as Readable;
  }

  async exists(objectName: string): Promise<boolean> {
    const [result] = await this.bucket.file(objectName).exists();
    return result;
  }

  async delete(objectName: string): Promise<void> {
    try {
      await this.bucket.file(objectName).delete();
    } catch {
      // silencioso se não existir
    }
  }
}
