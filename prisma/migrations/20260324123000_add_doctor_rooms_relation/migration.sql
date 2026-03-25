CREATE TABLE "doctor_rooms" (
    "id" TEXT NOT NULL,
    "doctorId" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "doctor_rooms_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "doctor_rooms_doctorId_roomId_key" ON "doctor_rooms"("doctorId", "roomId");
CREATE INDEX "doctor_rooms_doctorId_idx" ON "doctor_rooms"("doctorId");
CREATE INDEX "doctor_rooms_roomId_idx" ON "doctor_rooms"("roomId");

ALTER TABLE "doctor_rooms"
ADD CONSTRAINT "doctor_rooms_doctorId_fkey"
FOREIGN KEY ("doctorId") REFERENCES "doctors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "doctor_rooms"
ADD CONSTRAINT "doctor_rooms_roomId_fkey"
FOREIGN KEY ("roomId") REFERENCES "sectors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "doctor_rooms" ("id", "doctorId", "roomId", "createdAt")
SELECT gen_random_uuid()::text, "id", "roomId", CURRENT_TIMESTAMP
FROM "doctors"
WHERE "roomId" IS NOT NULL
ON CONFLICT ("doctorId", "roomId") DO NOTHING;
