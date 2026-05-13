import axios, { AxiosInstance } from 'axios';

export interface GupshupConfig {
  apiKey: string;
  appName: string;
  sourceNumber: string; // Número WhatsApp Business no formato: 5511999999999 (sem + ou espaços)
}

export interface SendMessageParams {
  to: string;
  message: string;
}

export interface SendTemplateParams {
  to: string;
  templateId: string;
  params: string[]; // Ordered values matching {{1}}, {{2}}, ... in the HSM template
}

export interface QuickReplyOption {
  title: string;
  postbackText?: string;
}

export interface SendQuickReplyParams {
  to: string;
  body: string;
  footer?: string;
  msgId?: string;
  options: QuickReplyOption[];
}

export interface ListMessageOption {
  title: string;
  description?: string;
  postbackText?: string;
}

export interface SendListMessageParams {
  to: string;
  body: string;
  buttonTitle?: string; // texto do botão que abre a lista (default: "Ver opções")
  sectionTitle?: string;
  options: ListMessageOption[];
}

export interface SendMessageResponse {
  status: 'success' | 'error';
  messageId?: string;
  error?: string;
}

/**
 * Gupshup WhatsApp API Integration
 * Docs: https://docs.gupshup.io/docs/whatsapp-api-documentation
 */
export interface GupshupV3Config {
  bearerToken: string; // Gupshup partner token for v3
  appId: string;       // Gupshup app UUID
  sourceNumber: string;
}

export class GupshupService {
  private client: AxiosInstance;
  private appName: string;
  private sourceNumber: string;

  constructor(config: GupshupConfig) {
    this.appName = config.appName;
    this.sourceNumber = this.normalizePhoneNumber(config.sourceNumber);

    this.client = axios.create({
      baseURL: 'https://api.gupshup.io/wa/api/v1',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'apikey': config.apiKey,
      },
    });
  }

  /**
   * Envia uma mensagem de texto simples via WhatsApp
   */
  async sendTextMessage(params: SendMessageParams): Promise<SendMessageResponse> {
    try {
      // Normalizar número de telefone (Gupshup espera apenas números: 5511999999999)
      const destinationNumber = this.normalizePhoneNumber(params.to);

      // Gupshup requires the message field to be a JSON-encoded object
      const data = new URLSearchParams({
        channel: 'whatsapp',
        source: this.sourceNumber,
        destination: destinationNumber,
        'src.name': this.appName,
        message: JSON.stringify({ type: 'text', text: params.message }),
      });

      const response = await this.client.post('/msg', data.toString());

      console.log('[gupshup] response', response.status, JSON.stringify(response.data));

      // Resposta bem-sucedida da Gupshup tem formato: { status: "submitted", messageId: "..." }
      if (response.data.status === 'submitted' || response.data.status === 'success') {
        return {
          status: 'success',
          messageId: response.data.messageId,
        };
      }

      return {
        status: 'error',
        error: response.data.message || JSON.stringify(response.data) || 'Erro desconhecido ao enviar mensagem',
      };
    } catch (error: any) {
      const rawData = error.response?.data;
      console.error('[gupshup] error', error.response?.status, JSON.stringify(rawData));

      const errorMessage = rawData?.message || rawData?.error || JSON.stringify(rawData) || error.message || 'Erro ao enviar mensagem';
      
      // Adicionar dicas específicas baseadas no erro
      let hint = '';
      if (error.response?.status === 401) {
        hint = ' | Verifique se a API Key está correta.';
      } else if (error.response?.status === 403) {
        hint = ' | Verifique se o número de origem está aprovado no Gupshup.';
      } else if (error.response?.data?.error?.code === 'E_RATE_LIMIT') {
        hint = ' | Limite de envio atingido. Por favor, tente novamente mais tarde.';
      }
      
      return {
        status: 'error',
        error: errorMessage + hint,
      };
    }
  }

  async sendQuickReplyMessage(params: SendQuickReplyParams): Promise<SendMessageResponse> {
    try {
      const destinationNumber = this.normalizePhoneNumber(params.to);

      const message = {
        type: 'quick_reply',
        ...(params.msgId ? { msgid: params.msgId } : {}),
        content: {
          type: 'text',
          text: params.body,
          ...(params.footer ? { caption: params.footer } : {}),
        },
        options: params.options.map((option) => ({
          type: 'text',
          title: option.title,
          ...(option.postbackText ? { postbackText: option.postbackText } : {}),
        })),
      };

      const data = new URLSearchParams({
        channel: 'whatsapp',
        source: this.sourceNumber,
        destination: destinationNumber,
        'src.name': this.appName,
        message: JSON.stringify(message),
      });

      const response = await this.client.post('/msg', data.toString());

      console.log('[gupshup] quick-reply response', response.status, JSON.stringify(response.data));

      if (response.data.status === 'submitted' || response.data.status === 'success') {
        return {
          status: 'success',
          messageId: response.data.messageId,
        };
      }

      return {
        status: 'error',
        error: response.data.message || JSON.stringify(response.data) || 'Erro desconhecido ao enviar quick reply',
      };
    } catch (error: any) {
      const rawData = error.response?.data;
      console.error('[gupshup] quick-reply error', error.response?.status, JSON.stringify(rawData));
      return {
        status: 'error',
        error: rawData?.message || rawData?.error || JSON.stringify(rawData) || error.message,
      };
    }
  }

  async sendListMessage(params: SendListMessageParams): Promise<SendMessageResponse> {
    try {
      const destinationNumber = this.normalizePhoneNumber(params.to);

      const message = {
        type: 'list',
        title: params.body,
        body: params.body,
        globalButtons: [{ type: 'text', title: params.buttonTitle || 'Ver opções' }],
        items: [
          {
            title: params.sectionTitle || 'Opções',
            subtitle: '',
            options: params.options.map((opt) => ({
              type: 'text',
              title: opt.title,
              description: opt.description || '',
              ...(opt.postbackText ? { postbackText: opt.postbackText } : {}),
            })),
          },
        ],
      };

      const data = new URLSearchParams({
        channel: 'whatsapp',
        source: this.sourceNumber,
        destination: destinationNumber,
        'src.name': this.appName,
        message: JSON.stringify(message),
      });

      const response = await this.client.post('/msg', data.toString());

      console.log('[gupshup] list-message response', response.status, JSON.stringify(response.data));

      if (response.data.status === 'submitted' || response.data.status === 'success') {
        return { status: 'success', messageId: response.data.messageId };
      }

      return {
        status: 'error',
        error: response.data.message || JSON.stringify(response.data) || 'Erro desconhecido ao enviar list message',
      };
    } catch (error: any) {
      const rawData = error.response?.data;
      console.error('[gupshup] list-message error', error.response?.status, JSON.stringify(rawData));
      return {
        status: 'error',
        error: rawData?.message || rawData?.error || JSON.stringify(rawData) || error.message,
      };
    }
  }

  /**
   * Normaliza número de telefone para formato Gupshup WhatsApp
   * Ex: (11) 98765-4321 -> 5511987654321
   * Remove prefixo whatsapp: e símbolos
   */
  private normalizePhoneNumber(phone: string): string {
    // Remove prefixo whatsapp: se existir
    let cleanPhone = phone.replace('whatsapp:', '');

    // Remove tudo que não é número
    let digits = cleanPhone.replace(/\D/g, '');

    // Adiciona código do país Brasil (55) se não tiver
    if (!digits.startsWith('55') && (digits.length === 11 || digits.length === 10)) {
      digits = `55${digits}`;
    }

    // Retorna apenas os números (sem + ou outros símbolos)
    return digits;
  }

  /**
   * Envia uma mensagem via template HSM aprovado pela Meta.
   * Funciona mesmo sem sessão ativa (proactive outreach).
   * O template deve estar aprovado no painel do Gupshup.
   * Os params devem corresponder às variáveis {{1}}, {{2}}, ... do template aprovado.
   */
  async sendTemplateMessage(params: SendTemplateParams): Promise<SendMessageResponse> {
    try {
      const destinationNumber = this.normalizePhoneNumber(params.to);

      const data = new URLSearchParams({
        channel: 'whatsapp',
        source: this.sourceNumber,
        destination: destinationNumber,
        'src.name': this.appName,
        template: JSON.stringify({
          id: params.templateId,
          params: params.params,
        }),
      });

      const response = await this.client.post('/template/msg', data.toString());

      console.log('[gupshup] template request', JSON.stringify({
        endpoint: '/template/msg',
        source: this.sourceNumber,
        destination: destinationNumber,
        appName: this.appName,
        templateId: params.templateId,
        params: params.params,
      }));
      console.log('[gupshup] template response', response.status, JSON.stringify(response.data));

      if (response.data.status === 'submitted' || response.data.status === 'success') {
        return { status: 'success', messageId: response.data.messageId };
      }

      return {
        status: 'error',
        error: response.data.message || JSON.stringify(response.data),
      };
    } catch (error: any) {
      const rawData = error.response?.data;
      console.error('[gupshup] template error', error.response?.status, JSON.stringify(rawData));
      return {
        status: 'error',
        error: rawData?.message || rawData?.error || JSON.stringify(rawData) || error.message,
      };
    }
  }

  /**
   * Verifica o status de uma mensagem
   */
  async getMessageStatus(messageId: string): Promise<any> {
    try {
      // Endpoint para buscar status de mensagem pode variar
      // Consultar documentação específica da Gupshup
      const response = await this.client.get(`/msg/${messageId}`);
      return response.data;
    } catch (error: any) {
      throw new Error(error.response?.data?.message || error.message || 'Erro ao consultar status');
    }
  }

  /**
   * Busca a URL da mídia pelo mediaId (wamid)
   * Gupshup API: GET /wa/media/{mediaId}
   * Note: Different from regular message endpoint, media endpoint is under /wa/media
   */
  async getMediaUrl(mediaId: string): Promise<{ url: string } | null> {
    try {
      // Keep the full wamid format - Gupshup might need it
      console.log('[gupshup] Fetching media URL for:', mediaId);
      
      // Try different possible endpoints
      const endpoints = [
        `/media/${mediaId}`, // Original attempt with baseURL
        `https://api.gupshup.io/wa/media/${mediaId}`, // Direct WhatsApp media endpoint
        `https://media.gupshup.io/wa/${mediaId}`, // Alternative media subdomain
      ];
      
      for (const endpoint of endpoints) {
        try {
          console.log('[gupshup] Trying endpoint:', endpoint);
          
          const response = endpoint.startsWith('https://')
            ? await axios.get(endpoint, {
                headers: {
                  'apikey': this.client.defaults.headers['apikey'],
                },
              })
            : await this.client.get(endpoint);
          
          console.log('[gupshup] Response status:', response.status);
          console.log('[gupshup] Response data:', JSON.stringify(response.data));
          
          // Check various response formats
          if (response.data?.url) {
            console.log('[gupshup] Found URL in response.data.url:', response.data.url);
            return { url: response.data.url };
          }
          
          if (response.data?.media?.url) {
            console.log('[gupshup] Found URL in response.data.media.url:', response.data.media.url);
            return { url: response.data.media.url };
          }
          
          if (typeof response.data === 'string' && response.data.startsWith('http')) {
            console.log('[gupshup] Response is direct URL:', response.data);
            return { url: response.data };
          }
          
          console.log('[gupshup] No URL found in response from endpoint:', endpoint);
        } catch (endpointError: any) {
          console.log('[gupshup] Endpoint failed:', endpoint, 'Status:', endpointError.response?.status);
          // Continue to next endpoint
        }
      }
      
      console.error('[gupshup] All endpoints failed for mediaId:', mediaId);
      return null;
    } catch (error: any) {
      console.error('[gupshup] getMediaUrl error', error.response?.status, JSON.stringify(error.response?.data));
      return null;
    }
  }
}

/**
 * GupshupV3Service — Meta Cloud API passthrough via Gupshup v3 endpoint.
 * In v3 mode:
 *   - accountSid = Bearer token (partner token)
 *   - authToken  = Gupshup App ID (UUID)
 */
export class GupshupV3Service {
  private bearerToken: string;
  private appId: string;
  constructor(config: GupshupV3Config) {
    this.bearerToken = config.bearerToken;
    this.appId = config.appId;
  }

  private normalizePhone(phone: string): string {
    const digits = phone.replace(/\D/g, '');
    if (!digits.startsWith('55') && (digits.length === 11 || digits.length === 10)) {
      return `55${digits}`;
    }
    return digits;
  }

  private async sendV3(to: string, message: Record<string, unknown>): Promise<SendMessageResponse> {
    const destination = this.normalizePhone(to);
    const body = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: destination,
      ...message,
    };

    try {
      const url = `https://partner.gupshup.io/partner/app/${this.appId}/v3/message`;
      console.log('[gupshup-v3] POST', url, 'to:', destination);
      const res = await axios.post(
        url,
        body,
        {
          headers: {
            'Content-Type': 'application/json',
            'token': this.bearerToken,
          },
        },
      );

      console.log('[gupshup-v3] response', res.status, JSON.stringify(res.data));

      if (res.data?.messages?.[0]?.id || res.data?.status === 'submitted' || res.data?.status === 'success') {
        return {
          status: 'success',
          messageId: res.data?.messages?.[0]?.id || res.data?.messageId,
        };
      }

      return { status: 'error', error: JSON.stringify(res.data) };
    } catch (error: any) {
      const rawData = error.response?.data;
      console.error('[gupshup-v3] error', error.response?.status, JSON.stringify(rawData));
      return {
        status: 'error',
        error: rawData?.error?.message || rawData?.message || JSON.stringify(rawData) || error.message,
      };
    }
  }

  async sendTextMessage(params: SendMessageParams): Promise<SendMessageResponse> {
    return this.sendV3(params.to, {
      type: 'text',
      text: { body: params.message },
    });
  }

  async sendTemplateMessage(params: SendTemplateParams): Promise<SendMessageResponse> {
    // Build components array from ordered params
    const components = params.params.length > 0
      ? [{
          type: 'body',
          parameters: params.params.map((text) => ({ type: 'text', text })),
        }]
      : [];

    return this.sendV3(params.to, {
      type: 'template',
      template: {
        name: params.templateId,
        language: { code: 'pt_BR' },
        components,
      },
    });
  }

  async sendQuickReplyMessage(params: SendQuickReplyParams): Promise<SendMessageResponse> {
    return this.sendV3(params.to, {
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: params.body },
        ...(params.footer ? { footer: { text: params.footer } } : {}),
        action: {
          buttons: params.options.slice(0, 3).map((opt, i) => ({
            type: 'reply',
            reply: {
              id: opt.postbackText || String(i + 1),
              title: opt.title.slice(0, 20),
            },
          })),
        },
      },
    });
  }

  async sendListMessage(params: SendListMessageParams): Promise<SendMessageResponse> {
    return this.sendV3(params.to, {
      type: 'interactive',
      interactive: {
        type: 'list',
        body: { text: params.body },
        action: {
          button: params.buttonTitle || 'Ver opções',
          sections: [
            {
              title: params.sectionTitle || 'Opções',
              rows: params.options.slice(0, 10).map((opt, i) => ({
                id: opt.postbackText || String(i + 1),
                title: opt.title.slice(0, 24),
                description: (opt.description || '').slice(0, 72),
              })),
            },
          ],
        },
      },
    });
  }

  async sendFlowMessage(params: {
    to: string;
    flowId: string;
    flowToken: string;
    bodyText: string;
    ctaText: string;
    screenId?: string;
    data?: Record<string, unknown>;
  }): Promise<SendMessageResponse> {
    return this.sendV3(params.to, {
      type: 'interactive',
      interactive: {
        type: 'flow',
        body: { text: params.bodyText },
        action: {
          name: 'flow',
          parameters: {
            flow_message_version: '3',
            flow_token: params.flowToken,
            flow_id: params.flowId,
            flow_cta: params.ctaText,
            flow_action: 'navigate',
            flow_action_payload: {
              screen: params.screenId || 'INTRO',
              data: params.data || {},
            },
          },
        },
      },
    });
  }

  async getMediaUrl(mediaId: string): Promise<{ url: string } | null> {
    // In v3 / Meta Cloud API, media is fetched from Meta's endpoint using the media ID
    // Gupshup provides a proxy or you fetch directly from Meta Graph API
    try {
      const res = await axios.get(
        `https://partner.gupshup.io/partner/app/${this.appId}/v3/media/${mediaId}`,
        {
          headers: { 'token': this.bearerToken },
        },
      );
      const url = res.data?.url || res.data?.media?.url || null;
      if (url) return { url };
      return null;
    } catch (error: any) {
      console.error('[gupshup-v3] getMediaUrl error', error.response?.status, JSON.stringify(error.response?.data));
      return null;
    }
  }
}

/**
 * Creates a GupshupV3Service from the shape stored in WhatsAppConfig:
 *   accountSid  = Bearer token (Gupshup partner token)
 *   authToken   = Gupshup App ID
 *   fromNumber  = source WhatsApp number (kept for compat, not used in v3 API calls)
 */
export function createMessagingService(config: {
  accountSid: string;
  authToken?: string;
  fromNumber?: string;
  appId?: string | null;
}): GupshupV3Service {
  return new GupshupV3Service({
    bearerToken: config.accountSid,
    appId: config.appId || config.authToken || '',
    sourceNumber: config.fromNumber || '',
  });
}

export default GupshupV3Service;
