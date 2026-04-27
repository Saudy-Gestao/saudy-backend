/**
 * Storage Abstraction Layer
 * ─────────────────────────────────────────────────────────────────────────────
 * Suporta dois providers controlados pela variável de ambiente STORAGE_PROVIDER:
 *
 *   STORAGE_PROVIDER=gcs    → Google Cloud Storage (padrão)
 *   STORAGE_PROVIDER=local  → Sistema de arquivos local (/app/uploads/storage/)
 *
 * A lógica de negócio usa StorageProvider sem saber qual driver está ativo.
 * Troca de provider: basta alterar a env e reiniciar o container.
 *
 * Banco DICOM   → GOOGLE_STORAGE_BUCKET_DICOM  / LOCAL_STORAGE_BASE_DIR
 * Banco Anexos  → GOOGLE_STORAGE_BUCKET_ANEXOS / LOCAL_STORAGE_BASE_DIR
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { Readable } from 'stream';
import { GcsStorageProvider } from './gcs-provider';
import { LocalStorageProvider } from './local-provider';

export interface StorageUploadOptions {
  contentType?: string;
  metadata?: Record<string, string>;
}

export interface StorageProvider {
  /** Salva um Buffer no storage. objectName é o caminho relativo (chave). */
  save(objectName: string, buffer: Buffer, options?: StorageUploadOptions): Promise<void>;

  /** Retorna os bytes do arquivo como Buffer. */
  download(objectName: string): Promise<Buffer>;

  /** Retorna um ReadableStream sem carregar tudo na memória. */
  createReadStream(objectName: string): Readable;

  /** Verifica se o arquivo existe. */
  exists(objectName: string): Promise<boolean>;

  /** Remove o arquivo. Silencioso se não existir. */
  delete(objectName: string): Promise<void>;
}

// ─── Lazy singleton singletons por "tipo de bucket" ──────────────────────────

let _dicomProvider: StorageProvider | null = null;
let _anexosProvider: StorageProvider | null = null;

type BucketRole = 'dicom' | 'anexos';

function buildProvider(role: BucketRole): StorageProvider {
  const providerType = (process.env.STORAGE_PROVIDER || 'gcs').toLowerCase().trim();

  if (providerType === 'local') {
    const baseDir = process.env.LOCAL_STORAGE_BASE_DIR || '/app/uploads/storage';
    return new LocalStorageProvider(baseDir, role);
  }

  if (providerType === 'gcs') {
    const bucketName = role === 'dicom'
      ? (process.env.GOOGLE_STORAGE_BUCKET_DICOM || process.env.GOOGLE_STORAGE_BUCKET || '')
      : (process.env.GOOGLE_STORAGE_BUCKET_ANEXOS || process.env.GOOGLE_STORAGE_BUCKET || '');

    if (!bucketName) {
      console.warn(`[storage] GCS bucket não configurado para role "${role}". Operações de storage vão falhar.`);
    }
    return new GcsStorageProvider(bucketName);
  }

  throw new Error(`[storage] STORAGE_PROVIDER desconhecido: "${providerType}". Use "gcs" ou "local".`);
}

/** Retorna (e cria em lazy) o provider para arquivos DICOM. */
export function getDicomStorage(): StorageProvider {
  if (!_dicomProvider) _dicomProvider = buildProvider('dicom');
  return _dicomProvider;
}

/** Retorna (e cria em lazy) o provider para anexos/documentos. */
export function getAnexosStorage(): StorageProvider {
  if (!_anexosProvider) _anexosProvider = buildProvider('anexos');
  return _anexosProvider;
}

/**
 * Reseta os singletons (útil em testes ou quando as envs mudam em runtime).
 */
export function resetStorageCache() {
  _dicomProvider = null;
  _anexosProvider = null;
}
