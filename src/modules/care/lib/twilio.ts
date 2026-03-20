import axios, { AxiosInstance } from 'axios';

export interface TwilioConfig {
  accountSid: string;
  authToken: string;
  fromNumber: string; // Número WhatsApp Business no formato: whatsapp:+5511999999999
}

export interface SendMessageParams {
  to: string;
  message: string;
}

export interface SendMessageResponse {
  status: 'success' | 'error';
  messageId?: string;
  error?: string;
}

/**
 * Twilio WhatsApp API Integration
 * Docs: https://www.twilio.com/docs/whatsapp/api
 */
export class TwilioService {
  private client: AxiosInstance;
  private fromNumber: string;

  constructor(config: TwilioConfig) {
    // Garantir que o fromNumber tenha o prefixo whatsapp:
    this.fromNumber = config.fromNumber.startsWith('whatsapp:') 
      ? config.fromNumber 
      : `whatsapp:${config.fromNumber}`;
    
    // Basic Auth com Account SID e Auth Token
    const basicAuth = Buffer.from(`${config.accountSid}:${config.authToken}`).toString('base64');
    
    this.client = axios.create({
      baseURL: `https://api.twilio.com/2010-04-01/Accounts/${config.accountSid}`,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${basicAuth}`,
      },
    });
  }

  /**
   * Envia uma mensagem de texto simples via WhatsApp
   */
  async sendTextMessage(params: SendMessageParams): Promise<SendMessageResponse> {
    try {
      // Normalizar número de telefone (Twilio espera formato: whatsapp:+5511999999999)
      const phoneNumber = this.normalizePhoneNumber(params.to);

      const data = new URLSearchParams({
        From: this.fromNumber,
        To: phoneNumber,
        Body: params.message,
      });

      const response = await this.client.post('/Messages.json', data.toString());

      if (response.data.sid) {
        return {
          status: 'success',
          messageId: response.data.sid,
        };
      }

      return {
        status: 'error',
        error: response.data.message || 'Erro desconhecido ao enviar mensagem',
      };
    } catch (error: any) {
      const errorMessage = error.response?.data?.message || error.message || 'Erro ao enviar mensagem';
      const errorCode = error.response?.data?.code;
      
      // Adicionar dicas específicas baseadas no erro
      let hint = '';
      if (errorCode === 20008 || errorCode === 63007) {
        hint = ' | ATENÇÃO: Sua conta Twilio Trial tem limitações. Para usar WhatsApp, você precisa fazer upgrade adicionando créditos na conta.';
      }
      
      return {
        status: 'error',
        error: errorMessage + hint,
      };
    }
  }

  /**
   * Normaliza número de telefone para formato Twilio WhatsApp
   * Ex: (11) 98765-4321 -> whatsapp:+5511987654321
   */
  private normalizePhoneNumber(phone: string): string {
    // Se já tem prefixo whatsapp:, retorna
    if (phone.startsWith('whatsapp:')) {
      return phone;
    }

    // Remove tudo que não é número
    let digits = phone.replace(/\D/g, '');

    // Adiciona código do país Brasil (55) se não tiver
    if (!digits.startsWith('55') || digits.length < 12) {
      if (digits.length === 11 || digits.length === 10) {
        digits = `55${digits}`;
      }
    }

    // Retorna no formato whatsapp:+5511999999999
    return `whatsapp:+${digits}`;
  }

  /**
   * Verifica o status de uma mensagem
   */
  async getMessageStatus(messageId: string): Promise<any> {
    try {
      const response = await this.client.get(`/Messages/${messageId}.json`);
      return response.data;
    } catch (error: any) {
      throw new Error(error.response?.data?.message || error.message || 'Erro ao consultar status');
    }
  }
}

export default TwilioService;
