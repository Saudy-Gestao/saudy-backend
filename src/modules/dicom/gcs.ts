import { Storage } from '@google-cloud/storage';

const bucketName = process.env.GOOGLE_STORAGE_BUCKET;
if (!bucketName) {
  console.warn('GCS bucket not configured (GOOGLE_STORAGE_BUCKET)');
}

const storage = new Storage();
const bucket = bucketName ? storage.bucket(bucketName) : null;

export async function uploadDicomToGcs(objectName: string, buffer: Buffer) {
  if (!bucket) throw new Error('GCS bucket not configured');
  const file = bucket.file(objectName);
  await file.save(buffer, { resumable: false });
  // Optionally make public or set ACL here
}

export function getDicomStreamFromGcs(objectName: string) {
  if (!bucket) throw new Error('GCS bucket not configured');
  return bucket.file(objectName).createReadStream();
}
