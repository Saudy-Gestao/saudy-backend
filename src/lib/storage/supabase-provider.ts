/**
 * Supabase Storage Provider
 * Encapsula o cliente @supabase/supabase-js (Storage API) para uso via StorageProvider.
 */

import { Readable } from 'stream';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import type { StorageProvider, StorageUploadOptions } from './index';

export class SupabaseStorageProvider implements StorageProvider {
  private readonly client: SupabaseClient;
  private readonly bucketName: string;

  constructor(bucketName: string) {
    this.bucketName = bucketName;

    const url = process.env.SUPABASE_URL || '';
    const secretKey = process.env.SUPABASE_SECRET_KEY || '';
    if (!url || !secretKey) {
      console.warn('[storage] SUPABASE_URL/SUPABASE_SECRET_KEY não configurados. Operações de storage vão falhar.');
    }

    // Service-role key: acesso total ao bucket, ignorando RLS. Uso restrito ao backend.
    this.client = createClient(url, secretKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }

  private get bucket() {
    if (!this.bucketName) throw new Error('Supabase bucket não configurado');
    return this.client.storage.from(this.bucketName);
  }

  async save(objectName: string, buffer: Buffer, options?: StorageUploadOptions): Promise<void> {
    const { error } = await this.bucket.upload(objectName, buffer, {
      contentType: options?.contentType || 'application/octet-stream',
      upsert: true,
    });
    if (error) throw error;
  }

  async download(objectName: string): Promise<Buffer> {
    const { data, error } = await this.bucket.download(objectName);
    if (error) throw error;
    return Buffer.from(await data.arrayBuffer());
  }

  createReadStream(objectName: string): Readable {
    const bucket = this.bucket;
    return Readable.from(
      (async function* () {
        const { data, error } = await bucket.download(objectName);
        if (error) throw error;
        yield Buffer.from(await data.arrayBuffer());
      })(),
    );
  }

  async exists(objectName: string): Promise<boolean> {
    const lastSlash = objectName.lastIndexOf('/');
    const dir = lastSlash >= 0 ? objectName.slice(0, lastSlash) : '';
    const name = lastSlash >= 0 ? objectName.slice(lastSlash + 1) : objectName;

    const { data, error } = await this.bucket.list(dir, { search: name });
    if (error) return false;
    return (data || []).some((f) => f.name === name);
  }

  async delete(objectName: string): Promise<void> {
    try {
      await this.bucket.remove([objectName]);
    } catch {
      // silencioso se não existir
    }
  }
}
