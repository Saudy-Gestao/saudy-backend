import { describe, expect, it } from 'vitest';
import WhatsAppMessageBuilder from '../../src/modules/care/lib/whatsapp-message-builder';

describe('WhatsAppMessageBuilder', () => {
  it('builds messages replacing known placeholders', () => {
    const message = WhatsAppMessageBuilder.buildMessage(
      'Oi {{paciente_nome}}, sua consulta e em {{data}} as {{hora}} com {{medico_nome}}.',
      {
        patientName: 'Maria',
        date: '2026-03-18',
        time: '10:30',
        doctorName: 'Dr. Joao',
      },
    );

    expect(message).toContain('Maria');
    expect(message).toContain('10:30');
    expect(message).toContain('Dr. Joao');
    expect(message).toContain('18/03/2026');
  });

  it('formats cpf and keeps invalid cpf unchanged', () => {
    expect(WhatsAppMessageBuilder.formatCPF('52998224725')).toBe('529.982.247-25');
    expect(WhatsAppMessageBuilder.formatCPF('abc')).toBe('abc');
  });

  it('extracts template params in order of placeholders', () => {
    const params = WhatsAppMessageBuilder.extractTemplateParams(
      '{{paciente_nome}}|{{hora}}|{{local}}',
      {
        patientName: 'Lucas',
        time: '09:00',
        clinicName: 'Unidade Centro',
      },
    );

    expect(params).toEqual(['Lucas', '09:00', 'Unidade Centro']);
  });

  it('validates template variables', () => {
    const valid = WhatsAppMessageBuilder.validateTemplate('Ola {{paciente_nome}}');
    const invalid = WhatsAppMessageBuilder.validateTemplate('Ola {{foo_bar}}');

    expect(valid.valid).toBe(true);
    expect(valid.invalidVariables).toEqual([]);
    expect(invalid.valid).toBe(false);
    expect(invalid.invalidVariables).toEqual(['{{foo_bar}}']);
  });

  it('uses fallback values for local and professional placeholders', () => {
    const message = WhatsAppMessageBuilder.buildMessage(
      'Local: {{local}} | Profissional: {{profissional}}',
      {
        clinicName: 'Unidade Centro',
        doctorName: 'Dra. Ana',
      },
    );

    expect(message).toContain('Local: Unidade Centro');
    expect(message).toContain('Profissional: Dra. Ana');
  });

  it('returns available template variables list', () => {
    const variables = WhatsAppMessageBuilder.getAvailableVariables();

    expect(variables.length).toBeGreaterThan(5);
    expect(variables.some((item) => item.key === '{{link_documentos}}')).toBe(true);
  });

  it('extracts empty value for unknown template placeholder', () => {
    const params = WhatsAppMessageBuilder.extractTemplateParams(
      '{{paciente_nome}}|{{nao_existe}}|{{local}}',
      {
        patientName: 'Joana',
        clinicName: 'Filial Norte',
      },
    );

    expect(params).toEqual(['Joana', '', 'Filial Norte']);
  });

  it('returns empty values for missing cpf/date and no placeholders', () => {
    expect(WhatsAppMessageBuilder.formatCPF(null)).toBe('');
    expect(WhatsAppMessageBuilder.formatDate(undefined)).toBe('');
    expect(WhatsAppMessageBuilder.extractTemplateParams('Mensagem sem variaveis', {})).toEqual([]);
  });

  it('extracts all supported placeholders including fallback chains', () => {
    const params = WhatsAppMessageBuilder.extractTemplateParams(
      '{{paciente_nome}}|{{paciente_cpf}}|{{medico_nome}}|{{especialidade}}|{{data}}|{{hora}}|{{convenio}}|{{observacoes}}|{{clinica_nome}}|{{local}}|{{profissional}}|{{link_documentos}}',
      {
        patientName: 'Bruna',
        patientCpf: '52998224725',
        doctorName: 'Dr. Carlos',
        specialty: 'Dermatologia',
        date: '2026-03-18',
        time: '14:15',
        convenio: 'Particular',
        observations: 'Trazer exames',
        clinicName: 'Filial Sul',
        documentsLink: 'https://example.com/docs',
      },
    );

    expect(params[0]).toBe('Bruna');
    expect(params[1]).toBe('52998224725');
    expect(params[2]).toBe('Dr. Carlos');
    expect(params[3]).toBe('Dermatologia');
    expect(params[4]).toContain('18/03/2026');
    expect(params[5]).toBe('14:15');
    expect(params[6]).toBe('Particular');
    expect(params[7]).toBe('Trazer exames');
    expect(params[8]).toBe('Filial Sul');
    expect(params[9]).toBe('Filial Sul');
    expect(params[10]).toBe('Dr. Carlos');
    expect(params[11]).toBe('https://example.com/docs');
  });

  it('supports case-insensitive variable validation and reports none on plain text', () => {
    const upper = WhatsAppMessageBuilder.validateTemplate('Ola {{PACIENTE_NOME}} {{DATA}}');
    const plain = WhatsAppMessageBuilder.validateTemplate('Texto sem placeholders');

    expect(upper.valid).toBe(true);
    expect(upper.invalidVariables).toEqual([]);
    expect(plain.valid).toBe(true);
    expect(plain.invalidVariables).toEqual([]);
  });

  it('builds and extracts explicit placeholder values without using fallbacks', () => {
    const template = '  CPF {{paciente_cpf}} | Esp {{especialidade}} | Conv {{convenio}} | Obs {{observacoes}} | Clinica {{clinica_nome}} | Local {{local}} | Prof {{profissional}} | Docs {{link_documentos}}  ';
    const data = {
      patientCpf: '52998224725',
      specialty: 'Neuropediatria',
      convenio: 'Plano Azul',
      observations: 'Levar laudos',
      clinicName: 'Unidade Sul',
      location: 'Sala 3',
      professional: 'Terapeuta Paula',
      documentsLink: 'https://example.com/upload',
    };

    const message = WhatsAppMessageBuilder.buildMessage(template, data);
    const params = WhatsAppMessageBuilder.extractTemplateParams(template, data);

    expect(message).toBe('CPF 529.982.247-25 | Esp Neuropediatria | Conv Plano Azul | Obs Levar laudos | Clinica Unidade Sul | Local Sala 3 | Prof Terapeuta Paula | Docs https://example.com/upload');
    expect(params).toEqual([
      '52998224725',
      'Neuropediatria',
      'Plano Azul',
      'Levar laudos',
      'Unidade Sul',
      'Sala 3',
      'Terapeuta Paula',
      'https://example.com/upload',
    ]);
  });

  it('builds and extracts empty values when placeholders have no backing data', () => {
    const template = '{{paciente_nome}}|{{paciente_cpf}}|{{medico_nome}}|{{especialidade}}|{{data}}|{{hora}}|{{convenio}}|{{observacoes}}|{{clinica_nome}}|{{local}}|{{profissional}}|{{link_documentos}}';

    const message = WhatsAppMessageBuilder.buildMessage(template, {});
    const params = WhatsAppMessageBuilder.extractTemplateParams(template, {});

    expect(message).toBe('|||||||||||');
    expect(params).toEqual(['', '', '', '', '', '', '', '', '', '', '', '']);
  });
});
