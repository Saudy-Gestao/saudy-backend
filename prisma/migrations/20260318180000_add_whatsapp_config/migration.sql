-- CreateEnum
CREATE TYPE "WhatsAppMessageType" AS ENUM ('APPOINTMENT_CREATED', 'APPOINTMENT_CONFIRMATION', 'APPOINTMENT_REMINDER', 'APPOINTMENT_CANCELED');

-- CreateTable
CREATE TABLE "whatsapp_configs" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "accountSid" TEXT NOT NULL,
    "authToken" TEXT NOT NULL,
    "fromNumber" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "whatsapp_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "whatsapp_message_templates" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "type" "WhatsAppMessageType" NOT NULL,
    "name" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "whatsapp_message_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "whatsapp_notification_configs" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "sendOnAppointmentCreated" BOOLEAN NOT NULL DEFAULT true,
    "sendConfirmationEnabled" BOOLEAN NOT NULL DEFAULT true,
    "confirmationHoursBefore" INTEGER NOT NULL DEFAULT 24,
    "sendReminderEnabled" BOOLEAN NOT NULL DEFAULT false,
    "reminderHoursBefore" INTEGER NOT NULL DEFAULT 2,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "whatsapp_notification_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "whatsapp_message_logs" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "appointmentId" TEXT,
    "patientName" TEXT,
    "patientPhone" TEXT NOT NULL,
    "messageType" "WhatsAppMessageType" NOT NULL,
    "message" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "errorMessage" TEXT,
    "twilioSid" TEXT,
    "sentAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "whatsapp_message_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_configs_branchId_key" ON "whatsapp_configs"("branchId");

-- CreateIndex
CREATE INDEX "whatsapp_configs_branchId_idx" ON "whatsapp_configs"("branchId");

-- CreateIndex
CREATE INDEX "whatsapp_message_templates_branchId_idx" ON "whatsapp_message_templates"("branchId");

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_message_templates_branchId_type_key" ON "whatsapp_message_templates"("branchId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_notification_configs_branchId_key" ON "whatsapp_notification_configs"("branchId");

-- CreateIndex
CREATE INDEX "whatsapp_notification_configs_branchId_idx" ON "whatsapp_notification_configs"("branchId");

-- CreateIndex
CREATE INDEX "whatsapp_message_logs_branchId_idx" ON "whatsapp_message_logs"("branchId");

-- CreateIndex
CREATE INDEX "whatsapp_message_logs_appointmentId_idx" ON "whatsapp_message_logs"("appointmentId");

-- CreateIndex
CREATE INDEX "whatsapp_message_logs_status_idx" ON "whatsapp_message_logs"("status");

-- CreateIndex
CREATE INDEX "whatsapp_message_logs_createdAt_idx" ON "whatsapp_message_logs"("createdAt");
