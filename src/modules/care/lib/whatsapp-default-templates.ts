export const ACTIVE_TEMPLATE_TYPES = [
  'APPOINTMENT_CREATED',
  'APPOINTMENT_CONFIRMATION',
  'NO_SHOW',
  'CONFIRMATION_REPLY_CONFIRMED',
  'CONFIRMATION_REPLY_RESCHEDULE',
] as const;

export const DEFAULT_TEMPLATES = [
  {
    type: 'APPOINTMENT_CREATED',
    name: 'Resumo de Agendamento',
    hsmTemplateName: 'resumo_agendamento_uuid',
    message: 'Olá, {{paciente_nome}}! 😊\nSomos da {{clinica_nome}}.\nSeu atendimento está confirmado:\n📅 {{data}} às {{hora}}\n👩‍⚕️ {{profissional}}\n📍 {{local}}\n📎 Para agilizar seu atendimento, pedimos que envie seus documentos pelo link abaixo:\n👉 {{link_documentos}}\nEm caso de necessidade, fale conosco por aqui.',
  },
  {
    type: 'APPOINTMENT_CONFIRMATION',
    name: 'Confirmação de Agendamento',
    hsmTemplateName: 'confirmacao_agendamento_uuid',
    message: 'Olá, {{paciente_nome}}! 😊\nSomos da {{clinica_nome}}.\nEstamos entrando em contato para confirmar seu agendamento:\n📅 Data: {{data}}\n⏰ Horário: {{hora}}\n👩‍⚕️ Profissional: {{profissional}}\n📍 Local: {{local}}\nPor favor, escolha uma das opções abaixo:\n✅ Confirmar\n❌ Reagendar\nFicamos no aguardo.',
  },
  {
    type: 'CONFIRMATION_REPLY_CONFIRMED',
    name: 'Resposta Confirmado',
    hsmTemplateName: 'resposta_confirmado_uuid',
    message: '✅ Agendamento confirmado com sucesso!\n📅 {{data}}\n⏰ {{hora}}\n👩‍⚕️ {{profissional}}\nQualquer imprevisto, fale conosco por este canal.\nAté breve! 💙',
  },
  {
    type: 'CONFIRMATION_REPLY_RESCHEDULE',
    name: 'Resposta Reagendar',
    hsmTemplateName: 'resposta_reagendar_uuid',
    message: 'Em breve um atendente entrará em contato para realizar seu reagendamento.',
  },
  {
    type: 'NO_SHOW',
    name: 'Falta',
    hsmTemplateName: 'falta_agendamento_uuid',
    message: 'Olá, {{paciente_nome}}.\nSomos da {{clinica_nome}}.\nNotamos que você não apareceu para o seu agendamento:\n📅 {{data}} às {{hora}}\n👩‍⚕️ {{profissional}}\n📍 {{local}}\nCaso tenha ocorrido algum imprevisto, pedimos que nos informe por aqui.',
  },
] as const;
