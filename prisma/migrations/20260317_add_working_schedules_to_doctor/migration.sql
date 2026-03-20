-- Add workingSchedules field to support multiple shifts with different hours
ALTER TABLE "doctors" ADD COLUMN "workingSchedules" TEXT DEFAULT '[]';

-- Set comment for clarity
COMMENT ON COLUMN "doctors"."workingSchedules" IS 'JSON array of working schedules: [{days: string[], hoursStart: string, hoursEnd: string}]';
