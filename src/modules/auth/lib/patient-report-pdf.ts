import puppeteer from 'puppeteer';

type ReportLayoutConfig = {
  clinicName: string;
  title: string;
  subtitle: string;
  headerText: string;
  footerText: string;
  paperSize: 'A4' | 'Letter';
  orientation: 'portrait' | 'landscape';
  marginTopMm: number;
  marginRightMm: number;
  marginBottomMm: number;
  marginLeftMm: number;
  fontFamily: string;
  fontSizePx: number;
  primaryColor: string;
  showLogo: boolean;
  logoUrl: string;
  logoImageDataUrl: string;
  showPatientInfo: boolean;
  showSignatures: boolean;
};

const DEFAULT_REPORT_LAYOUT: ReportLayoutConfig = {
  clinicName: 'Saudy',
  title: 'Laudo Médico',
  subtitle: '',
  headerText: '',
  footerText: '',
  paperSize: 'A4',
  orientation: 'portrait',
  marginTopMm: 18,
  marginRightMm: 16,
  marginBottomMm: 18,
  marginLeftMm: 16,
  fontFamily: 'Inter, Arial, sans-serif',
  fontSizePx: 13,
  primaryColor: '#0f172a',
  showLogo: false,
  logoUrl: '',
  logoImageDataUrl: '',
  showPatientInfo: true,
  showSignatures: true,
};

const normalizeReportLayout = (value: any): ReportLayoutConfig => {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    ...DEFAULT_REPORT_LAYOUT,
    ...source,
    marginTopMm: Number.isFinite(Number(source.marginTopMm)) ? Number(source.marginTopMm) : DEFAULT_REPORT_LAYOUT.marginTopMm,
    marginRightMm: Number.isFinite(Number(source.marginRightMm)) ? Number(source.marginRightMm) : DEFAULT_REPORT_LAYOUT.marginRightMm,
    marginBottomMm: Number.isFinite(Number(source.marginBottomMm)) ? Number(source.marginBottomMm) : DEFAULT_REPORT_LAYOUT.marginBottomMm,
    marginLeftMm: Number.isFinite(Number(source.marginLeftMm)) ? Number(source.marginLeftMm) : DEFAULT_REPORT_LAYOUT.marginLeftMm,
    fontSizePx: Number.isFinite(Number(source.fontSizePx)) ? Number(source.fontSizePx) : DEFAULT_REPORT_LAYOUT.fontSizePx,
    paperSize: source.paperSize === 'Letter' ? 'Letter' : 'A4',
    orientation: source.orientation === 'landscape' ? 'landscape' : 'portrait',
    showLogo: Boolean(source.showLogo),
    showPatientInfo: source.showPatientInfo !== false,
    showSignatures: source.showSignatures !== false,
  };
};

const escapeHtml = (value: unknown) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

const formatDateTimeLabel = (date?: string | null, time?: string | null) => {
  const rawDate = String(date || '').trim();
  const rawTime = String(time || '').trim();
  if (!rawDate) return 'Não informado';
  return rawTime ? `${rawDate} ${rawTime}` : rawDate;
};

type GeneratePatientReportPdfParams = {
  reportId: string;
  reportContentHtml: string;
  reportStatus?: string | null;
  reportUnderReview?: boolean;
  publishedVersion?: number | null;
  patientWarning?: string | null;
  patient: {
    name?: string | null;
    cpf?: string | null;
  };
  examName?: string | null;
  appointment?: {
    date?: string | null;
    time?: string | null;
  } | null;
  doctors?: {
    requestingDoctor?: string | null;
    reportingDoctor?: string | null;
    reviewingDoctor?: string | null;
  };
  signatures?: {
    issuerSignedAt?: Date | string | null;
    reviewerSignedAt?: Date | string | null;
  };
  layout?: any;
  requiresReviewer?: boolean;
  hideUnderReviewNotice?: boolean;
  previewRibbonText?: string | null;
};

const toDateLabel = (value?: Date | string | null) => {
  if (!value) return 'Pendente';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toISOString();
};

function buildReportDocumentHtml(params: GeneratePatientReportPdfParams): string {
  const layout = normalizeReportLayout(params.layout || null);
  const logoSrc = layout.logoImageDataUrl || layout.logoUrl;
  const footer = String(layout.footerText || '').trim();
  const contentHtml = String(params.reportContentHtml || '').trim() || '<p>-</p>';
  const issuerSignedAtLabel = toDateLabel(params.signatures?.issuerSignedAt);
  const reviewerSignedAtLabel = toDateLabel(params.signatures?.reviewerSignedAt);
  const issuerSigned = issuerSignedAtLabel !== 'Pendente';
  const reviewerSigned = reviewerSignedAtLabel !== 'Pendente';
  const requiresReviewer = params.requiresReviewer !== false;

  return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Laudo ${escapeHtml(params.reportId)}</title>
  <style>
    html, body { margin: 0; padding: 0; background: #ffffff; color: #0f172a; }
    body { font-family: ${layout.fontFamily}; font-size: ${layout.fontSizePx}px; line-height: 1.42; }
    .sheet { width: auto; min-height: auto; box-sizing: border-box; margin: 0 auto; padding: ${layout.marginTopMm}mm ${layout.marginRightMm}mm ${layout.marginBottomMm}mm ${layout.marginLeftMm}mm; background: #fff; }
    .header { border-bottom: 2px solid ${layout.primaryColor || '#0f172a'}; padding: 4px 0 14px; margin-bottom: 16px; display: grid; grid-template-columns: auto 1fr; gap: 18px; align-items: center; }
    .logo-wrap { width: 164px; height: 96px; display: flex; align-items: center; justify-content: center; border: 1px solid #d6e0ee; border-radius: 12px; background: linear-gradient(180deg, #ffffff 0%, #f7fbff 100%); box-shadow: inset 0 0 0 1px #eef4fb; padding: 6px; box-sizing: border-box; }
    .logo { width: 100%; height: 100%; object-fit: cover; border-radius: 8px; }
    .clinic { font-size: 10px; color: #475569; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 3px; }
    h1 { font-size: 22px; line-height: 1.12; margin: 0 0 4px; color: ${layout.primaryColor || '#0f172a'}; font-weight: 700; }
    .subtitle, .header-text, .footer-note { font-size: 12px; color: #475569; }
    .subtitle { font-weight: 600; color: #334155; margin-bottom: 1px; }
    .header-text { font-size: 11px; }
    .meta { margin-bottom: 16px; padding: 9px 11px; border: 1px solid #dbe3ee; border-radius: 6px; background: #f8fafc; display: grid; grid-template-columns: 1fr 1fr; gap: 5px 16px; }
    .meta-item { font-size: 12px; color: #1f2937; }
    .meta-item b { color: #0b1324; font-weight: 700; }
    .content { color: #0f172a; font-size: 13px; }
    .content h1, .content h2, .content h3, .content h4 { margin: 14px 0 6px; color: #0b1324; font-size: 16px; line-height: 1.25; font-weight: 800; }
    .content p { margin: 0 0 8px; }
    .content ul, .content ol { margin: 4px 0 10px 22px; }
    .content li { margin: 2px 0; }
    .notice { margin-bottom: 14px; border: 1px solid #f59e0b; background: #fffbeb; color: #7c2d12; border-radius: 8px; padding: 10px 12px; }
    .notice-title { font-weight: 800; font-size: 12px; margin-bottom: 4px; text-transform: uppercase; letter-spacing: 0.04em; }
    .notice-text { font-size: 12px; line-height: 1.35; }
    .notice-version { margin-top: 4px; font-size: 11px; color: #92400e; font-weight: 700; }
    .signatures { margin-top: 26px; border-top: 1px solid #cbd5e1; padding-top: 10px; display: grid; grid-template-columns: 1fr 1fr; gap: 12px; font-size: 12px; color: #475569; }
    .sign-card { border: 1px solid #e2e8f0; border-radius: 6px; padding: 8px 10px; background: #fafcff; }
    .sign-title { font-weight: 700; color: #334155; margin-bottom: 2px; }
    .sign-person { color: #0b1324; font-weight: 700; margin-bottom: 3px; }
    .sign-status { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; font-weight: 700; }
    .sign-dot { width: 18px; height: 18px; border-radius: 999px; display: inline-flex; align-items: center; justify-content: center; font-size: 12px; line-height: 1; color: #fff; }
    .sign-dot-ok { background: #16a34a; }
    .sign-dot-pending { background: #94a3b8; }
    .sign-time { margin-top: 2px; font-size: 11px; color: #475569; }
    .footer { margin-top: 20px; padding-top: 10px; border-top: 1px solid #e2e8f0; font-size: 12px; color: #475569; }
    .footer-extra { margin-top: 2px; font-size: 11px; color: #475569; }
    .preview-ribbon { position: fixed; left: -44px; top: 52%; transform: rotate(-90deg); background: #0f4c81; color: #ffffff; border-radius: 8px 8px 0 0; padding: 8px 16px; font-weight: 800; letter-spacing: 0.08em; font-size: 11px; text-transform: uppercase; z-index: 20; }
    @media print { @page { size: ${layout.paperSize} ${layout.orientation}; margin: 0; } html, body { background: #fff !important; color: #111 !important; } .sheet { width: auto; min-height: auto; margin: 0; border: none; border-radius: 0; background: #fff !important; } h1, .meta, .signatures, .footer, .subtitle, .header-text { color: #111 !important; } }
  </style></head><body><div class="sheet">
    ${params.previewRibbonText ? `<div class="preview-ribbon">${escapeHtml(params.previewRibbonText)}</div>` : ''}
    <div class="header"><div class="logo-wrap">${layout.showLogo && logoSrc ? `<img class="logo" src="${escapeHtml(logoSrc)}" alt="Logo" />` : ''}</div><div><div class="clinic">${escapeHtml(layout.clinicName)}</div><h1>${escapeHtml(layout.title || 'Laudo Médico')}</h1>${layout.subtitle ? `<div class="subtitle">${escapeHtml(layout.subtitle)}</div>` : ''}${layout.headerText ? `<div class="header-text">${escapeHtml(layout.headerText)}</div>` : ''}</div></div>
    ${layout.showPatientInfo ? `<div class="meta"><div class="meta-item"><b>Paciente:</b> ${escapeHtml(params.patient.name || '-')}</div><div class="meta-item"><b>Exame:</b> ${escapeHtml(params.examName || '-')}</div><div class="meta-item"><b>CPF:</b> ${escapeHtml(params.patient.cpf || 'Não informado')}</div><div class="meta-item"><b>Data/Hora:</b> ${escapeHtml(formatDateTimeLabel(params.appointment?.date || null, params.appointment?.time || null))}</div></div>` : ''}
    ${params.reportUnderReview && !params.hideUnderReviewNotice ? `<div class="notice"><div class="notice-title">Laudo em revisão pela clínica</div><div class="notice-text">${escapeHtml(params.patientWarning || 'Você está visualizando a última versão publicada enquanto uma atualização está em andamento.')}</div>${params.publishedVersion ? `<div class="notice-version">${escapeHtml(`Versão publicada: v${params.publishedVersion}`)}</div>` : ''}</div>` : ''}
    <div class="content">${contentHtml}</div>
    ${layout.showSignatures ? `<div class="signatures"><div class="sign-card"><div class="sign-title">Emissor</div><div class="sign-person">${escapeHtml(params.doctors?.reportingDoctor || 'Emissor não identificado')}</div><div class="sign-status"><span class="sign-dot ${issuerSigned ? 'sign-dot-ok' : 'sign-dot-pending'}">${issuerSigned ? '&#10003;' : '...'}</span><span>${issuerSigned ? 'Assinado' : 'Pendente'}</span></div><div class="sign-time">${escapeHtml(issuerSignedAtLabel)}</div></div><div class="sign-card"><div class="sign-title">Revisor</div><div class="sign-person">${escapeHtml(params.doctors?.reviewingDoctor || (requiresReviewer ? 'Revisor não identificado' : 'Revisor não obrigatório'))}</div><div class="sign-status"><span class="sign-dot ${reviewerSigned ? 'sign-dot-ok' : 'sign-dot-pending'}">${reviewerSigned ? '&#10003;' : '...'}</span><span>${requiresReviewer ? (reviewerSigned ? 'Assinado' : 'Pendente') : 'Não obrigatório'}</span></div><div class="sign-time">${escapeHtml(reviewerSignedAtLabel === 'Pendente' && !requiresReviewer ? 'Não obrigatório' : reviewerSignedAtLabel)}</div></div></div>` : ''}
    <div class="footer">${footer ? `<div class="footer-extra">${escapeHtml(footer)}</div>` : ''}</div>
  </div></body></html>`;
}

export async function generatePatientReportPdfBuffer(params: GeneratePatientReportPdfParams): Promise<Buffer> {
  const html = buildReportDocumentHtml(params);
  const layout = normalizeReportLayout(params.layout || null);
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'domcontentloaded' });
    await page.waitForNetworkIdle();
    await page.emulateMediaType('print');
    const pdf = await page.pdf({
      format: layout.paperSize,
      landscape: layout.orientation === 'landscape',
      printBackground: true,
      preferCSSPageSize: true,
      margin: { top: '0', right: '0', bottom: '0', left: '0' },
    });
    return Buffer.from(pdf);
  } finally {
    await browser.close();
  }
}
