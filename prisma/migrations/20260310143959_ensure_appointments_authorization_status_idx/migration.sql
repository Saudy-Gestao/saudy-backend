-- Ensure index used by authorization filters exists (safe if it already exists)
CREATE INDEX IF NOT EXISTS "appointments_authorizationStatus_idx"
ON "appointments"("authorizationStatus");
