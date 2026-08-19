/*
  Warnings:

  - You are about to drop the column `especialidadeIds` on the `doctors` table. All the data in the column will be lost.
  - You are about to drop the column `modalidadeIds` on the `doctors` table. All the data in the column will be lost.
  - You are about to drop the column `metodos` on the `doctors` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "doctors" DROP COLUMN "especialidadeIds",
    DROP COLUMN "modalidadeIds",
    DROP COLUMN "metodos",
    ADD COLUMN     "especialidadeGroups" TEXT NOT NULL DEFAULT '[]';
