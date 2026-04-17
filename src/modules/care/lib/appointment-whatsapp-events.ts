import WhatsAppAutoSender from './whatsapp-auto-sender';

type AppointmentEventPayload = {
  branchId: string;
  appointmentId: string;
};

export const publishAppointmentCreatedEvent = (payload: AppointmentEventPayload) => {
  void WhatsAppAutoSender.sendAppointmentCreatedMessage(payload.branchId, payload.appointmentId);
};

export const publishAppointmentNoShowEventIfNeeded = (payload: AppointmentEventPayload) => {
  void WhatsAppAutoSender.sendNoShowMessageIfNeeded(payload.branchId, payload.appointmentId);
};

