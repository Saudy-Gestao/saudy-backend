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
    label: 'Cadastro de Médico',
    description: 'Registro de médicos',
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
  }
];

const defaultAccessTemplates = [
  {
    description: 'Administrador Clínico',
    moduleNames: [
      'pre-atendimento', 'agendamento', 'pre-agendamento',
      'consulta', 'execucao-exames', 'laudo', 'autorizacao-convenio',
      'entrega', 'estoque', 'financeiro', 'faturamento', 'bi-gestao', 'whatsapp-config', 'conversas',
      'cadastro-medico', 'cadastro-procedimento', 'cadastro-convenio', 'cadastro-paciente',
      'cadastro-sala', 'cadastro-equipamento', 'cadastro-anamnese', 'cadastro-enfermagem',
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
      'estoque', 'entrega', 'cadastro-procedimento', 'cadastro-sala', 'cadastro-equipamento',
    ],
  },
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
  runSeed,
  runCliSeed,
};
