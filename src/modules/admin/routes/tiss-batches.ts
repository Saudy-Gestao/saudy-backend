import { FastifyInstance } from 'fastify';
import prisma from '../lib/prisma';

const tissBatchStatusValues = ['DRAFT', 'GENERATED', 'SENT', 'ACCEPTED', 'REJECTED', 'CLOSED'] as const;
const tissReturnStatusValues = ['ACCEPTED', 'PARTIAL', 'REJECTED'] as const;

const sanitizeText = (value?: string | null) => String(value || '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&apos;');

const toTwoDecimals = (value: unknown) => Number(value || 0).toFixed(2);
const onlyDigits = (value?: string | null) => String(value || '').replace(/\D/g, '');
const toMoneyNumber = (value: unknown) => {
  const numeric = Number(value || 0);
  return Number.isFinite(numeric) ? numeric : 0;
};
const roundMoney = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;

const calculateGuideFinancials = (invoice: any) => {
  const procedureTotal = Array.isArray(invoice?.procedureItems)
    ? invoice.procedureItems.reduce((sum: number, procedure: any) => sum + toMoneyNumber(procedure?.totalValue), 0)
    : 0;

  const packageValue = toMoneyNumber(invoice?.packageValue);
  const materialsValue = toMoneyNumber(invoice?.materialsValue);
  const feesValue = toMoneyNumber(invoice?.feesValue);
  const dailyValue = toMoneyNumber(invoice?.dailyValue);
  const gasesValue = toMoneyNumber(invoice?.gasesValue);
  const opmeValue = toMoneyNumber(invoice?.opmeValue);
  const compositionTotal = packageValue + materialsValue + feesValue + dailyValue + gasesValue + opmeValue;

  const commercialDiscount = toMoneyNumber(invoice?.discount);
  const expectedDiscountValue = toMoneyNumber(invoice?.expectedDiscountValue);
  const expectedGlosaValue = toMoneyNumber(invoice?.expectedGlosaValue);
  const totalDiscounts = commercialDiscount + expectedDiscountValue + expectedGlosaValue;

  const calculatedGuideTotal = roundMoney(procedureTotal + compositionTotal - totalDiscounts);
  const storedTotal = roundMoney(toMoneyNumber(invoice?.total));

  return {
    procedureTotal: roundMoney(procedureTotal),
    compositionTotal: roundMoney(compositionTotal),
    packageValue: roundMoney(packageValue),
    materialsValue: roundMoney(materialsValue),
    feesValue: roundMoney(feesValue),
    dailyValue: roundMoney(dailyValue),
    gasesValue: roundMoney(gasesValue),
    opmeValue: roundMoney(opmeValue),
    commercialDiscount: roundMoney(commercialDiscount),
    expectedDiscountValue: roundMoney(expectedDiscountValue),
    expectedGlosaValue: roundMoney(expectedGlosaValue),
    calculatedGuideTotal,
    storedTotal,
    difference: roundMoney(storedTotal - calculatedGuideTotal),
    isValid: Math.abs(storedTotal - calculatedGuideTotal) <= 0.01,
  };
};

const isValidCompetence = (value: string) => /^\d{4}-(0[1-9]|1[0-2])$/.test(value);

const normalizeStatus = (value: unknown) => {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toUpperCase();
  return tissBatchStatusValues.includes(normalized as (typeof tissBatchStatusValues)[number])
    ? normalized as (typeof tissBatchStatusValues)[number]
    : null;
};

const normalizeReturnStatus = (value: unknown) => {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toUpperCase();
  return tissReturnStatusValues.includes(normalized as (typeof tissReturnStatusValues)[number])
    ? normalized as (typeof tissReturnStatusValues)[number]
    : null;
};

const resolveBatchStatusFromItems = (items: any[]) => {
  const activeItems = (items || []).filter((item: any) => item?.isActive !== false);
  if (!activeItems.length) return 'DRAFT' as (typeof tissBatchStatusValues)[number];
  const returnStatuses = activeItems
    .map((item: any) => normalizeReturnStatus(item?.returnStatus))
    .filter(Boolean) as string[];

  if (!returnStatuses.length) return 'SENT' as (typeof tissBatchStatusValues)[number];
  if (returnStatuses.every((status) => status === 'ACCEPTED')) return 'ACCEPTED' as (typeof tissBatchStatusValues)[number];
  if (returnStatuses.some((status) => status === 'REJECTED' || status === 'PARTIAL')) return 'REJECTED' as (typeof tissBatchStatusValues)[number];
  return 'SENT' as (typeof tissBatchStatusValues)[number];
};

const generateBatchNumber = () => {
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const rnd = Math.floor(Math.random() * 9000 + 1000);
  return `TISS-${yyyy}${mm}-${rnd}`;
};

const generateGuideNumber = (invoiceNumber: string, index: number) => {
  const suffix = String(index + 1).padStart(3, '0');
  return `GUIA-${invoiceNumber}-${suffix}`.slice(0, 48);
};

const getLoggedBranchId = async (request: any) => {
  const userId = (request.user as any)?.id;
  if (!userId) return null;
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { sector: { include: { branch: true } } },
  });
  return user?.sector?.branch?.id || null;
};

const resolveInsuranceTissConfig = async (branchId: string, convention: string) => {
  const normalizedConvention = String(convention || '').trim();
  if (!normalizedConvention) return null;

  const insurance = await prisma.insurance.findFirst({
    where: {
      name: { equals: normalizedConvention, mode: 'insensitive' },
      isActive: true,
      OR: [
        { branchId },
        { branchId: null },
        { branchId: '' },
      ],
    },
    orderBy: [
      { branchId: 'desc' },
      { updatedAt: 'desc' },
    ],
  });

  if (!insurance) return null;
  return {
    registroAns: insurance.tissRegistroAns,
    operadoraCnpj: insurance.tissOperadoraCnpj,
    versaoTiss: insurance.tissVersao,
    prestadorCnpj: insurance.tissPrestadorCnpj,
    prestadorCnes: insurance.tissPrestadorCnes,
    codigoPrestadorOperadora: insurance.tissCodigoPrestadorOperadora,
  };
};

const getMissingTissConfigFields = (config: any) => {
  const missing: string[] = [];
  if (!String(config?.registroAns || '').trim()) missing.push('registroANS da operadora');
  if (!String(config?.operadoraCnpj || '').trim()) missing.push('CNPJ da operadora');
  if (!String(config?.versaoTiss || '').trim()) missing.push('versao TISS');
  if (!String(config?.prestadorCnpj || '').trim()) missing.push('CNPJ do prestador executante');
  if (!String(config?.prestadorCnes || '').trim()) missing.push('CNES do prestador executante');
  if (!String(config?.codigoPrestadorOperadora || '').trim()) missing.push('codigo do prestador na operadora');
  return missing;
};

const pad = (value: number) => String(value).padStart(2, '0');

const formatDate = (value: Date) => `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
const formatTime = (value: Date) => `${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}`;

const competenceStartEnd = (competenceMonth: string) => {
  const [yearRaw, monthRaw] = String(competenceMonth || '').split('-');
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) return null;
  const start = new Date(Date.UTC(year, month - 1, 1, 12, 0, 0));
  const end = new Date(Date.UTC(year, month, 0, 12, 0, 0));
  return { start, end };
};

function buildTissBatchXml(batch: any) {
  const now = new Date();
  const generatedAtIso = now.toISOString();
  const generatedDate = formatDate(now);
  const generatedTime = formatTime(now);
  const totalValue = (batch.items || []).reduce((sum: number, item: any) => sum + Number(item?.invoice?.total || 0), 0);
  const batchNumberNumeric = String(batch.batchNumber || '').replace(/\D/g, '').slice(0, 12) || String(Date.now()).slice(-12);
  const registryAns = sanitizeText(batch?.tissConfig?.registroAns || '000000');
  const cnpjPrestador = sanitizeText(onlyDigits(batch?.tissConfig?.prestadorCnpj) || '00000000000000');
  const cnesPrestador = sanitizeText(batch?.tissConfig?.prestadorCnes || '0000000');
  const cnpjOperadora = sanitizeText(onlyDigits(batch?.tissConfig?.operadoraCnpj) || '00000000000000');
  const registroOperadora = sanitizeText(batch?.tissConfig?.registroAns || registryAns);
  const versaoPadrao = sanitizeText(batch?.tissConfig?.versaoTiss || '3.05.00');
  const codigoPrestadorOperadora = sanitizeText(batch?.tissConfig?.codigoPrestadorOperadora || cnesPrestador);
  const sequencialTransacao = String(Date.now()).slice(-12);
  const competenceRange = competenceStartEnd(String(batch.competenceMonth || ''));
  const periodStart = competenceRange ? formatDate(competenceRange.start) : generatedDate;
  const periodEnd = competenceRange ? formatDate(competenceRange.end) : generatedDate;

  const guidesXml = (batch.items || []).map((item: any, index: number) => {
    const invoice = item.invoice || {};
    const invoiceDate = invoice?.issuedAt ? new Date(invoice.issuedAt) : now;
    const executionDate = formatDate(Number.isNaN(invoiceDate.getTime()) ? now : invoiceDate);
    const invoiceNumber = sanitizeText(invoice.number || `FAT-${index + 1}`);
    const patientName = sanitizeText(invoice.patientName || 'NAO INFORMADO');
    const beneficiaryCardNumber = sanitizeText(invoice.beneficiaryCardNumber || 'NAO_INFORMADO');
    const beneficiaryPlan = sanitizeText(invoice.beneficiaryPlan || invoice.convention || 'NAO_INFORMADO');
    const beneficiaryStatus = sanitizeText(invoice.beneficiaryStatus || 'NAO_INFORMADO');
    const beneficiaryCardExpiry = sanitizeText(invoice.beneficiaryCardExpiry || 'NAO_INFORMADO');
    const holderName = sanitizeText(invoice.holderName || invoice.patientName || 'NAO_INFORMADO');
    const holderDocument = sanitizeText(invoice.holderDocument || 'NAO_INFORMADO');
    const dependentName = sanitizeText(invoice.dependentName || '');
    const dependentRelationship = sanitizeText(invoice.dependentRelationship || '');
    const guideType = String(invoice.guideType || 'SP_SADT').trim().toUpperCase();
    const operatorGuideNumber = sanitizeText(invoice.operatorGuideNumber || '');
    const authorizationPassword = sanitizeText(invoice.authorizationPassword || '');
    const authorizationDateObj = invoice.authorizationDate ? new Date(invoice.authorizationDate) : null;
    const authorizationExpiryObj = invoice.authorizationExpiryDate ? new Date(invoice.authorizationExpiryDate) : null;
    const authorizationDate = authorizationDateObj && !Number.isNaN(authorizationDateObj.getTime())
      ? formatDate(authorizationDateObj)
      : '';
    const authorizationExpiryDate = authorizationExpiryObj && !Number.isNaN(authorizationExpiryObj.getTime())
      ? formatDate(authorizationExpiryObj)
      : '';
    const authorizedAttendanceType = sanitizeText(invoice.authorizedAttendanceType || guideType);
    const cidCode = sanitizeText(invoice.cidCode || '');
    const clinicalIndication = sanitizeText(invoice.clinicalIndication || '');
    const requestingProfessionalName = sanitizeText(invoice.requestingProfessionalName || 'NAO_INFORMADO');
    const requestingProfessionalCpf = sanitizeText(String(invoice.requestingProfessionalCpf || '').replace(/\D/g, '') || 'NAO_INFORMADO');
    const requestingProfessionalCouncil = sanitizeText(invoice.requestingProfessionalCouncil || 'CRM');
    const requestingProfessionalCouncilUf = sanitizeText(invoice.requestingProfessionalCouncilUf || 'NA');
    const requestingProfessionalCouncilNumber = sanitizeText(invoice.requestingProfessionalCouncilNumber || 'NAO_INFORMADO');
    const requestingProfessionalCbo = sanitizeText(invoice.requestingProfessionalCbo || 'NAO_INFORMADO');
    const executingProfessionalName = sanitizeText(invoice.executingProfessionalName || requestingProfessionalName);
    const executingProfessionalCpf = sanitizeText(String(invoice.executingProfessionalCpf || '').replace(/\D/g, '') || requestingProfessionalCpf);
    const executingProfessionalCouncil = sanitizeText(invoice.executingProfessionalCouncil || requestingProfessionalCouncil);
    const executingProfessionalCouncilUf = sanitizeText(invoice.executingProfessionalCouncilUf || requestingProfessionalCouncilUf);
    const executingProfessionalCouncilNumber = sanitizeText(invoice.executingProfessionalCouncilNumber || requestingProfessionalCouncilNumber);
    const executingProfessionalCbo = sanitizeText(invoice.executingProfessionalCbo || requestingProfessionalCbo);
    const procedureItems = Array.isArray(invoice.procedureItems) && invoice.procedureItems.length > 0
      ? invoice.procedureItems
      : [{
          procedureName: invoiceNumber,
          tussCode: null,
          tableCode: '22',
          quantity: 1,
          executedAt: invoiceDate,
          unitValue: invoice.total || 0,
          totalValue: invoice.total || 0,
        }];
    const procedureXml = procedureItems.map((procedure: any) => {
      const procedureExecutedAt = procedure?.executedAt ? new Date(procedure.executedAt) : invoiceDate;
      const procedureExecutionDate = formatDate(Number.isNaN(procedureExecutedAt.getTime()) ? invoiceDate : procedureExecutedAt);
      const procedureExecutionTime = formatTime(Number.isNaN(procedureExecutedAt.getTime()) ? invoiceDate : procedureExecutedAt);
      const normalizedCodeTable = onlyDigits(String(procedure?.tableCode || ''));
      const codeTable = sanitizeText(normalizedCodeTable || '22');
      const normalizedTussCode = onlyDigits(String(procedure?.tussCode || ''));
      const tussCode = sanitizeText(normalizedTussCode || '00000000');
      const procedureName = sanitizeText(String(procedure?.procedureName || invoiceNumber));
      const quantity = Number.isFinite(Number(procedure?.quantity)) ? Number(procedure.quantity) : 1;
      const procedureUnitValueRaw = Number(procedure?.unitValue ?? 0);
      const procedureTotalValueRaw = Number(procedure?.totalValue ?? 0);
      const invoiceFallbackTotal = Number(invoice?.total || 0);
      const unitValueResolved = procedureUnitValueRaw > 0
        ? procedureUnitValueRaw
        : (invoiceFallbackTotal > 0 && quantity > 0 ? invoiceFallbackTotal / quantity : 0);
      const totalValueResolved = procedureTotalValueRaw > 0
        ? procedureTotalValueRaw
        : (unitValueResolved * quantity);
      const unitValue = toTwoDecimals(unitValueResolved);
      const totalValue = toTwoDecimals(totalValueResolved);
      return [
        '              <procedimentoExecutado>',
        `                <dataExecucao>${procedureExecutionDate}</dataExecucao>`,
        `                <horaInicial>${procedureExecutionTime}</horaInicial>`,
        `                <horaFinal>${procedureExecutionTime}</horaFinal>`,
        `                <codigoTabela>${codeTable}</codigoTabela>`,
        `                <codigoProcedimento>${tussCode}</codigoProcedimento>`,
        `                <descricaoProcedimento>${procedureName}</descricaoProcedimento>`,
        `                <quantidadeExecutada>${quantity}</quantidadeExecutada>`,
        '                <viaAcesso>U</viaAcesso>',
        `                <valorUnitario>${unitValue}</valorUnitario>`,
        `                <valorTotal>${totalValue}</valorTotal>`,
        '              </procedimentoExecutado>',
      ].join('\n');
    }).join('\n');
    const financials = calculateGuideFinancials({ ...invoice, procedureItems });
    const guideValue = toTwoDecimals(financials.calculatedGuideTotal || invoice.total || 0);
    const hasAuthorizationData = Boolean(operatorGuideNumber || authorizationPassword || authorizationDate || authorizationExpiryDate);
    const authorizationXml = hasAuthorizationData
      ? [
          '            <dadosAutorizacao>',
          operatorGuideNumber ? `              <numeroGuiaOperadora>${operatorGuideNumber}</numeroGuiaOperadora>` : '',
          authorizationPassword ? `              <senha>${authorizationPassword}</senha>` : '',
          authorizationDate ? `              <dataAutorizacao>${authorizationDate}</dataAutorizacao>` : '',
          authorizationExpiryDate ? `              <validadeSenha>${authorizationExpiryDate}</validadeSenha>` : '',
          authorizedAttendanceType ? `              <tipoAtendimentoAutorizado>${authorizedAttendanceType}</tipoAtendimentoAutorizado>` : '',
          '            </dadosAutorizacao>',
        ].filter(Boolean).join('\n')
      : '';
    const observationParts = [
      `TipoGuia:${guideType}`,
      `Plano:${beneficiaryPlan}`,
      `StatusCarteira:${beneficiaryStatus}`,
      `ValidadeCarteira:${beneficiaryCardExpiry}`,
      `Titular:${holderName}`,
      `DocTitular:${holderDocument}`,
      dependentName ? `Dependente:${dependentName}` : '',
      dependentRelationship ? `Parentesco:${dependentRelationship}` : '',
      cidCode ? `CID:${cidCode}` : '',
      `Procedimentos:${toTwoDecimals(financials.procedureTotal)}`,
      `Composicao:${toTwoDecimals(financials.compositionTotal)}`,
      financials.packageValue > 0 ? `Pacote:${toTwoDecimals(financials.packageValue)}` : '',
      financials.materialsValue > 0 ? `Materiais:${toTwoDecimals(financials.materialsValue)}` : '',
      financials.feesValue > 0 ? `Taxas:${toTwoDecimals(financials.feesValue)}` : '',
      financials.dailyValue > 0 ? `Diarias:${toTwoDecimals(financials.dailyValue)}` : '',
      financials.gasesValue > 0 ? `Gases:${toTwoDecimals(financials.gasesValue)}` : '',
      financials.opmeValue > 0 ? `OPME:${toTwoDecimals(financials.opmeValue)}` : '',
      financials.commercialDiscount > 0 ? `DescComercial:${toTwoDecimals(financials.commercialDiscount)}` : '',
      financials.expectedDiscountValue > 0 ? `DescPrevisto:${toTwoDecimals(financials.expectedDiscountValue)}` : '',
      financials.expectedGlosaValue > 0 ? `GlosaPrevista:${toTwoDecimals(financials.expectedGlosaValue)}` : '',
    ].filter(Boolean);
    if (guideType === 'CONSULTA') {
      return [
        '          <guiaConsulta>',
        `            <cabecalhoGuia><registroANS>${registryAns}</registroANS><numeroGuiaPrestador>${sanitizeText(item.guideNumber)}</numeroGuiaPrestador></cabecalhoGuia>`,
        authorizationXml,
        `            <dadosBeneficiario><numeroCarteira>${beneficiaryCardNumber}</numeroCarteira><nomeBeneficiario>${patientName}</nomeBeneficiario></dadosBeneficiario>`,
        '            <dadosSolicitante>',
        '              <profissionalSolicitante>',
        `                <nomeProfissional>${requestingProfessionalName}</nomeProfissional>`,
        `                <cpfProfissional>${requestingProfessionalCpf}</cpfProfissional>`,
        `                <conselhoProfissional>${requestingProfessionalCouncil}</conselhoProfissional>`,
        `                <numeroConselhoProfissional>${requestingProfessionalCouncilNumber}</numeroConselhoProfissional>`,
        `                <UFConselhoProfissional>${requestingProfessionalCouncilUf}</UFConselhoProfissional>`,
        `                <CBOS>${requestingProfessionalCbo}</CBOS>`,
        '              </profissionalSolicitante>',
        '            </dadosSolicitante>',
        `            <dadosAtendimento><dataAtendimento>${executionDate}</dataAtendimento><tipoConsulta>1</tipoConsulta><indicacaoAcidente>9</indicacaoAcidente></dadosAtendimento>`,
        cidCode ? `            <diagnosticoCID>${cidCode}</diagnosticoCID>` : '',
        clinicalIndication ? `            <indicacaoClinica>${clinicalIndication}</indicacaoClinica>` : '',
        '            <procedimentosExecutados>',
        procedureXml,
        '            </procedimentosExecutados>',
        `            <observacao>${sanitizeText(observationParts.join(' | '))}</observacao>`,
        `            <valorTotal>${guideValue}</valorTotal>`,
        '          </guiaConsulta>',
      ].filter(Boolean).join('\n');
    }

    return [
      '          <guiaSP-SADT>',
      `            <cabecalhoGuia><registroANS>${registryAns}</registroANS><numeroGuiaPrestador>${sanitizeText(item.guideNumber)}</numeroGuiaPrestador></cabecalhoGuia>`,
      authorizationXml,
      `            <dadosBeneficiario><numeroCarteira>${beneficiaryCardNumber}</numeroCarteira><nomeBeneficiario>${patientName}</nomeBeneficiario></dadosBeneficiario>`,
      `            <dadosSolicitacao><dataSolicitacao>${executionDate}</dataSolicitacao></dadosSolicitacao>`,
      '            <dadosSolicitante>',
      '              <profissionalSolicitante>',
      `                <nomeProfissional>${requestingProfessionalName}</nomeProfissional>`,
      `                <cpfProfissional>${requestingProfessionalCpf}</cpfProfissional>`,
      `                <conselhoProfissional>${requestingProfessionalCouncil}</conselhoProfissional>`,
      `                <numeroConselhoProfissional>${requestingProfessionalCouncilNumber}</numeroConselhoProfissional>`,
      `                <UFConselhoProfissional>${requestingProfessionalCouncilUf}</UFConselhoProfissional>`,
      `                <CBOS>${requestingProfessionalCbo}</CBOS>`,
      '              </profissionalSolicitante>',
      '            </dadosSolicitante>',
      '            <dadosExecutante>',
      `              <contratadoExecutante><cnpjContratado>${cnpjPrestador}</cnpjContratado></contratadoExecutante>`,
      `              <CNES>${cnesPrestador}</CNES>`,
      '              <profissionalExecutante>',
      `                <nomeProfissional>${executingProfessionalName}</nomeProfissional>`,
      `                <cpfProfissional>${executingProfessionalCpf}</cpfProfissional>`,
      `                <conselhoProfissional>${executingProfessionalCouncil}</conselhoProfissional>`,
      `                <numeroConselhoProfissional>${executingProfessionalCouncilNumber}</numeroConselhoProfissional>`,
      `                <UFConselhoProfissional>${executingProfessionalCouncilUf}</UFConselhoProfissional>`,
      `                <CBOS>${executingProfessionalCbo}</CBOS>`,
      '              </profissionalExecutante>',
      '            </dadosExecutante>',
      clinicalIndication ? `            <indicacaoClinica>${clinicalIndication}</indicacaoClinica>` : '',
      cidCode ? `            <diagnosticoCID>${cidCode}</diagnosticoCID>` : '',
      '            <procedimentosExecutados>',
      procedureXml,
      '            </procedimentosExecutados>',
      `            <observacao>${sanitizeText(observationParts.join(' | '))}</observacao>`,
      `            <valorTotal>${guideValue}</valorTotal>`,
      '          </guiaSP-SADT>',
    ].filter(Boolean).join('\n');
  }).join('\n');

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<ans:mensagemTISS xmlns:ans="http://www.ans.gov.br/padroes/tiss/schemas">',
    '  <ans:cabecalho>',
    '    <ans:identificacaoTransacao>',
    '      <ans:tipoTransacao>ENVIO_LOTE_GUIAS</ans:tipoTransacao>',
    `      <ans:sequencialTransacao>${sequencialTransacao}</ans:sequencialTransacao>`,
    `      <ans:dataRegistroTransacao>${generatedDate}</ans:dataRegistroTransacao>`,
    `      <ans:horaRegistroTransacao>${generatedTime}</ans:horaRegistroTransacao>`,
    '    </ans:identificacaoTransacao>',
    '    <ans:origem>',
    `      <ans:identificacaoPrestador><ans:cnpj>${cnpjPrestador}</ans:cnpj><ans:codigoPrestadorNaOperadora>${codigoPrestadorOperadora}</ans:codigoPrestadorNaOperadora></ans:identificacaoPrestador>`,
    '    </ans:origem>',
    '    <ans:destino>',
    `      <ans:registroANS>${registroOperadora}</ans:registroANS>`,
    `      <ans:cnpjOperadora>${cnpjOperadora}</ans:cnpjOperadora>`,
    '    </ans:destino>',
    `    <ans:Padrao>${versaoPadrao}</ans:Padrao>`,
    '  </ans:cabecalho>',
    '  <ans:prestadorParaOperadora>',
    '    <ans:loteGuias>',
    `      <ans:numeroLote>${batchNumberNumeric}</ans:numeroLote>`,
    `      <ans:dataInicio>${periodStart}</ans:dataInicio>`,
    `      <ans:dataFim>${periodEnd}</ans:dataFim>`,
    '      <ans:guiasTISS>',
    guidesXml,
    '      </ans:guiasTISS>',
    '    </ans:loteGuias>',
    '  </ans:prestadorParaOperadora>',
    '  <ans:epilogo>',
    `    <ans:hash>${sanitizeText(batch.batchNumber)}-${generatedAtIso}</ans:hash>`,
    `  </ans:epilogo>`,
    '</ans:mensagemTISS>',
  ].join('\n');
}

export default async function tissBatchRoutes(app: FastifyInstance) {
  app.addHook('onRequest', async (request, reply) => {
    try {
      await request.jwtVerify();
    } catch (err) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }
  });

  app.get('/', {
    schema: {
      summary: 'List TISS batches',
      tags: ['TissBatches'],
      querystring: {
        type: 'object',
        properties: {
          competenceMonth: { type: 'string' },
          convention: { type: 'string' },
          status: { type: 'string', enum: ['ALL', ...tissBatchStatusValues] },
          search: { type: 'string' },
          limit: { type: 'number', default: 50 },
          offset: { type: 'number', default: 0 },
        },
      },
    },
  }, async (request, reply) => {
    const branchId = await getLoggedBranchId(request);
    if (!branchId) return reply.code(403).send({ error: 'User not associated with a branch' });
    void branchId;
    const {
      competenceMonth,
      convention,
      status,
      search,
      limit = 50,
      offset = 0,
    } = request.query as any;

    const where: any = { isActive: true };
    if (competenceMonth) where.competenceMonth = competenceMonth;
    if (convention) where.convention = convention;
    if (status && status !== 'ALL') where.status = status;
    if (search) {
      where.OR = [
        { batchNumber: { contains: search, mode: 'insensitive' } },
        { convention: { contains: search, mode: 'insensitive' } },
      ];
    }

    const [items, total] = await Promise.all([
      prisma.tissBatch.findMany({
        where,
        take: limit,
        skip: offset,
        orderBy: [{ createdAt: 'desc' }],
        include: {
          items: {
            where: { isActive: true },
            include: { invoice: { include: { procedureItems: true } } },
          },
        },
      }),
      prisma.tissBatch.count({ where }),
    ]);

    const normalized = items.map((item: any) => ({
      ...item,
      invoicesCount: item.items.length,
      totalValue: item.items.reduce((sum: number, row: any) => sum + Number(row?.invoice?.total || 0), 0),
    }));

    return { items: normalized, total, limit, offset };
  });

  app.get('/:id', {
    schema: {
      summary: 'Get TISS batch by ID',
      tags: ['TissBatches'],
      params: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
    },
  }, async (request, reply) => {
    const { id } = request.params as any;
    const batch = await prisma.tissBatch.findUnique({
      where: { id },
      include: {
        items: {
          where: { isActive: true },
          include: { invoice: { include: { procedureItems: true } } },
        },
      },
    });
    if (!batch || !batch.isActive) return reply.code(404).send({ error: 'TISS batch not found' });
    return batch;
  });

  app.post('/', {
    schema: {
      summary: 'Create TISS batch',
      tags: ['TissBatches'],
      body: { $ref: 'TissBatchCreate#' },
      response: {
        201: { $ref: 'TissBatch#' },
        400: { type: 'object', additionalProperties: true },
      },
    },
  }, async (request, reply) => {
    const branchId = await getLoggedBranchId(request);
    if (!branchId) return (reply as any).code(403).send({ error: 'User not associated with a branch' });
    const { competenceMonth, convention, invoiceIds } = request.body as {
      competenceMonth: string;
      convention: string;
      invoiceIds: string[];
    };

    if (!isValidCompetence(String(competenceMonth || ''))) {
      return reply.code(400).send({ error: 'Invalid competenceMonth. Expected YYYY-MM.' });
    }

    const normalizedConvention = String(convention || '').trim();
    if (!normalizedConvention) return reply.code(400).send({ error: 'Convention is required.' });

    const normalizedInvoiceIds = Array.isArray(invoiceIds)
      ? Array.from(new Set(invoiceIds.map((item) => String(item || '').trim()).filter(Boolean)))
      : [];
    if (!normalizedInvoiceIds.length) return reply.code(400).send({ error: 'At least one invoice is required.' });

    const invoices = await prisma.invoice.findMany({
      where: {
        id: { in: normalizedInvoiceIds },
        isActive: true,
      },
      include: {
        procedureItems: true,
      },
    });

    if (invoices.length !== normalizedInvoiceIds.length) {
      return reply.code(400).send({ error: 'One or more invoices were not found.' });
    }

    const invalidConvention = invoices.find((invoice: any) => String(invoice.convention || '').trim() !== normalizedConvention);
    if (invalidConvention) {
      return reply.code(400).send({
        error: `Invoice ${invalidConvention.number} does not match convention ${normalizedConvention}.`,
      });
    }

    const invalidGuideTotals = invoices
      .map((invoice: any) => ({ invoice, financials: calculateGuideFinancials(invoice) }))
      .filter((entry: any) => !entry.financials.isValid);

    if (invalidGuideTotals.length > 0) {
      const first = invalidGuideTotals[0];
      return reply.code(400).send({
        error: `Conferencia financeira divergente na guia ${first.invoice.number}: total armazenado ${toTwoDecimals(first.financials.storedTotal)} vs calculado ${toTwoDecimals(first.financials.calculatedGuideTotal)}.`,
      });
    }

    const storedLotTotal = roundMoney(invoices.reduce((sum: number, invoice: any) => sum + toMoneyNumber(invoice.total), 0));
    const calculatedLotTotal = roundMoney(invoices.reduce((sum: number, invoice: any) => (
      sum + calculateGuideFinancials(invoice).calculatedGuideTotal
    ), 0));
    if (Math.abs(storedLotTotal - calculatedLotTotal) > 0.01) {
      return reply.code(400).send({
        error: `Conferencia do lote divergente: total armazenado ${toTwoDecimals(storedLotTotal)} vs calculado ${toTwoDecimals(calculatedLotTotal)}.`,
      });
    }

    const alreadyInActiveBatch = await prisma.tissBatchItem.findFirst({
      where: {
        invoiceId: { in: normalizedInvoiceIds },
        isActive: true,
      },
      include: {
        batch: true,
        invoice: true,
      },
    });

    if (alreadyInActiveBatch?.batch?.isActive) {
      return reply.code(400).send({
        error: `Invoice ${alreadyInActiveBatch.invoice?.number || alreadyInActiveBatch.invoiceId} is already in active batch ${alreadyInActiveBatch.batch.batchNumber}.`,
      });
    }

    const created = await prisma.$transaction(async (tx: any) => {
      let batchNumber = generateBatchNumber();
      let attempts = 0;
      let batch: any = null;
      while (!batch && attempts < 5) {
        attempts += 1;
        try {
          batch = await tx.tissBatch.create({
            data: {
              batchNumber,
              competenceMonth,
              convention: normalizedConvention,
              status: 'DRAFT',
              createdByUserId: (request.user as any)?.id || null,
            },
          });
        } catch (err: any) {
          if (err.code === 'P2002') {
            batchNumber = generateBatchNumber();
            continue;
          }
          throw err;
        }
      }

      if (!batch) throw new Error('Failed to create unique batch number');

      await tx.tissBatchItem.createMany({
        data: invoices.map((invoice: any, index: number) => ({
          batchId: batch.id,
          invoiceId: invoice.id,
          guideNumber: generateGuideNumber(invoice.number, index),
          status: 'PENDING',
          isActive: true,
        })),
      });

      return tx.tissBatch.findUnique({
        where: { id: batch.id },
        include: {
          items: {
            where: { isActive: true },
            include: { invoice: { include: { procedureItems: true } } },
          },
        },
      });
    });

    return reply.code(201).send(created);
  });

  app.patch('/:id/protocol', {
    schema: {
      summary: 'Register protocol and mark batch as sent',
      tags: ['TissBatches'],
      params: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
      body: { $ref: 'TissBatchProtocolUpdate#' },
      response: {
        200: { $ref: 'TissBatch#' },
        400: { type: 'object', additionalProperties: true },
        404: { type: 'object', additionalProperties: true },
      },
    },
  }, async (request, reply) => {
    const { id } = request.params as any;
    const body = request.body as { protocolNumber: string };
    const protocolNumber = String(body?.protocolNumber || '').trim();
    if (!protocolNumber) return reply.code(400).send({ error: 'Protocol number is required.' });

    const batch = await prisma.tissBatch.findUnique({ where: { id } });
    if (!batch || !batch.isActive) return reply.code(404).send({ error: 'TISS batch not found' });

    const updated = await prisma.tissBatch.update({
      where: { id },
      data: {
        protocolNumber,
        status: 'SENT',
        sentAt: batch.sentAt || new Date(),
      },
      include: {
        items: {
          where: { isActive: true },
          include: { invoice: { include: { procedureItems: true } } },
        },
      },
    });

    return updated;
  });

  app.post('/:id/return', {
    schema: {
      summary: 'Register operator return for guides',
      tags: ['TissBatches'],
      params: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
      body: { $ref: 'TissBatchReturnCreate#' },
      response: {
        200: { $ref: 'TissBatch#' },
        400: { type: 'object', additionalProperties: true },
        404: { type: 'object', additionalProperties: true },
      },
    },
  }, async (request, reply) => {
    const { id } = request.params as any;
    const body = request.body as {
      items: Array<{
        itemId?: string;
        guideNumber?: string;
        status: string;
        returnCode?: string;
        returnMessage?: string;
        glosaValue?: number;
      }>;
    };

    const batch = await prisma.tissBatch.findUnique({
      where: { id },
      include: {
        items: {
          where: { isActive: true },
          include: { invoice: { include: { procedureItems: true } } },
        },
      },
    });
    if (!batch || !batch.isActive) return reply.code(404).send({ error: 'TISS batch not found' });
    if (!Array.isArray(body?.items) || body.items.length === 0) {
      return reply.code(400).send({ error: 'At least one return item is required.' });
    }

    const itemById = new Map<string, any>((batch.items || []).map((item: any) => [String(item.id), item]));
    const itemByGuide = new Map<string, any>((batch.items || []).map((item: any) => [String(item.guideNumber || '').trim(), item]));

    const updates = body.items.map((entry: any) => {
      const normalizedReturnStatus = normalizeReturnStatus(entry?.status);
      if (!normalizedReturnStatus) throw new Error('Invalid return status. Use ACCEPTED, PARTIAL or REJECTED.');
      const itemId = String(entry?.itemId || '').trim();
      const guideNumber = String(entry?.guideNumber || '').trim();
      const target = itemId ? itemById.get(itemId) : itemByGuide.get(guideNumber);
      if (!target) {
        throw new Error(`Guide not found in this batch (${itemId || guideNumber || 'without reference'}).`);
      }
      const glosaValue = Number(entry?.glosaValue ?? 0);
      return {
        id: target.id,
        status: normalizedReturnStatus,
        returnCode: String(entry?.returnCode || '').trim() || null,
        returnMessage: String(entry?.returnMessage || '').trim() || null,
        glosaValue: Number.isFinite(glosaValue) ? glosaValue : 0,
      };
    });

    const updated = await prisma.$transaction(async (tx: any) => {
      for (const entry of updates) {
        await tx.tissBatchItem.update({
          where: { id: entry.id },
          data: {
            status: entry.status,
            returnStatus: entry.status,
            returnCode: entry.returnCode,
            returnMessage: entry.returnMessage,
            glosaValue: entry.glosaValue,
          },
        });
      }

      const refreshed = await tx.tissBatch.findUnique({
        where: { id: batch.id },
        include: {
          items: {
            where: { isActive: true },
            include: { invoice: { include: { procedureItems: true } } },
          },
        },
      });

      const resolvedBatchStatus = resolveBatchStatusFromItems(refreshed?.items || []);
      return tx.tissBatch.update({
        where: { id: batch.id },
        data: {
          status: resolvedBatchStatus,
          sentAt: refreshed?.sentAt || new Date(),
        },
        include: {
          items: {
            where: { isActive: true },
            include: { invoice: { include: { procedureItems: true } } },
          },
        },
      });
    });

    return updated;
  });

  app.post('/:id/represent', {
    schema: {
      summary: 'Re-present rejected or partial guides in a new batch',
      tags: ['TissBatches'],
      params: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
      body: { $ref: 'TissBatchReprocessCreate#' },
      response: {
        201: { $ref: 'TissBatch#' },
        400: { type: 'object', additionalProperties: true },
        404: { type: 'object', additionalProperties: true },
      },
    },
  }, async (request, reply) => {
    const { id } = request.params as any;
    const body = request.body as { itemIds?: string[]; competenceMonth?: string };
    const batch = await prisma.tissBatch.findUnique({
      where: { id },
      include: {
        items: {
          where: { isActive: true },
          include: { invoice: { include: { procedureItems: true } } },
        },
      },
    });
    if (!batch || !batch.isActive) return reply.code(404).send({ error: 'TISS batch not found' });

    const selectedItemIds = Array.isArray(body?.itemIds)
      ? new Set(body.itemIds.map((item) => String(item || '').trim()).filter(Boolean))
      : null;

    const eligible = (batch.items || []).filter((item: any) => {
      const returnStatus = normalizeReturnStatus(item?.returnStatus);
      if (!returnStatus) return false;
      if (item?.isRepresented) return false;
      if (returnStatus !== 'REJECTED' && returnStatus !== 'PARTIAL') return false;
      if (selectedItemIds && selectedItemIds.size > 0 && !selectedItemIds.has(String(item.id))) return false;
      return true;
    });

    if (eligible.length === 0) {
      return reply.code(400).send({ error: 'No rejected/partial guides available for re-presentation.' });
    }

    const competenceMonth = String(body?.competenceMonth || batch.competenceMonth || '').trim();
    if (!isValidCompetence(competenceMonth)) {
      return reply.code(400).send({ error: 'Invalid competenceMonth. Expected YYYY-MM.' });
    }

    const invoiceIds = eligible.map((item: any) => String(item.invoiceId));
    const alreadyInAnotherActiveBatch = await prisma.tissBatchItem.findFirst({
      where: {
        invoiceId: { in: invoiceIds },
        isActive: true,
        batchId: { not: batch.id },
      },
      include: { batch: true, invoice: true },
    });

    if (alreadyInAnotherActiveBatch) {
      return reply.code(400).send({
        error: `Invoice ${alreadyInAnotherActiveBatch.invoice?.number || alreadyInAnotherActiveBatch.invoiceId} already belongs to active batch ${alreadyInAnotherActiveBatch.batch?.batchNumber}.`,
      });
    }

    const created = await prisma.$transaction(async (tx: any) => {
      await tx.tissBatchItem.updateMany({
        where: { id: { in: eligible.map((item: any) => item.id) } },
        data: {
          isActive: false,
          isRepresented: true,
          representedAt: new Date(),
        },
      });

      let batchNumber = generateBatchNumber();
      let attempts = 0;
      let newBatch: any = null;
      while (!newBatch && attempts < 5) {
        attempts += 1;
        try {
          newBatch = await tx.tissBatch.create({
            data: {
              batchNumber,
              competenceMonth,
              convention: batch.convention,
              status: 'DRAFT',
              createdByUserId: (request.user as any)?.id || null,
            },
          });
        } catch (err: any) {
          if (err.code === 'P2002') {
            batchNumber = generateBatchNumber();
            continue;
          }
          throw err;
        }
      }

      if (!newBatch) throw new Error('Failed to create unique batch number for re-presentation');

      await tx.tissBatchItem.createMany({
        data: eligible.map((item: any, index: number) => ({
          batchId: newBatch.id,
          invoiceId: item.invoiceId,
          guideNumber: generateGuideNumber(item?.invoice?.number || `FAT-${index + 1}`, index),
          status: 'PENDING',
          isActive: true,
        })),
      });

      return tx.tissBatch.findUnique({
        where: { id: newBatch.id },
        include: {
          items: {
            where: { isActive: true },
            include: { invoice: { include: { procedureItems: true } } },
          },
        },
      });
    });

    return reply.code(201).send(created);
  });

  app.patch('/:id/status', {
    schema: {
      summary: 'Update TISS batch status',
      tags: ['TissBatches'],
      params: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
      body: { $ref: 'TissBatchStatusUpdate#' },
      response: {
        200: { $ref: 'TissBatch#' },
        400: { type: 'object', additionalProperties: true },
      },
    },
  }, async (request, reply) => {
    const { id } = request.params as any;
    const body = request.body as { status: string; protocolNumber?: string | null };
    const normalizedStatus = normalizeStatus(body?.status);
    if (!normalizedStatus) return reply.code(400).send({ error: 'Invalid status.' });

    const updated = await prisma.tissBatch.update({
      where: { id },
      data: {
        status: normalizedStatus,
        protocolNumber: body.protocolNumber ? String(body.protocolNumber).trim() : null,
        sentAt: normalizedStatus === 'SENT' ? new Date() : undefined,
      },
      include: {
        items: {
          where: { isActive: true },
          include: { invoice: { include: { procedureItems: true } } },
        },
      },
    });

    return updated;
  });

  app.get('/:id/xml', {
    schema: {
      summary: 'Generate and return TISS XML',
      tags: ['TissBatches'],
      params: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
    },
  }, async (request, reply) => {
    const { id } = request.params as any;
    const branchId = await getLoggedBranchId(request);
    if (!branchId) return reply.code(403).send({ error: 'User not associated with a branch' });

    const batch = await prisma.tissBatch.findUnique({
      where: { id },
      include: {
        items: {
          where: { isActive: true },
          include: { invoice: { include: { procedureItems: true } } },
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    if (!batch || !batch.isActive) return reply.code(404).send({ error: 'TISS batch not found' });
    if (!batch.items.length) return reply.code(400).send({ error: 'Batch has no invoices.' });
    const tissConfig = await resolveInsuranceTissConfig(branchId, String(batch.convention || ''));
    if (!tissConfig) {
      return reply.code(400).send({
        error: `Configuracao TISS nao encontrada para o convenio "${batch.convention}" na filial atual.`,
      });
    }

    const missing = getMissingTissConfigFields(tissConfig);
    if (missing.length > 0) {
      return reply.code(400).send({
        error: `Configuracao TISS incompleta para o convenio "${batch.convention}": ${missing.join(', ')}.`,
      });
    }

    const invalidGuideTotals = (batch.items || [])
      .map((item: any) => ({
        item,
        financials: calculateGuideFinancials(item?.invoice || {}),
      }))
      .filter((entry: any) => !entry.financials.isValid);

    if (invalidGuideTotals.length > 0) {
      const first = invalidGuideTotals[0];
      return reply.code(400).send({
        error: `Conferencia financeira divergente na guia ${first.item?.guideNumber || '-'} (${first.item?.invoice?.number || '-'}): total armazenado ${toTwoDecimals(first.financials.storedTotal)} vs calculado ${toTwoDecimals(first.financials.calculatedGuideTotal)}.`,
      });
    }

    const xml = buildTissBatchXml({ ...batch, tissConfig });
    await prisma.tissBatch.update({
      where: { id: batch.id },
      data: {
        status: batch.status === 'DRAFT' ? 'GENERATED' : batch.status,
        generatedXmlAt: new Date(),
      },
    });

    reply.header('Content-Type', 'application/xml; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="${batch.batchNumber}.xml"`);
    return reply.send(xml);
  });
}
