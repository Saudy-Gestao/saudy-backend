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

export interface SendMessageResponse {
  status: 'success' | 'error';
  messageId?: string;
  error?: string;
}

/**
 * Gupshup WhatsApp API Integration
 * Docs: https://docs.gupshup.io/docs/whatsapp-api-documentation
 */
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
}

export default GupshupService;
