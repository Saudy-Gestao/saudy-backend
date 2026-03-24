/**
 * Camada de compatibilidade DICOM — delega ao StorageProvider ativo.
 *
 * Anteriormente apontava diretamente ao GCS. Agora usa getDicomStorage()
 * cujo driver é controlado por STORAGE_PROVIDER (gcs | local).
 */
import { getDicomStorage } from '../../lib/storage';

export async function uploadDicomToGcs(objectName: string, buffer: Buffer) {
  await getDicomStorage().save(objectName, buffer, {
    contentType: 'application/dicom',
  });
}

export async function downloadDicomFromGcs(objectName: string): Promise<Buffer> {
  return getDicomStorage().download(objectName);
}

export function getDicomStreamFromGcs(objectName: string) {
  return getDicomStorage().createReadStream(objectName);
}
