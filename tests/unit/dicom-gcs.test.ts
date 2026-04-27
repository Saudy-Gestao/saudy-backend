import { Readable } from 'stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  downloadDicomFromGcs,
  getDicomStreamFromGcs,
  uploadDicomToGcs,
} from '../../src/modules/dicom/gcs';
import { getDicomStorage } from '../../src/lib/storage';

vi.mock('../../src/lib/storage', () => ({
  getDicomStorage: vi.fn(),
}));

const mockedGetDicomStorage = getDicomStorage as unknown as ReturnType<typeof vi.fn>;

describe('dicom gcs compatibility layer', () => {
  const storageMock = {
    save: vi.fn(),
    download: vi.fn(),
    createReadStream: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockedGetDicomStorage.mockReturnValue(storageMock);
    storageMock.save.mockResolvedValue(undefined);
    storageMock.download.mockResolvedValue(Buffer.from('dicom-content'));
    storageMock.createReadStream.mockReturnValue(Readable.from(['stream']));
  });

  it('uploads using dicom content type', async () => {
    await uploadDicomToGcs('study/file.dcm', Buffer.from('payload'));

    expect(storageMock.save).toHaveBeenCalledWith(
      'study/file.dcm',
      Buffer.from('payload'),
      { contentType: 'application/dicom' },
    );
  });

  it('downloads via storage provider', async () => {
    await expect(downloadDicomFromGcs('study/file.dcm')).resolves.toEqual(Buffer.from('dicom-content'));
  });

  it('returns stream from storage provider', async () => {
    const stream = getDicomStreamFromGcs('study/file.dcm');
    const chunks: Buffer[] = [];

    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    expect(Buffer.concat(chunks).toString()).toBe('stream');
    expect(storageMock.createReadStream).toHaveBeenCalledWith('study/file.dcm');
  });
});
