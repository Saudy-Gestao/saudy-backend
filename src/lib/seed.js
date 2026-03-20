require('dotenv/config');
const { PrismaPg } = require('@prisma/adapter-pg');
const { Pool } = require('pg');
// Use require for PrismaClient to match original seed.ts
const { PrismaClient } = require('@prisma/client');

const isSslEnabled = process.env.DATABASE_SSL === 'true';
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || '',
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
    name: 'anamnese',
    label: 'Anamnese',
    description: 'Histórico médico',
    icon: 'ClipboardList',
    category: 'fluxo-paciente',
  },
  {
    name: 'enfermagem',
    label: 'Enfermagem',
    description: 'Triagem e sinais vitais',
    icon: 'Heart',
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
    name: 'laudo',
    label: 'Laudo',
    description: 'Emissão de laudos',
    icon: 'FileText',
    category: 'suporte-clinico',
  },
  {
    name: 'envelopamento',
    label: 'Envelopamento',
    description: 'Preparação de documentos',
    icon: 'Mail',
    category: 'suporte-clinico',
  },
  {
    name: 'documentos',
    label: 'Documentos',
    description: 'Gestão documental',
    icon: 'Folder',
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
    name: 'whatsapp-config',
    label: 'WhatsApp',
    description: 'Configurações de WhatsApp e notificações',
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
  }
];

async function main() {
  console.log('🌱 Starting seed...');

  // Create modules
  console.log('📦 Creating modules...');
  for (const module of modules) {
    await prisma.module.upsert({
      where: { name: module.name },
      update: module,
      create: module,
    });
    console.log(`  ✓ ${module.label}`);
  }

  console.log('✅ Seed completed!');
}

main()
  .catch((e) => {
    console.error('❌ Seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
