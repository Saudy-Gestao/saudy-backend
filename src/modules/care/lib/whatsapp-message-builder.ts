import dayjs from 'dayjs';
import 'dayjs/locale/pt-br';

dayjs.locale('pt-br');

export interface AppointmentData {
  patientName?: string | null;
  patientCpf?: string | null;
  doctorName?: string | null;
  specialty?: string | null;
  date?: string | null;
  time?: string | null;
  convenio?: string | null;
  observations?: string | null;
  clinicName?: string | null;
  location?: string | null;
  professional?: string | null;
  documentsLink?: string | null;
}

/**
 * Constrói mensagens WhatsApp substituindo variáveis pelos dados reais
 * 
 * Variáveis disponíveis:
 * - {{paciente_nome}} - Nome do paciente
 * - {{paciente_cpf}} - CPF do paciente (formatado)
 * - {{medico_nome}} - Nome do médico
 * - {{especialidade}} - Especialidade/Procedimento
 * - {{data}} - Data do agendamento (formatada)
 * - {{hora}} - Hora do agendamento
 * - {{convenio}} - Convênio
 * - {{observacoes}} - Observações
 * - {{clinica_nome}} - Nome da clínica/filial
 * - {{local}} - Local do atendimento
 * - {{profissional}} - Nome do profissional
 * - {{link_documentos}} - Link para envio de documentos
 */
export class WhatsAppMessageBuilder {
  /**
   * Substitui as variáveis do template pelos dados reais
   */
  static buildMessage(template: string, data: AppointmentData): string {
    let message = template;

    // Substituir variáveis
    message = message.replace(/\{\{paciente_nome\}\}/gi, data.patientName || '');
    message = message.replace(/\{\{paciente_cpf\}\}/gi, this.formatCPF(data.patientCpf) || '');
    message = message.replace(/\{\{medico_nome\}\}/gi, data.doctorName || '');
    message = message.replace(/\{\{especialidade\}\}/gi, data.specialty || '');
    message = message.replace(/\{\{data\}\}/gi, this.formatDate(data.date) || '');
    message = message.replace(/\{\{hora\}\}/gi, data.time || '');
    message = message.replace(/\{\{convenio\}\}/gi, data.convenio || '');
    message = message.replace(/\{\{observacoes\}\}/gi, data.observations || '');
    message = message.replace(/\{\{clinica_nome\}\}/gi, data.clinicName || '');
    message = message.replace(/\{\{local\}\}/gi, data.location || data.clinicName || '');
    message = message.replace(/\{\{profissional\}\}/gi, data.professional || data.doctorName || '');
    message = message.replace(/\{\{link_documentos\}\}/gi, data.documentsLink || '');

    return message.trim();
  }

  /**
   * Formata CPF: 12345678900 -> 123.456.789-00
   */
  static formatCPF(cpf?: string | null): string {
    if (!cpf) return '';
    const digits = cpf.replace(/\D/g, '');
    if (digits.length !== 11) return cpf;
    return digits.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
  }

  /**
   * Formata data: 2026-03-18 -> 18/03/2026 (Terça-feira)
   */
  static formatDate(date?: string | null): string {
    if (!date) return '';
    try {
      const d = dayjs(date);
      const weekday = d.format('dddd');
      const formatted = d.format('DD/MM/YYYY');
      return `${formatted} (${weekday.charAt(0).toUpperCase() + weekday.slice(1)})`;
    } catch {
      return date;
    }
  }

  /**
   * Retorna lista de variáveis disponíveis
   */
  static getAvailableVariables(): Array<{ key: string; description: string }> {
    return [
      { key: '{{paciente_nome}}', description: 'Nome do paciente' },
      { key: '{{paciente_cpf}}', description: 'CPF do paciente' },
      { key: '{{medico_nome}}', description: 'Nome do médico/profissional' },
      { key: '{{especialidade}}', description: 'Especialidade ou procedimento' },
      { key: '{{data}}', description: 'Data do agendamento' },
      { key: '{{hora}}', description: 'Hora do agendamento' },
      { key: '{{convenio}}', description: 'Convênio' },
      { key: '{{observacoes}}', description: 'Observações adicionais' },
      { key: '{{clinica_nome}}', description: 'Nome da clínica/filial' },
      { key: '{{local}}', description: 'Local do atendimento' },
      { key: '{{profissional}}', description: 'Profissional responsável' },
      { key: '{{link_documentos}}', description: 'Link para envio de documentos' },
    ];
  }

  /**
   * Extrai os valores das variáveis do template na ordem em que aparecem.
   * Usado para montar os params do HSM template ({{1}}, {{2}}, ...).
   */
  static extractTemplateParams(template: string, data: AppointmentData): string[] {
    const regex = /\{\{([^}]+)\}\}/gi;
    const params: string[] = [];
    let match;
    while ((match = regex.exec(template)) !== null) {
      const key = match[1].toLowerCase().trim();
      let value = '';
      switch (key) {
        case 'paciente_nome': value = data.patientName || ''; break;
        case 'paciente_cpf': value = data.patientCpf || ''; break;
        case 'medico_nome': value = data.doctorName || ''; break;
        case 'especialidade': value = data.specialty || ''; break;
        case 'data': value = WhatsAppMessageBuilder.formatDate(data.date) || ''; break;
        case 'hora': value = data.time || ''; break;
        case 'convenio': value = data.convenio || ''; break;
        case 'observacoes': value = data.observations || ''; break;
        case 'clinica_nome': value = data.clinicName || ''; break;
        case 'local': value = data.location || data.clinicName || ''; break;
        case 'profissional': value = data.professional || data.doctorName || ''; break;
        case 'link_documentos': value = data.documentsLink || ''; break;
      }
      params.push(value);
    }
    return params;
  }

  /**
   * Valida se o template contém variáveis válidas
   */
  static validateTemplate(template: string): { valid: boolean; invalidVariables: string[] } {
    const validVariables = this.getAvailableVariables().map(v => v.key.toLowerCase());
    const foundVariables = template.match(/\{\{[^}]+\}\}/g) || [];
    
    const invalidVariables = foundVariables.filter(
      variable => !validVariables.includes(variable.toLowerCase())
    );

    return {
      valid: invalidVariables.length === 0,
      invalidVariables,
    };
  }
}

export default WhatsAppMessageBuilder;
