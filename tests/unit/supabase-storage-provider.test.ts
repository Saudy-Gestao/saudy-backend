import { afterEach, describe, expect, it, vi } from 'vitest';

const { uploadMock, downloadMock, listMock, removeMock, fromMock, createClientMock } = vi.hoisted(() => {
  const uploadMock = vi.fn();
  const downloadMock = vi.fn();
  const listMock = vi.fn();
  const removeMock = vi.fn();
  const fromMock = vi.fn(() => ({
    upload: uploadMock,
    download: downloadMock,
    list: listMock,
    remove: removeMock,
  }));
  const createClientMock = vi.fn(() => ({ storage: { from: fromMock } }));
  return { uploadMock, downloadMock, listMock, removeMock, fromMock, createClientMock };
});

vi.mock('@supabase/supabase-js', () => ({
  createClient: createClientMock,
}));

describe('SupabaseStorageProvider', () => {
  afterEach(() => {
    vi.clearAllMocks();
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SECRET_KEY;
  });

  async function buildProvider(bucket = 'dicom') {
    process.env.SUPABASE_URL = 'https://project.supabase.co';
    process.env.SUPABASE_SECRET_KEY = 'secret-key';
    const { SupabaseStorageProvider } = await import('../../src/lib/storage/supabase-provider');
    return new SupabaseStorageProvider(bucket);
  }

  it('warns when credentials are missing but still constructs', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { SupabaseStorageProvider } = await import('../../src/lib/storage/supabase-provider');
    new SupabaseStorageProvider('dicom');
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it('uploads a buffer via save()', async () => {
    uploadMock.mockResolvedValueOnce({ error: null });
    const provider = await buildProvider();

    await provider.save('a/b.dcm', Buffer.from('hi'), { contentType: 'application/dicom' });

    expect(fromMock).toHaveBeenCalledWith('dicom');
    expect(uploadMock).toHaveBeenCalledWith('a/b.dcm', Buffer.from('hi'), {
      contentType: 'application/dicom',
      upsert: true,
    });
  });

  it('throws when save() fails', async () => {
    uploadMock.mockResolvedValueOnce({ error: new Error('boom') });
    const provider = await buildProvider();

    await expect(provider.save('a/b.dcm', Buffer.from('hi'))).rejects.toThrow('boom');
  });

  it('downloads bytes via download()', async () => {
    const bytes = new TextEncoder().encode('content');
    downloadMock.mockResolvedValueOnce({ data: { arrayBuffer: async () => bytes.buffer }, error: null });
    const provider = await buildProvider();

    const result = await provider.download('a/b.dcm');

    expect(Buffer.from(result).toString()).toBe('content');
  });

  it('throws when download() fails', async () => {
    downloadMock.mockResolvedValueOnce({ data: null, error: new Error('missing') });
    const provider = await buildProvider();

    await expect(provider.download('a/b.dcm')).rejects.toThrow('missing');
  });

  it('streams bytes via createReadStream()', async () => {
    const bytes = new TextEncoder().encode('streamed');
    downloadMock.mockResolvedValueOnce({ data: { arrayBuffer: async () => bytes.buffer }, error: null });
    const provider = await buildProvider();

    const chunks: Buffer[] = [];
    for await (const chunk of provider.createReadStream('a/b.dcm')) {
      chunks.push(chunk as Buffer);
    }

    expect(Buffer.concat(chunks).toString()).toBe('streamed');
  });

  it('exists() returns true when the file is listed', async () => {
    listMock.mockResolvedValueOnce({ data: [{ name: 'b.dcm' }], error: null });
    const provider = await buildProvider();

    await expect(provider.exists('a/b.dcm')).resolves.toBe(true);
    expect(listMock).toHaveBeenCalledWith('a', { search: 'b.dcm' });
  });

  it('exists() returns false on error or missing match', async () => {
    listMock.mockResolvedValueOnce({ data: [], error: null });
    const provider = await buildProvider();

    await expect(provider.exists('a/b.dcm')).resolves.toBe(false);
  });

  it('delete() swallows errors', async () => {
    removeMock.mockRejectedValueOnce(new Error('nope'));
    const provider = await buildProvider();

    await expect(provider.delete('a/b.dcm')).resolves.toBeUndefined();
  });
});
