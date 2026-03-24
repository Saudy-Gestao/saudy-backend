/**
 * Local Filesystem Storage Provider
 * ─────────────────────────────────────────────────────────────────────────────
 * Armazena arquivos no sistema de arquivos local, dentro de um subdiretório
 * por role (dicom/ ou anexos/).
 *
 * Estrutura de diretórios:
 *   {baseDir}/{role}/{objectName}
 *
 * Exemplo:
 *   /app/uploads/storage/dicom/abc123.dcm
 *   /app/uploads/storage/anexos/convenio-authorizations/filial/2025/doc.pdf
 *
 * Recomendação de infra:
 *   - Mapeie um Docker volume em /app/uploads para persistência
 *   - Para backups, use ferramentas como restic, rsync ou rclone
 *   - Para alta disponibilidade com múltiplas réplicas, use um NFS/EFS mount
 * ─────────────────────────────────────────────────────────────────────────────
 */

import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';
import type { StorageProvider, StorageUploadOptions } from './index';

export class LocalStorageProvider implements StorageProvider {
  private readonly root: string;

  /**
   * @param baseDir  Diretório base absoluto (ex: /app/uploads/storage)
   * @param role     Subdirectório separador por tipo (dicom | anexos)
   */
  constructor(baseDir: string, role: 'dicom' | 'anexos') {
    this.root = path.join(baseDir, role);
    // Garante que o diretório base existe na inicialização
    fs.mkdirSync(this.root, { recursive: true });
  }

  private resolve(objectName: string): string {
    // Impede path traversal
    const normalized = path.normalize(objectName).replace(/^(\.\.(\/|\\|$))+/, '');
    return path.join(this.root, normalized);
  }

  async save(objectName: string, buffer: Buffer, _options?: StorageUploadOptions): Promise<void> {
    const filePath = this.resolve(objectName);
    // Cria subdiretórios se necessário
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    await fs.promises.writeFile(filePath, buffer);
  }

  async download(objectName: string): Promise<Buffer> {
    const filePath = this.resolve(objectName);
    return fs.promises.readFile(filePath);
  }

  createReadStream(objectName: string): Readable {
    const filePath = this.resolve(objectName);
    return fs.createReadStream(filePath);
  }

  async exists(objectName: string): Promise<boolean> {
    const filePath = this.resolve(objectName);
    try {
      await fs.promises.access(filePath, fs.constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  async delete(objectName: string): Promise<void> {
    const filePath = this.resolve(objectName);
    try {
      await fs.promises.unlink(filePath);
    } catch {
      // silencioso se não existir
    }
  }
}
