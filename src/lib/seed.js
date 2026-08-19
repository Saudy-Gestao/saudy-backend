require('dotenv/config');
const { PrismaPg } = require('@prisma/adapter-pg');
const { Pool } = require('pg');
// Use require for PrismaClient to match original seed.ts
const { PrismaClient } = require('@prisma/client');

const isSslEnabled = process.env.DATABASE_SSL === 'true';
const pool = new Pool({
  /* v8 ignore next */
  connectionString: process.env.DATABASE_URL || '',
  /* v8 ignore next */
  ssl: isSslEnabled ? { rejectUnauthorized: false } : undefined,
});
const adapter = new PrismaPg(pool);

const prisma = new PrismaClient({ adapter });

const modules = [
  // Fluxo do Paciente
  {
    name: 'pre-atendimento',
    label: 'Pré-atendimento',
    description: 'Recepção e cadastro de pacientes',
    icon: 'UserPlus',
    category: 'fluxo-paciente',
  },
  {
    name: 'agendamento',
    label: 'Agendamento',
    description: 'Consultas e exames',
    icon: 'Calendar',
    category: 'fluxo-paciente',
  },
  {
    name: 'pre-agendamento',
    label: 'Pré-agendamento',
    description: 'Pré-autorização e documentos antes da recepção',
    icon: 'CalendarCheck',
    category: 'fluxo-paciente',
  },
  
  // Suporte Clínico
  {
    name: 'consulta',
    label: 'Consulta',
    description: 'Atendimento médico',
    icon: 'Stethoscope',
    category: 'suporte-clinico',
  },
  {
    name: 'execucao-exames',
    label: 'Execução de Exames',
    description: 'Triagem e andamento operacional dos exames',
    icon: 'ClipboardCheck',
    category: 'suporte-clinico',
  },
  {
    name: 'laudo',
    label: 'Laudo',
    description: 'Emissão de laudos',
    icon: 'FileText',
    category: 'suporte-clinico',
  },
  {
    name: 'modulo-tea',
    label: 'Módulo TEA',
    description: 'Cadastro e acompanhamento TEA',
    icon: 'Brain',
    category: 'suporte-clinico',
  },
  {
    name: 'autorizacao-convenio',
    label: 'Autorização Convênio',
    description: 'Gestão de autorizações de convênio',
    icon: 'ShieldCheck',
    category: 'suporte-clinico',
  },
  
  // Administrativo
  {
    name: 'entrega',
    label: 'Entrega',
    description: 'Controle de entregas',
    icon: 'Package',
    category: 'administrativo',
  },
  {
    name: 'estoque',
    label: 'Estoque',
    description: 'Materiais e insumos',
    icon: 'Archive',
    category: 'administrativo',
  },
  {
    name: 'financeiro',
    label: 'Financeiro',
    description: 'Gestão financeira',
    icon: 'DollarSign',
    category: 'administrativo',
  },
  {
    name: 'faturamento',
    label: 'Faturamento',
    description: 'Cobranças e NFs',
    icon: 'Receipt',
    category: 'administrativo',
  },
  {
    name: 'bi-gestao',
    label: 'BI Gestão',
    description: 'Indicadores executivos da clínica',
    icon: 'BarChart3',
    category: 'administrativo',
  },
  {
    name: 'whatsapp-config',
    label: 'WhatsApp',
    description: 'Configurações de WhatsApp e notificações',
    icon: 'MessageCircle',
    category: 'administrativo',
  },
  {
    name: 'conversas',
    label: 'Conversas',
    description: 'Atendimento humanizado do WhatsApp',
    icon: 'MessageCircle',
    category: 'administrativo',
  },
  // Cadastros
  {
    name: 'cadastro-medico',
    label: 'Cadastro de Profissional',
    description: 'Registro de profissionais',
    icon: 'UserPlus',
    category: 'cadastros',
  },
  {
    name: 'cadastro-procedimento',
    label: 'Cadastro de Procedimentos',
    description: 'Procedimentos e modalidades',
    icon: 'ClipboardList',
    category: 'cadastros',
  },
  {
    name: 'cadastro-convenio',
    label: 'Cadastro de Convênio',
    description: 'Convênios aceitos',
    icon: 'FileText',
    category: 'cadastros',
  },
  {
    name: 'cadastro-paciente',
    label: 'Cadastro de Paciente',
    description: 'Registro de pacientes',
    icon: 'UserPlus',
    category: 'cadastros',
  },
  {
    name: 'cadastro-sala',
    label: 'Cadastro de Salas',
    description: 'Salas por filial',
    icon: 'Warehouse',
    category: 'cadastros',
  },
  {
    name: 'cadastro-equipamento',
    label: 'Cadastro de Equipamentos',
    description: 'Equipamentos médicos com integração DICOM',
    icon: 'ScanLine',
    category: 'cadastros',
  },
  {
    name: 'cadastro-modalidade',
    label: 'Cadastro de Modalidades',
    description: 'Tipos de exame (Tomografia, RM, US...)',
    icon: 'Tag',
    category: 'cadastros',
  },
  {
    name: 'cadastro-especialidade',
    label: 'Cadastro de Especialidades',
    description: 'Especialidades e métodos por modalidade',
    icon: 'Layers3',
    category: 'cadastros',
  },
  {
    name: 'cadastro-anamnese',
    label: 'Cadastro de Anamnese',
    description: 'Perguntas de anamnese por procedimento',
    icon: 'ClipboardPenLine',
    category: 'cadastros',
  },
  {
    name: 'cadastro-enfermagem',
    label: 'Cadastro de Enfermagem',
    description: 'Triagens e preparos por procedimento',
    icon: 'ClipboardCheck',
    category: 'cadastros',
  },

  // Sistema
  {
    name: 'configuracoes',
    label: 'Configurações',
    description: 'Gestão de setores, acessos, filiais e configurações da empresa',
    icon: 'Settings',
    category: 'sistema',
  },
];

const defaultAccessTemplates = [
  {
    description: 'Administrador Clínico',
    moduleNames: [
      'pre-atendimento', 'agendamento', 'pre-agendamento',
      'consulta', 'execucao-exames', 'laudo', 'autorizacao-convenio',
      'entrega', 'estoque', 'financeiro', 'faturamento', 'bi-gestao', 'whatsapp-config', 'conversas',
      'cadastro-medico', 'cadastro-procedimento', 'cadastro-convenio', 'cadastro-paciente',
      'cadastro-sala', 'cadastro-equipamento', 'cadastro-modalidade', 'cadastro-especialidade', 'cadastro-anamnese', 'cadastro-enfermagem',
      'configuracoes',
    ],
  },
  {
    description: 'Recepcionista',
    moduleNames: [
      'agendamento', 'pre-agendamento', 'pre-atendimento',
      'cadastro-paciente', 'conversas',
    ],
  },
  {
    description: 'Médico / Profissional de Saúde',
    moduleNames: [
      'consulta', 'laudo', 'autorizacao-convenio',
      'cadastro-paciente', 'cadastro-anamnese',
    ],
  },
  {
    description: 'Técnico / Executante de Exames',
    moduleNames: [
      'execucao-exames', 'laudo', 'cadastro-paciente',
    ],
  },
  {
    description: 'Financeiro',
    moduleNames: [
      'financeiro', 'faturamento', 'bi-gestao', 'estoque', 'cadastro-convenio',
    ],
  },
  {
    description: 'Atendente / Suporte',
    moduleNames: [
      'conversas', 'whatsapp-config', 'cadastro-paciente', 'agendamento',
    ],
  },
  {
    description: 'Auxiliar Administrativo',
    moduleNames: [
      'estoque', 'entrega', 'cadastro-procedimento', 'cadastro-sala', 'cadastro-equipamento', 'cadastro-modalidade', 'cadastro-especialidade',
    ],
  },
];

// Catálogo de ocupações CBO 2002 (área da saúde), extraído da lista oficial do MTE.
const cbos = [
  { code: "2211-05", title: "Biólogo" },
  { code: "2212-05", title: "Biomédico" },
  { code: "2232-04", title: "Cirurgião dentista - auditor" },
  { code: "2232-08", title: "Cirurgião dentista - clínico geral" },
  { code: "2232-12", title: "Cirurgião dentista - endodontista" },
  { code: "2232-16", title: "Cirurgião dentista - epidemiologista" },
  { code: "2232-20", title: "Cirurgião dentista - estomatologista" },
  { code: "2232-24", title: "Cirurgião dentista - implantodontista" },
  { code: "2232-28", title: "Cirurgião dentista - odontogeriatra" },
  { code: "2232-32", title: "Cirurgião dentista - odontologista legal" },
  { code: "2232-36", title: "Cirurgião dentista - odontopediatra" },
  { code: "2232-40", title: "Cirurgião dentista - ortopedista e ortodontista" },
  { code: "2232-44", title: "Cirurgião dentista - patologista bucal" },
  { code: "2232-48", title: "Cirurgião dentista - periodontista" },
  { code: "2232-52", title: "Cirurgião dentista - protesiólogo bucomaxilofacial" },
  { code: "2232-56", title: "Cirurgião dentista - protesista" },
  { code: "2232-60", title: "Cirurgião dentista - radiologista" },
  { code: "2232-64", title: "Cirurgião dentista - reabilitador oral" },
  { code: "2232-68", title: "Cirurgião dentista - traumatologista bucomaxilofacial" },
  { code: "2232-76", title: "Cirurgião dentista - odontologia do trabalho" },
  { code: "2232-80", title: "Cirurgião dentista - dentística" },
  { code: "2232-84", title: "Cirurgião dentista - disfunção temporomandibular e dor orofacial" },
  { code: "2232-88", title: "Cirurgião dentista - odontologia para pacientes com necessidades especiais" },
  { code: "2232-93", title: "Cirurgião-dentista da estratégia de saúde da família" },
  { code: "2234-05", title: "Farmacêutico" },
  { code: "2234-15", title: "Farmacêutico analista clínico" },
  { code: "2234-20", title: "Farmacêutico de alimentos" },
  { code: "2234-25", title: "Farmacêutico práticas integrativas e complementares" },
  { code: "2234-30", title: "Farmacêutico em saúde pública" },
  { code: "2234-35", title: "Farmacêutico industrial" },
  { code: "2234-40", title: "Farmacêutico toxicologista" },
  { code: "2234-45", title: "Farmacêutico hospitalar e clínico" },
  { code: "2235-05", title: "Enfermeiro" },
  { code: "2235-10", title: "Enfermeiro auditor" },
  { code: "2235-15", title: "Enfermeiro de bordo" },
  { code: "2235-20", title: "Enfermeiro de centro cirúrgico" },
  { code: "2235-25", title: "Enfermeiro de terapia intensiva" },
  { code: "2235-30", title: "Enfermeiro do trabalho" },
  { code: "2235-35", title: "Enfermeiro nefrologista" },
  { code: "2235-40", title: "Enfermeiro neonatologista" },
  { code: "2235-45", title: "Enfermeiro obstétrico" },
  { code: "2235-50", title: "Enfermeiro psiquiátrico" },
  { code: "2235-55", title: "Enfermeiro puericultor e pediátrico" },
  { code: "2235-60", title: "Enfermeiro sanitarista" },
  { code: "2235-65", title: "Enfermeiro da estratégia de saúde da família" },
  { code: "2235-70", title: "Perfusionista" },
  { code: "2235-75", title: "Obstetriz" },
  { code: "2235-80", title: "Enfermeiro estomaterapeuta" },
  { code: "2235-85", title: "Enfermeiro forense" },
  { code: "2236-05", title: "Fisioterapeuta geral" },
  { code: "2236-25", title: "Fisioterapeuta respiratória" },
  { code: "2236-30", title: "Fisioterapeuta neurofuncional" },
  { code: "2236-35", title: "Fisioterapeuta traumato-ortopédica funcional" },
  { code: "2236-40", title: "Fisioterapeuta osteopata" },
  { code: "2236-45", title: "Fisioterapeuta quiropraxista" },
  { code: "2236-50", title: "Fisioterapeuta acupunturista" },
  { code: "2236-55", title: "Fisioterapeuta esportivo" },
  { code: "2236-60", title: "Fisioterapeuta do trabalho" },
  { code: "2237-05", title: "Dietista" },
  { code: "2237-10", title: "Nutricionista" },
  { code: "2238-10", title: "Fonoaudiólogo geral" },
  { code: "2238-15", title: "Fonoaudiólogo educacional" },
  { code: "2238-20", title: "Fonoaudiólogo em audiologia" },
  { code: "2238-25", title: "Fonoaudiólogo em disfagia" },
  { code: "2238-30", title: "Fonoaudiólogo em linguagem" },
  { code: "2238-35", title: "Fonoaudiólogo em motricidade orofacial" },
  { code: "2238-40", title: "Fonoaudiólogo em saúde coletiva" },
  { code: "2239-05", title: "Terapeuta ocupacional" },
  { code: "2239-10", title: "Ortoptista" },
  { code: "2239-15", title: "Psicomotricista" },
  { code: "2251-03", title: "Médico infectologista" },
  { code: "2251-05", title: "Médico acupunturista" },
  { code: "2251-06", title: "Médico legista" },
  { code: "2251-09", title: "Médico nefrologista" },
  { code: "2251-10", title: "Médico alergista e imunologista" },
  { code: "2251-12", title: "Médico neurologista" },
  { code: "2251-15", title: "Médico angiologista" },
  { code: "2251-18", title: "Médico nutrologista" },
  { code: "2251-20", title: "Médico cardiologista" },
  { code: "2251-21", title: "Médico oncologista clínico" },
  { code: "2251-22", title: "Médico cancerologista pediátrico" },
  { code: "2251-25", title: "Médico clínico" },
  { code: "2251-27", title: "Médico pneumologista" },
  { code: "2251-30", title: "Médico de família e comunidade" },
  { code: "2251-33", title: "Médico psiquiatra" },
  { code: "2251-35", title: "Médico dermatologista" },
  { code: "2251-36", title: "Médico reumatologista" },
  { code: "2251-39", title: "Médico sanitarista" },
  { code: "2251-40", title: "Médico do trabalho" },
  { code: "2251-42", title: "Médico da estratégia de saúde da família" },
  { code: "2251-45", title: "Médico em medicina de tráfego" },
  { code: "2251-48", title: "Médico anatomopatologista" },
  { code: "2251-50", title: "Médico em medicina intensiva" },
  { code: "2251-51", title: "Médico anestesiologista" },
  { code: "2251-54", title: "Médico antroposófico" },
  { code: "2251-55", title: "Médico endocrinologista e metabologista" },
  { code: "2251-60", title: "Médico fisiatra" },
  { code: "2251-65", title: "Médico gastroenterologista" },
  { code: "2251-70", title: "Médico generalista" },
  { code: "2251-75", title: "Médico geneticista" },
  { code: "2251-80", title: "Médico geriatra" },
  { code: "2251-85", title: "Médico hematologista" },
  { code: "2251-95", title: "Médico homeopata" },
  { code: "2252-03", title: "Médico em cirurgia vascular" },
  { code: "2252-10", title: "Médico cirurgião cardiovascular" },
  { code: "2252-15", title: "Médico cirurgião de cabeça e pescoço" },
  { code: "2252-20", title: "Médico cirurgião do aparelho digestivo" },
  { code: "2252-25", title: "Médico cirurgião geral" },
  { code: "2252-30", title: "Médico cirurgião pediátrico" },
  { code: "2252-35", title: "Médico cirurgião plástico" },
  { code: "2252-40", title: "Médico cirurgião torácico" },
  { code: "2252-50", title: "Médico ginecologista e obstetra" },
  { code: "2252-55", title: "Médico mastologista" },
  { code: "2252-60", title: "Médico neurocirurgião" },
  { code: "2252-65", title: "Médico oftalmologista" },
  { code: "2252-70", title: "Médico ortopedista e traumatologista" },
  { code: "2252-75", title: "Médico otorrinolaringologista" },
  { code: "2252-80", title: "Médico coloproctologista" },
  { code: "2252-85", title: "Médico urologista" },
  { code: "2252-90", title: "Médico cancerologista cirurgíco" },
  { code: "2252-95", title: "Médico cirurgião da mão" },
  { code: "2253-10", title: "Médico em endoscopia" },
  { code: "2253-15", title: "Médico em medicina nuclear" },
  { code: "2253-25", title: "Médico patologista" },
  { code: "2253-30", title: "Médico radioterapeuta" },
  { code: "2253-35", title: "Médico patologista clínico / medicina laboratorial" },
  { code: "2253-40", title: "Médico hemoterapeuta" },
  { code: "2253-45", title: "Médico hiperbarista" },
  { code: "2253-50", title: "Médico neurofisiologista clínico" },
  { code: "2253-55", title: "Médico radiologista intervencionista" },
  { code: "2261-05", title: "Quiropraxista" },
  { code: "2261-10", title: "Osteopata" },
  { code: "2263-05", title: "Musicoterapeuta" },
  { code: "2263-10", title: "Arteterapeuta" },
  { code: "2263-15", title: "Equoterapeuta" },
  { code: "2263-20", title: "Naturólogo" },
  { code: "2394-25", title: "Psicopedagogo" },
  { code: "2394-40", title: "Neuropsicopedagogo clinico" },
  { code: "2394-45", title: "Neuropsicopedagogo institucional" },
  { code: "2515-05", title: "Psicólogo educacional" },
  { code: "2515-10", title: "Psicólogo clínico" },
  { code: "2515-15", title: "Psicólogo do esporte" },
  { code: "2515-20", title: "Psicólogo hospitalar" },
  { code: "2515-25", title: "Psicólogo jurídico" },
  { code: "2515-35", title: "Psicólogo do trânsito" },
  { code: "2515-40", title: "Psicólogo do trabalho" },
  { code: "2515-45", title: "Neuropsicólogo" },
  { code: "2515-50", title: "Psicanalista" },
  { code: "2515-55", title: "Psicólogo acupunturista" },
  { code: "2516-05", title: "Assistente social" },
  { code: "3221-05", title: "Técnico em acupuntura" },
  { code: "3221-10", title: "Podólogo" },
  { code: "3221-15", title: "Técnico em quiropraxia" },
  { code: "3221-20", title: "Massoterapeuta" },
  { code: "3221-25", title: "Terapeuta holístico" },
  { code: "3221-30", title: "Esteticista" },
  { code: "3221-35", title: "Doula" },
  { code: "3221-40", title: "Instrutor de pilates" },
  { code: "3222-05", title: "Técnico de enfermagem" },
  { code: "3222-10", title: "Técnico de enfermagem de terapia intensiva" },
  { code: "3222-20", title: "Técnico de enfermagem psiquiátrica" },
  { code: "3222-25", title: "Instrumentador cirúrgico" },
  { code: "3222-30", title: "Auxiliar de enfermagem" },
  { code: "3222-35", title: "Auxiliar de enfermagem do trabalho" },
  { code: "3222-40", title: "Auxiliar de saúde (navegação marítima)" },
  { code: "3222-45", title: "Técnico de enfermagem da estratégia de saúde da família" },
  { code: "3222-50", title: "Auxiliar de enfermagem da estratégia de saúde da família" },
  { code: "3222-55", title: "Técnico em agente comunitário de saúde" },
  { code: "3223-05", title: "Técnico em óptica e optometria" },
  { code: "3224-05", title: "Técnico em saúde bucal" },
  { code: "3224-10", title: "Protético dentário" },
  { code: "3224-15", title: "Auxiliar em saúde bucal" },
  { code: "3224-30", title: "Auxiliar em saúde bucal da estratégia de saúde da família" },
  { code: "3225-05", title: "Técnico de ortopedia" },
  { code: "3226-05", title: "Técnico de imobilização ortopédica" },
  { code: "3241-05", title: "Técnico em métodos eletrográficos em encefalografia" },
  { code: "3241-10", title: "Técnico em métodos gráficos em cardiologia" },
  { code: "3241-15", title: "Técnico em radiologia e imagenologia" },
  { code: "3241-20", title: "Tecnólogo em radiologia" },
  { code: "3241-25", title: "Tecnólogo oftálmico" },
  { code: "3241-30", title: "Técnico em espirometria" },
  { code: "3241-35", title: "Técnico em polissonografia" },
  { code: "3241-40", title: "Dosimetrista clínico" },
  { code: "3242-05", title: "Técnico em patologia clínica" },
  { code: "3242-15", title: "Citotécnico" },
  { code: "3242-20", title: "Técnico em hemoterapia" },
  { code: "5151-05", title: "Agente comunitário de saúde" },
  { code: "5151-10", title: "Atendente de enfermagem" },
  { code: "5151-15", title: "Parteira leiga" },
  { code: "5151-20", title: "Visitador sanitário" },
  { code: "5151-25", title: "Agente indígena de saúde" },
  { code: "5151-30", title: "Agente indígena de saneamento" },
  { code: "5151-35", title: "Socorrista (exceto médicos e enfermeiros)" },
  { code: "5151-40", title: "Agente de combate às endemias" },
  { code: "5152-05", title: "Auxiliar de banco de sangue" },
  { code: "5152-10", title: "Auxiliar de farmácia de manipulação" },
  { code: "5152-15", title: "Auxiliar de laboratório de análises clínicas" },
  { code: "5152-20", title: "Auxiliar de laboratório de imunobiológicos" },
  { code: "5152-25", title: "Auxiliar de produção farmacêutica" },

];

async function runSeed({ client = prisma, logger = console } = {}) {
  logger.log('🌱 Starting seed...');

  // Create modules
  logger.log('📦 Creating modules...');
  for (const module of modules) {
    await client.module.upsert({
      where: { name: module.name },
      update: module,
      create: module,
    });
    logger.log(`  ✓ ${module.label}`);
  }

  // Remove módulos descontinuados para não aparecerem em permissões/acessos.
  const removedCount = await client.module.deleteMany({
    where: {
      name: {
        in: ['envelopamento', 'documentos'],
      },
    },
  });
  if (removedCount.count > 0) {
    logger.log(`  ✓ ${removedCount.count} módulo(s) descontinuado(s) removido(s) do catálogo`);
  }

  // Create CBO catalog (área da saúde)
  logger.log('🩺 Creating CBO catalog...');
  for (const cbo of cbos) {
    await client.cbo.upsert({
      where: { code: cbo.code },
      update: { title: cbo.title },
      create: cbo,
    });
  }
  logger.log(`  ✓ ${cbos.length} ocupações CBO`);

  // Create default access templates
  logger.log('🔐 Creating default access templates...');
  for (const template of defaultAccessTemplates) {
    const moduleRecords = await client.module.findMany({
      where: { name: { in: template.moduleNames } },
    });

    const existing = await client.access.findFirst({
      where: { description: template.description, isTemplate: true },
    });

    if (existing) {
      await client.access.update({
        where: { id: existing.id },
        data: {
          modules: { set: moduleRecords.map((m) => ({ id: m.id })) },
        },
      });
    } else {
      await client.access.create({
        data: {
          description: template.description,
          isTemplate: true,
          modules: { connect: moduleRecords.map((m) => ({ id: m.id })) },
        },
      });
    }
    logger.log(`  ✓ ${template.description}`);
  }

  logger.log('✅ Seed completed!');
}

async function runCliSeed() {
  await runSeed({ client: prisma, logger: console });
}

/* v8 ignore start */
if (require.main === module) {
  runCliSeed()
    .catch((e) => {
      console.error('❌ Seed failed:', e);
      process.exit(1);
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
/* v8 ignore stop */

module.exports = {
  modules,
  cbos,
  runSeed,
  runCliSeed,
};
