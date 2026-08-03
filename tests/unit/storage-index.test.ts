import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalStorageProvider } from '../../src/lib/storage/local-provider';

describe('storage index', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    delete process.env.STORAGE_PROVIDER;
    delete process.env.LOCAL_STORAGE_BASE_DIR;
    delete process.env.GOOGLE_STORAGE_BUCKET;
    delete process.env.GOOGLE_STORAGE_BUCKET_DICOM;
    delete process.env.GOOGLE_STORAGE_BUCKET_ANEXOS;
    tempDirs.forEach((dir) => {
      fs.rmSync(dir, { recursive: true, force: true });
    });
    tempDirs.length = 0;
  });

  it('builds local providers and caches instances', async () => {
    process.env.STORAGE_PROVIDER = 'local';
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-index-'));
    tempDirs.push(baseDir);
    process.env.LOCAL_STORAGE_BASE_DIR = baseDir;

    const mod = await import('../../src/lib/storage');

    const dicom1 = mod.getDicomStorage();
    const dicom2 = mod.getDicomStorage();
    const anexos = mod.getAnexosStorage();

    expect(dicom1).toBe(dicom2);
    expect(dicom1).toBeInstanceOf(LocalStorageProvider);
    expect(anexos).toBeInstanceOf(LocalStorageProvider);

    mod.resetStorageCache();
    const dicom3 = mod.getDicomStorage();
    expect(dicom3).not.toBe(dicom1);
  });

  it('defaults to and builds supabase providers with role-specific buckets', async () => {
    process.env.SUPABASE_URL = 'https://project.supabase.co';
    process.env.SUPABASE_SECRET_KEY = 'secret-key';
    process.env.SUPABASE_STORAGE_BUCKET_DICOM = 'dicom-bucket';
    process.env.SUPABASE_STORAGE_BUCKET_ANEXOS = 'anexos-bucket';

    const mod = await import('../../src/lib/storage');

    const dicom = mod.getDicomStorage();
    const anexos = mod.getAnexosStorage();

    expect((dicom as any).bucketName).toBe('dicom-bucket');
    expect((anexos as any).bucketName).toBe('anexos-bucket');

    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SECRET_KEY;
    delete process.env.SUPABASE_STORAGE_BUCKET_DICOM;
    delete process.env.SUPABASE_STORAGE_BUCKET_ANEXOS;
  });

  it('builds gcs providers with role-specific buckets', async () => {
    process.env.STORAGE_PROVIDER = 'gcs';
    process.env.GOOGLE_STORAGE_BUCKET = 'fallback-bucket';
    process.env.GOOGLE_STORAGE_BUCKET_DICOM = 'dicom-bucket';

    const mod = await import('../../src/lib/storage');

    const dicom = mod.getDicomStorage();
    const anexos = mod.getAnexosStorage();

    expect((dicom as any).bucketName).toBe('dicom-bucket');
    expect((anexos as any).bucketName).toBe('fallback-bucket');
  });

  it('warns when gcs bucket is missing', async () => {
    process.env.STORAGE_PROVIDER = 'gcs';

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const mod = await import('../../src/lib/storage');
    mod.getDicomStorage();

    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it('throws for unknown provider', async () => {
    process.env.STORAGE_PROVIDER = 'invalid';

    const mod = await import('../../src/lib/storage');
    expect(() => mod.getDicomStorage()).toThrow('STORAGE_PROVIDER desconhecido');
  });
});
