import { describe, expect, it, vi } from 'vitest';
import {
  publishAppointmentCreatedEvent,
  publishAppointmentNoShowEventIfNeeded,
} from '../../src/modules/care/lib/appointment-whatsapp-events';

const {
  sendAppointmentCreatedMessageMock,
  sendNoShowMessageIfNeededMock,
} = vi.hoisted(() => ({
  sendAppointmentCreatedMessageMock: vi.fn(),
  sendNoShowMessageIfNeededMock: vi.fn(),
}));

vi.mock('../../src/modules/care/lib/whatsapp-auto-sender', () => ({
  default: {
    sendAppointmentCreatedMessage: sendAppointmentCreatedMessageMock,
    sendNoShowMessageIfNeeded: sendNoShowMessageIfNeededMock,
  },
}));

describe('appointment whatsapp events', () => {
  it('publishes appointment created event', () => {
    publishAppointmentCreatedEvent({ branchId: 'b-1', appointmentId: 'a-1' });
    expect(sendAppointmentCreatedMessageMock).toHaveBeenCalledWith('b-1', 'a-1');
  });

  it('publishes no-show event when needed', () => {
    publishAppointmentNoShowEventIfNeeded({ branchId: 'b-2', appointmentId: 'a-2' });
    expect(sendNoShowMessageIfNeededMock).toHaveBeenCalledWith('b-2', 'a-2');
  });
});
