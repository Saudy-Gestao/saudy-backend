import { Readable } from 'stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GcsStorageProvider } from '../../src/lib/storage/gcs-provider';

const fileMock = {
  save: vi.fn(),
  download: vi.fn(),
  createReadStream: vi.fn(),
  exists: vi.fn(),
  delete: vi.fn(),
};

const bucketMock = {
  file: vi.fn(() => fileMock),
};

const storageBucketFn = vi.fn(() => bucketMock);

vi.mock('@google-cloud/storage', () => ({
  Storage: vi.fn().mockImplementation(() => ({
    bucket: storageBucketFn,
  })),
}));

describe('GcsStorageProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fileMock.save.mockResolvedValue(undefined);
    fileMock.download.mockResolvedValue([Buffer.from('downloaded')]);
    fileMock.createReadStream.mockReturnValue(Readable.from(['stream-content']));
    fileMock.exists.mockResolvedValue([true]);
    fileMock.delete.mockResolvedValue(undefined);
  });

  it('saves files with contentType and metadata', async () => {
    const provider = new GcsStorageProvider('bucket-1');

    await provider.save('folder/file.dcm', Buffer.from('abc'), {
      contentType: 'application/dicom',
      metadata: { a: '1' },
    });

    expect(bucketMock.file).toHaveBeenCalledWith('folder/file.dcm');
    expect(fileMock.save).toHaveBeenCalledWith(
      Buffer.from('abc'),
      expect.objectContaining({
        resumable: false,
        contentType: 'application/dicom',
      }),
    );
  });

  it('downloads, streams and checks file existence', async () => {
    const provider = new GcsStorageProvider('bucket-1');

    await expect(provider.download('a.txt')).resolves.toEqual(Buffer.from('downloaded'));
    await expect(provider.exists('a.txt')).resolves.toBe(true);

    const stream = provider.createReadStream('a.txt');
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    expect(Buffer.concat(chunks).toString()).toContain('stream-content');
  });

  it('throws if bucket name is empty', async () => {
    const provider = new GcsStorageProvider('');
    await expect(provider.download('a.txt')).rejects.toThrow('GCS bucket não configurado');
  });

  it('deletes files and swallows provider delete errors', async () => {
    const provider = new GcsStorageProvider('bucket-1');
    await expect(provider.delete('a.txt')).resolves.toBeUndefined();

    fileMock.delete.mockRejectedValueOnce(new Error('not found'));
    await expect(provider.delete('missing.txt')).resolves.toBeUndefined();
  });
});
