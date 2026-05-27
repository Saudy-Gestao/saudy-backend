ALTER TABLE "doctors"
ADD COLUMN IF NOT EXISTS "signatureImageBase64" TEXT;

ALTER TABLE "doctors"
DROP COLUMN IF EXISTS "signatureImageUrl";
