import { FastifyInstance } from 'fastify';
import prisma from '../lib/prisma';
import { decryptFlowRequest, encryptFlowResponse } from '../lib/whatsapp-flow-crypto';

/**
 * WhatsApp Flows data exchange endpoint.
 *
 * Meta calls this endpoint when a user interacts with a Flow screen that
 * requires dynamic data (action = "data_exchange") or on INIT.
 *
 * Payload (after decryption):
 * {
 *   version: "3.0",
 *   action: "INIT" | "data_exchange" | "ping",
 *   flow_token: string,
 *   screen: string,
 *   data: Record<string, unknown>
 * }
 *
 * Response must be encrypted with the same AES key and flipped IV.
 */

interface FlowActionPayload {
  version: string;
  action: 'INIT' | 'data_exchange' | 'ping';
  flow_token?: string;
  screen?: string;
  data?: Record<string, unknown>;
}

async function buildScreenResponse(payload: FlowActionPayload, branchId: string): Promise<Record<string, unknown>> {
  const screen = payload.screen || 'INTRO';
  const data = payload.data || {};

  if (payload.action === 'ping') {
    return { data: { status: 'active' } };
  }

  if (screen === 'INTRO' || payload.action === 'INIT') {
    // Load available units for this branch
    const sectors = await prisma.sector.findMany({
      where: { branchId, isActive: true },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
      take: 20,
    });

    return {
      screen: 'SERVICE',
      data: {
        services: [
          { id: 'CONSULTA', title: 'Consulta' },
          { id: 'EXAME', title: 'Exame' },
          { id: 'RETORNO', title: 'Retorno' },
        ],
        units: sectors.map((s: { id: string; name: string }) => ({ id: s.id, title: s.name })),
      },
    };
  }

  if (screen === 'SERVICE') {
    const serviceId = String(data.service_id || '').trim();
    const unitId = String(data.unit_id || '').trim();
    if (!serviceId || !unitId) {
      return { screen: 'SERVICE', data: { error: 'Selecione o serviço e a unidade.' } };
    }

    // Load procedures/specialty list for the sector
    const appointments = await prisma.appointment.findMany({
      where: { branchId, sectorId: unitId, isActive: true },
      select: { specialty: true },
      distinct: ['specialty'],
      take: 30,
    });

    const procedures = appointments
      .map((a: any) => String(a.specialty || '').trim())
      .filter(Boolean)
      .map((title: string) => ({ id: title, title }));

    return {
      screen: 'PROCEDURE',
      data: { procedures: procedures.length > 0 ? procedures : [{ id: 'OUTRO', title: 'Outro' }] },
    };
  }

  if (screen === 'PROCEDURE') {
    const procedureId = String(data.procedure_id || '').trim();
    const unitId = String(data.unit_id || '').trim();
    if (!procedureId || !unitId) {
      return { screen: 'PROCEDURE', data: { error: 'Selecione um procedimento.' } };
    }

    // Suggest next 5 available dates (simplified: next 5 weekdays)
    const today = new Date();
    const slots: Array<{ id: string; title: string }> = [];
    const cursor = new Date(today);
    cursor.setDate(cursor.getDate() + 1);

    while (slots.length < 5) {
      const weekDay = cursor.getDay();
      if (weekDay !== 0 && weekDay !== 6) {
        const iso = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}-${String(cursor.getDate()).padStart(2, '0')}`;
        const label = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' }).format(cursor);
        slots.push({ id: iso, title: label });
      }
      cursor.setDate(cursor.getDate() + 1);
    }

    return {
      screen: 'DATE',
      data: { dates: slots },
    };
  }

  if (screen === 'DATE') {
    const dateId = String(data.date_id || '').trim();
    const procedureId = String(data.procedure_id || '').trim();
    const unitId = String(data.unit_id || '').trim();
    const service = String(data.service_id || '').trim();

    const label = new Intl.DateTimeFormat('pt-BR', {
      day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'America/Sao_Paulo',
    }).format(new Date(`${dateId}T00:00:00`));

    return {
      screen: 'CONFIRM',
      data: {
        summary: `Serviço: ${service}\nProcedimento: ${procedureId}\nData preferida: ${label}`,
        service_id: service,
        procedure_id: procedureId,
        unit_id: unitId,
        date_id: dateId,
      },
    };
  }

  // Default: close the flow
  return {
    screen: 'CONFIRM',
    data: {},
  };
}

export default async function whatsappFlowRoutes(app: FastifyInstance) {
  /**
   * GET — verification endpoint Meta calls when saving the Flow endpoint URL
   */
  app.get('/whatsapp/flow/exchange', async (request, reply) => {
    const query = request.query as Record<string, string>;
    if (query.challenge) {
      return reply.send(query.challenge);
    }
    return { ok: true };
  });

  /**
   * POST — data exchange endpoint called by Meta during Flow interactions
   * Body: { encrypted_aes_key, encrypted_flow_data, initial_vector }
   */
  app.post('/whatsapp/flow/exchange', {
    schema: {
      summary: 'WhatsApp Flow data exchange',
      tags: ['WhatsApp'],
      body: { type: 'object', additionalProperties: true },
    },
  }, async (request, reply) => {
    const body = request.body as any;

    const { encrypted_aes_key, encrypted_flow_data, initial_vector } = body;

    if (!encrypted_aes_key || !encrypted_flow_data || !initial_vector) {
      return reply.status(400).send({ error: 'Missing encrypted fields' });
    }

    let decryptResult;
    try {
      decryptResult = decryptFlowRequest(encrypted_aes_key, encrypted_flow_data, initial_vector);
    } catch (err: any) {
      request.log.error({ err: err.message }, 'Flow decryption failed');
      return reply.status(421).send({ error: 'Decryption failed' });
    }

    const payload = decryptResult.decryptedBody as unknown as FlowActionPayload;

    request.log.info({ action: payload.action, screen: payload.screen, flowToken: payload.flow_token }, 'WhatsApp Flow exchange');

    // Resolve branchId from flow_token (we embed branchId there when triggering the flow)
    const flowToken = String(payload.flow_token || '').trim();
    let branchId = '';
    try {
      const tokenData = JSON.parse(Buffer.from(flowToken, 'base64').toString('utf-8')) as Record<string, string>;
      branchId = tokenData.branchId || '';
    } catch {
      branchId = '';
    }

    if (!branchId) {
      request.log.warn({ flowToken }, 'Could not resolve branchId from flow_token');
      const encrypted = encryptFlowResponse(
        { screen: 'INTRO', data: { error: 'Token inválido.' } },
        decryptResult.aesKeyBuffer,
        decryptResult.ivBuffer,
      );
      return reply.send(encrypted);
    }

    const screenResponse = await buildScreenResponse(payload, branchId);
    const encrypted = encryptFlowResponse(screenResponse, decryptResult.aesKeyBuffer, decryptResult.ivBuffer);
    return reply.send(encrypted);
  });
}
