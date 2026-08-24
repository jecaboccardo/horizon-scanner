import type { Paragraph, Table } from 'docx';
import { EvidenceBrief, EvidenceRow, JelBibEntry, JelPaper, Work } from '../types';
import { regionsFromGeography } from '../utils/regionFromGeography';

type EvidenceClassificationMap = Record<string, {
  evidenceMatch: 'direct' | 'indirect' | 'excluded';
  classification?: 'direct-lac' | 'direct-global' | 'indirect' | 'excluded';
  facetsMatched: string[];
  facetsMissed: string[];
  llmRationale?: string;
}> | null | undefined;

function getSmsLevel(row: EvidenceRow, work: Work | undefined): number | null {
  return row.smsLevel ?? work?.smsLevel ?? null;
}

function getMethodology(row: EvidenceRow, work: Work | undefined): string {
  const rowMethod = row.methodologyBadge && row.methodologyBadge !== 'Unclassified'
    ? row.methodologyBadge
    : '';
  return rowMethod || work?.methodologyDesign || work?.methodology?.design || 'Unclassified';
}

// Coerce any value to a string[] (mirrors BriefView's toStrArr). Briefs persisted
// before the 2026-06-26 authors repair can carry authors as a JSON-encoded STRING
// ('["A","B"]'); a string passes `x.length > 0` and then crashes `.slice().join()`
// (String.slice returns a string, which has no .join) — which made every export
// (CSV / copy / Word) of a pre-incident brief throw with nothing downloaded.
function toStrArr(v: unknown): string[] {
  if (Array.isArray(v)) return v as string[];
  if (typeof v === 'string') {
    const t = v.trim();
    if (!t) return [];
    if (t.startsWith('[')) { try { const p = JSON.parse(t); return Array.isArray(p) ? p : [t]; } catch { return [t]; } }
    return [t];
  }
  return [];
}

function getAuthors(row: EvidenceRow, work?: Work): string[] {
  const rowAuthors = toStrArr(row.authors);
  return rowAuthors.length > 0 ? rowAuthors : toStrArr(work?.authors);
}

// Returns REGION bucket(s) for the evidence-table column / exports — derived from
// the paper's country-level geography[]. Empty when no region maps; callers show
// 'Global'. (Was: the raw country list.)
function getGeography(row: EvidenceRow, work: Work | undefined): string[] {
  const rg = toStrArr(row.geography);
  const rowGeo = rg.length > 0 ? rg : toStrArr(work?.geography);
  return regionsFromGeography(rowGeo);
}

// getMatchLabel removed 2026-06-17 — the direct/indirect/excluded classifier was
// dropped (relevance-first redesign); exports no longer carry a "Match" column.

function getPublicationType(work: Work | undefined, rowSourceName?: string): string {
  const explicit = work?.publicationType;
  if (explicit) return explicit.replace(/_/g, ' ');
  const haystack = [
    work?.venue || '',
    work?.source || '',
    work?.sourceFamily || '',
    work?.institution || '',
    rowSourceName || '',
  ].join(' ').toLowerCase();
  if (/nber|ssrn|iza|cepr|working paper|discussion paper|preprint|arxiv/.test(haystack)) return 'working paper';
  if (/world bank|imf|oecd|iadb|\bidb\b|cepal|paho|who|unicef|unesco|undp|ilo/.test(haystack) && !work?.venue) return 'institutional';
  if (work?.venue || work?.absRating || (rowSourceName && rowSourceName !== 'Unknown')) return 'journal';
  return '';
}

function getSource(row: EvidenceRow, work: Work | undefined): string {
  const rowSourceName = row.sourceName && row.sourceName !== 'Unknown' ? row.sourceName : '';
  return work?.venue || rowSourceName || work?.institution || work?.source || '';
}

// ---------------------------------------------------------------------------
// Copy DOI link for a single paper
// ---------------------------------------------------------------------------

export async function copyDoi(row: EvidenceRow): Promise<boolean> {
  const url = row.doi
    ? `https://doi.org/${row.doi}`
    : row.url || null;
  if (!url) return false;
  await navigator.clipboard.writeText(url);
  return true;
}

// ---------------------------------------------------------------------------
// Copy formatted brief text (Word/email-friendly)
// ---------------------------------------------------------------------------

export async function copyBriefAsText(
  brief: EvidenceBrief,
  worksById: Record<string, Work>,
  rowsForExport?: EvidenceRow[],
): Promise<void> {
  const { sections } = brief;
  // When the user has filtered the table, the export reflects the visible
  // post-filter set instead of the brief's original evidence rows. Coverage
  // narrative (gapSummary etc.) still comes from the brief synthesis since
  // it was generated over the original set — only the row table + count
  // shift with the filters.
  const exportedRows = rowsForExport ?? sections.evidenceRows;
  const isFiltered = rowsForExport != null && rowsForExport.length !== sections.evidenceRows.length;
  const lines: string[] = [];

  // Header
  lines.push(`EVIDENCE BRIEF`);
  lines.push(`Query: ${brief.query}`);
  lines.push(`Generated: ${brief.auditTrace.generatedAt ? new Date(brief.auditTrace.generatedAt).toLocaleString() : 'N/A'}`);
  lines.push('');

  // 1. Executive Summary
  lines.push('--- 1. EXECUTIVE SUMMARY ---');
  sections.summaryBullets.forEach((b, i) => lines.push(`  ${i + 1}. ${b}`));
  lines.push('');

  // 2. Evidence Table
  lines.push('--- 2. EVIDENCE TABLE ---');
  lines.push('');
  sections.evidenceRows.forEach((row, i) => {
    const work = worksById[row.workId];
    const url = row.doi ? `https://doi.org/${row.doi}` : row.url || '';
    const authorArr = getAuthors(row, worksById[row.workId]);
    const authors = authorArr.length > 3
      ? `${authorArr.slice(0, 3).join(', ')} et al.`
      : authorArr.join(', ');
    const methodology = getMethodology(row, work);
    const source = work?.source || row.sourceName || '';
    const citations = work?.citationCount ? ` | ${work.citationCount} citations` : '';

    lines.push(`  [${i + 1}] ${row.title}`);
    lines.push(`      Authors: ${authors || 'Unknown'}`);
    lines.push(`      Year: ${row.year || 'N/A'} | ${methodology} | ${source}${citations}`);
    if (url) lines.push(`      Link: ${url}`);
    if (row.finding) lines.push(`      Finding: ${row.finding.slice(0, 200)}${row.finding.length > 200 ? '...' : ''}`);
    lines.push('');
  });

  // 3. Methodology Note
  lines.push('--- 3. METHODOLOGY NOTE ---');
  lines.push(sections.methodologyNote || 'N/A');
  lines.push('');

  // 4. Coverage Card
  lines.push('--- 4. COVERAGE ---');
  lines.push(`  Universe: ${sections.coverageCard.universeCount}`);
  lines.push(`  Retrieved: ${sections.coverageCard.retrievedCount}`);
  lines.push(`  Admissible: ${sections.coverageCard.admissibleCount}`);
  lines.push(`  Evidence in brief: ${sections.coverageCard.evidenceCount}`);
  if (isFiltered) {
    lines.push(`  Visible after current filters: ${exportedRows.length}`);
  }
  if (sections.coverageCard.gapSummary) lines.push(`  What this evidence can support: ${sections.coverageCard.gapSummary}`);
  if (sections.coverageCard.regionalGap) lines.push(`  LAC evidence found: ${sections.coverageCard.regionalGap}`);
  if (sections.coverageCard.thinEvidenceAreas) lines.push(`  Thin evidence areas: ${sections.coverageCard.thinEvidenceAreas}`);
  if (sections.coverageCard.methodologicalGap) lines.push(`  Methods still needed: ${sections.coverageCard.methodologicalGap}`);
  lines.push('');

  // 5. Follow-up Questions
  if (sections.followUpQuestions.length > 0) {
    lines.push('--- 5. FOLLOW-UP QUESTIONS ---');
    sections.followUpQuestions.forEach((q, i) => lines.push(`  ${i + 1}. ${q}`));
    lines.push('');
  }

  // Warnings
  if (sections.warnings.length > 0) {
    lines.push('--- WARNINGS ---');
    sections.warnings.forEach((w) => lines.push(`  - ${w}`));
    lines.push('');
  }

  // References — table of sources with links
  lines.push(isFiltered ? '--- REFERENCES (filtered) ---' : '--- REFERENCES ---');
  lines.push('');
  exportedRows.forEach((row, i) => {
    const work = worksById[row.workId];
    const url = row.doi ? `https://doi.org/${row.doi}` : row.url || '';
    const authorArr = getAuthors(row, worksById[row.workId]);
    const authors = authorArr.length > 3
      ? `${authorArr.slice(0, 3).join(', ')} et al.`
      : authorArr.join(', ');
    const source = work?.source || row.sourceName || '';
    lines.push(`  [${i + 1}] ${authors} (${row.year || 'n.d.'}). "${row.title}." ${source}.`);
    if (url) lines.push(`      ${url}`);
  });
  lines.push('');

  // Audit footer
  lines.push('---');
  lines.push(`Model: ${brief.auditTrace.model} | Policy: ${brief.auditTrace.retrievalPolicy}`);
  lines.push('Generated by Horizon Scanner — IADB Evidence Intelligence Platform');

  await navigator.clipboard.writeText(lines.join('\n'));
}

// ---------------------------------------------------------------------------
// Export JSON with full context
// ---------------------------------------------------------------------------
// Word (.docx) export — brief synthesis + evidence table
// ---------------------------------------------------------------------------

/** Strip [workId] citation tags from text (they're for internal tracking only). */
function stripCitationTags(text: string): string {
  return text.replace(/\s*\[[^\]]{3,}\]/g, '').trim();
}

export async function exportBriefAsDocx(
  brief: EvidenceBrief,
  worksById: Record<string, Work>,
  rowsForExport?: EvidenceRow[],
): Promise<void> {
  // Loaded on demand — docx is ~600 KB and only needed when the user exports.
  const {
    Document, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell,
    WidthType, BorderStyle, AlignmentType, Packer,
  } = await import('docx');

  function parseBold(text: string) {
    const parts = text.split(/\*\*([^*]+)\*\*/g);
    return parts.map((part, i) =>
      i % 2 === 1 ? new TextRun({ text: part, bold: true }) : new TextRun({ text: part })
    );
  }
  const BORDER_NONE = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };
  const THIN_BORDER = { style: BorderStyle.SINGLE, size: 4, color: 'E2E8F0' };
  function cell(text: string, opts: { bold?: boolean; width?: number; shade?: string } = {}) {
    return new TableCell({
      width: opts.width ? { size: opts.width, type: WidthType.DXA } : undefined,
      shading: opts.shade ? { fill: opts.shade } : undefined,
      borders: { top: THIN_BORDER, bottom: THIN_BORDER, left: BORDER_NONE, right: BORDER_NONE },
      children: [new Paragraph({ children: [new TextRun({ text, bold: opts.bold ?? false, size: 18 })] })],
    });
  }

  const { sections } = brief;
  const exportedRows = rowsForExport ?? sections.evidenceRows;
  const generatedAt = brief.auditTrace.generatedAt
    ? new Date(brief.auditTrace.generatedAt).toLocaleString()
    : 'N/A';

  const children: (Paragraph | Table)[] = [];

  // ── Title ──
  children.push(new Paragraph({
    text: 'Evidence Brief',
    heading: HeadingLevel.TITLE,
  }));
  children.push(new Paragraph({
    children: [
      new TextRun({ text: brief.query, bold: true, size: 24 }),
    ],
    spacing: { after: 120 },
  }));
  children.push(new Paragraph({
    children: [new TextRun({ text: `Generated: ${generatedAt}`, size: 18, color: '64748B' })],
    spacing: { after: 400 },
  }));

  // ── § 1 Executive summary / bullets ──
  if ((sections.summaryBullets?.length ?? 0) > 0) {
    children.push(new Paragraph({
      text: '§ 1  Executive Synthesis',
      heading: HeadingLevel.HEADING_1,
      spacing: { before: 200, after: 160 },
    }));
    if (sections.abstractSummary) {
      children.push(new Paragraph({
        children: parseBold(stripCitationTags(sections.abstractSummary)),
        spacing: { after: 200 },
      }));
    }
    for (const bullet of sections.summaryBullets) {
      const cleaned = stripCitationTags(bullet);
      children.push(new Paragraph({
        children: parseBold(cleaned),
        spacing: { before: 100, after: 160 },
      }));
    }
  }

  // ── § 2 Methodology note ──
  if (sections.methodologyNote) {
    children.push(new Paragraph({
      text: '§ 2  Methodology',
      heading: HeadingLevel.HEADING_1,
      spacing: { before: 200, after: 160 },
    }));
    children.push(new Paragraph({
      children: [new TextRun({ text: stripCitationTags(sections.methodologyNote) })],
      spacing: { after: 200 },
    }));
  }

  // ── § 3 Coverage ──
  const cc = sections.coverageCard;
  if (cc) {
    children.push(new Paragraph({
      text: '§ 3  Coverage',
      heading: HeadingLevel.HEADING_1,
      spacing: { before: 200, after: 160 },
    }));
    const coverageLines = [
      `Searched: ${cc.retrievedCount ?? 'n/a'} papers | Filtered: ${cc.admissibleCount ?? 'n/a'} | In brief: ${cc.evidenceCount ?? 'n/a'}`,
      cc.gapSummary ? `Evidence scope: ${cc.gapSummary}` : null,
      cc.regionalGap ? `LAC evidence: ${cc.regionalGap}` : null,
      cc.methodologicalGap ? `Methods gap: ${cc.methodologicalGap}` : null,
    ].filter(Boolean) as string[];
    for (const line of coverageLines) {
      children.push(new Paragraph({
        children: [new TextRun({ text: line, size: 18 })],
        spacing: { after: 80 },
      }));
    }
  }

  // ── § 4 Evidence table ──
  if (exportedRows.length > 0) {
    children.push(new Paragraph({
      text: `§ 4  Evidence Table (${exportedRows.length} papers)`,
      heading: HeadingLevel.HEADING_1,
      spacing: { before: 400, after: 200 },
    }));

    const headerRow = new TableRow({
      tableHeader: true,
      children: [
        cell('#', { bold: true, width: 400, shade: 'F1F5F9' }),
        cell('Title', { bold: true, width: 3600, shade: 'F1F5F9' }),
        cell('Authors', { bold: true, width: 2000, shade: 'F1F5F9' }),
        cell('Year', { bold: true, width: 600, shade: 'F1F5F9' }),
        cell('Method', { bold: true, width: 1200, shade: 'F1F5F9' }),
        cell('SMS', { bold: true, width: 500, shade: 'F1F5F9' }),
        cell('Source', { bold: true, width: 1800, shade: 'F1F5F9' }),
      ],
    });

    const dataRows = exportedRows.map((row, i) => {
      const work = worksById[row.workId];
      const authors = getAuthors(row, work);
      const authorStr = authors.length > 3
        ? `${authors.slice(0, 3).join(', ')} et al.`
        : authors.join(', ') || 'n/a';
      const method = getMethodology(row, work);
      const sms = getSmsLevel(row, work);
      const source = getSource(row, work);
      return new TableRow({
        children: [
          cell(String(i + 1), { width: 400 }),
          cell(row.title ?? '', { width: 3600 }),
          cell(authorStr, { width: 2000 }),
          cell(String(row.year ?? 'n/a'), { width: 600 }),
          cell(method, { width: 1200 }),
          cell(sms != null ? String(sms) : 'n/a', { width: 500 }),
          cell(source, { width: 1800 }),
        ],
      });
    });

    children.push(new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: [headerRow, ...dataRows],
    }));
  }

  // ── § 5 Follow-up questions ──
  if ((sections.followUpQuestions?.length ?? 0) > 0) {
    children.push(new Paragraph({
      text: '§ 5  Follow-up Questions',
      heading: HeadingLevel.HEADING_1,
      spacing: { before: 400, after: 160 },
    }));
    sections.followUpQuestions.forEach((q, i) => {
      children.push(new Paragraph({
        children: [new TextRun({ text: `${i + 1}. ${q}`, size: 18 })],
        spacing: { after: 80 },
      }));
    });
  }

  // ── Footer ──
  children.push(new Paragraph({
    children: [new TextRun({
      text: `Generated by Horizon Scanner — IADB Evidence Intelligence Platform | Model: ${brief.auditTrace.model ?? 'N/A'}`,
      size: 16, color: '94A3B8',
    })],
    spacing: { before: 400 },
  }));

  const doc = new Document({
    styles: {
      default: {
        document: {
          run: { font: 'Calibri', size: 20 },
        },
      },
    },
    sections: [{ children }],
  });

  const blob = await Packer.toBlob(doc);
  const safeQuery = brief.query.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
  downloadBlob(blob, `horizon-brief-${safeQuery}.docx`);
}

// ---------------------------------------------------------------------------
// Word (.docx) export — JEL survey paper (prose sections + evidence table)
// ---------------------------------------------------------------------------

/**
 * Export a JEL survey paper as a Word (.docx) document: title + metadata,
 * abstract, all prose sections (Critical Assessment styled distinctly), and the
 * evidence table. Mirrors exportBriefAsDocx styling. `evidenceWorks` supply the
 * rich attributes (SMS, methodology, region) that don't live on JelBibEntry;
 * pass what's available and any missing work degrades to the bibliography fields.
 *
 * This is Word output of the reader-facing paper — the internal Editor-QA panels
 * (coherence/audit/integrity reports) are deliberately excluded.
 */
export async function exportJelPaperAsDocx(
  paper: JelPaper,
  evidenceWorks?: Work[],
): Promise<void> {
  const {
    Document, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell,
    WidthType, BorderStyle, Packer,
  } = await import('docx');

  const worksById: Record<string, Work> = {};
  for (const w of evidenceWorks ?? []) worksById[w.id] = w;

  const BORDER_NONE = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };
  const THIN_BORDER = { style: BorderStyle.SINGLE, size: 4, color: 'E2E8F0' };
  function cell(text: string, opts: { bold?: boolean; width?: number; shade?: string } = {}) {
    return new TableCell({
      width: opts.width ? { size: opts.width, type: WidthType.DXA } : undefined,
      shading: opts.shade ? { fill: opts.shade } : undefined,
      borders: { top: THIN_BORDER, bottom: THIN_BORDER, left: BORDER_NONE, right: BORDER_NONE },
      children: [new Paragraph({ children: [new TextRun({ text, bold: opts.bold ?? false, size: 18 })] })],
    });
  }

  // Split section prose into display paragraphs: blank lines separate paragraphs;
  // single newlines inside a paragraph collapse to spaces. [workId] tags stripped.
  function bodyToParagraphs(body: string): string[] {
    return stripCitationTags(body)
      .split(/\n\s*\n/)
      .map((p) => p.replace(/\s*\n\s*/g, ' ').trim())
      .filter(Boolean);
  }

  const title = paper.outline?.title ?? paper.query;
  const generatedAt = paper.completedAt
    ? new Date(paper.completedAt).toLocaleString()
    : (paper.createdAt ? new Date(paper.createdAt).toLocaleString() : 'pending');

  const children: (Paragraph | Table)[] = [];

  // ── Title + metadata ──
  children.push(new Paragraph({ text: title, heading: HeadingLevel.TITLE }));
  children.push(new Paragraph({
    children: [new TextRun({
      text: `Horizon Scanner · IADB Evidence Intelligence Platform · ${generatedAt}`,
      size: 18, color: '64748B',
    })],
    spacing: { after: 80 },
  }));
  children.push(new Paragraph({
    children: [new TextRun({
      text: `${paper.wordCount?.toLocaleString() ?? '—'} words · ${paper.citationCount ?? '—'} citations`,
      size: 18, color: '64748B',
    })],
    spacing: { after: 300 },
  }));

  // ── Abstract ──
  if (paper.outline?.abstract) {
    children.push(new Paragraph({
      text: 'Abstract', heading: HeadingLevel.HEADING_2,
      spacing: { before: 120, after: 120 },
    }));
    children.push(new Paragraph({
      children: [new TextRun({ text: paper.outline.abstract, italics: true })],
      spacing: { after: 300 },
    }));
  }

  // ── Prose sections ──
  for (const section of paper.sections) {
    const isCritique = String(section.number) === 'critique';
    const heading = isCritique
      ? section.heading
      : `§ ${section.number}  ${section.heading}`;
    children.push(new Paragraph({
      text: heading, heading: HeadingLevel.HEADING_1,
      spacing: { before: 300, after: 160 },
    }));
    for (const para of bodyToParagraphs(section.body)) {
      children.push(new Paragraph({
        children: [new TextRun({ text: para })],
        spacing: { after: 160 },
      }));
    }
  }

  // ── Evidence table ──
  const entries: JelBibEntry[] = paper.bibliography ?? [];
  if (entries.length > 0) {
    const citedCount = entries.filter((e) => e.cited).length;
    children.push(new Paragraph({
      text: `Evidence Table (${entries.length} papers${citedCount > 0 ? `, ${citedCount} cited` : ''})`,
      heading: HeadingLevel.HEADING_1,
      spacing: { before: 400, after: 200 },
    }));

    const headerRow = new TableRow({
      tableHeader: true,
      children: [
        cell('#', { bold: true, width: 400, shade: 'F1F5F9' }),
        cell('Authors', { bold: true, width: 1900, shade: 'F1F5F9' }),
        cell('Year', { bold: true, width: 600, shade: 'F1F5F9' }),
        cell('Title', { bold: true, width: 3400, shade: 'F1F5F9' }),
        cell('Source', { bold: true, width: 1600, shade: 'F1F5F9' }),
        cell('Method', { bold: true, width: 1100, shade: 'F1F5F9' }),
        cell('SMS', { bold: true, width: 450, shade: 'F1F5F9' }),
        cell('Cited', { bold: true, width: 550, shade: 'F1F5F9' }),
      ],
    });

    const dataRows = entries.map((e) => {
      const work = worksById[e.workId];
      const source = work?.venue || e.venue || work?.institution || work?.source || '';
      const method = work?.methodologyDesign || work?.methodology?.design || '';
      const sms = work?.smsLevel;
      const cited = e.cited ? 'yes' : '';
      const titleCell = e.unverified ? `${e.title} (unverified)` : e.title;
      return new TableRow({
        children: [
          cell(String(e.number), { width: 400 }),
          cell(e.authors ?? '', { width: 1900 }),
          cell(String(e.year ?? 'n.d.'), { width: 600 }),
          cell(titleCell ?? '', { width: 3400 }),
          cell(source, { width: 1600 }),
          cell(method, { width: 1100 }),
          cell(sms != null ? String(sms) : '', { width: 450 }),
          cell(cited, { width: 550 }),
        ],
      });
    });

    children.push(new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: [headerRow, ...dataRows],
    }));
  }

  // ── Footer ──
  children.push(new Paragraph({
    children: [new TextRun({
      text: 'Generated by Horizon Scanner — IADB Evidence Intelligence Platform',
      size: 16, color: '94A3B8',
    })],
    spacing: { before: 400 },
  }));

  const doc = new Document({
    styles: { default: { document: { run: { font: 'Calibri', size: 20 } } } },
    sections: [{ children }],
  });

  const blob = await Packer.toBlob(doc);
  const safe = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50);
  downloadBlob(blob, `jel-paper-${safe || 'survey'}.docx`);
}

// ---------------------------------------------------------------------------

export function exportBriefAsJson(
  brief: EvidenceBrief,
  worksById: Record<string, Work>,
  rowsForExport?: EvidenceRow[],
): void {
  // When the user has filtered the table, export the visible post-filter set.
  // The original brief.sections.evidenceRows is preserved in `briefBasisRows`
  // so downstream consumers (re-import, audit) can still see what the synthesis
  // was actually run over.
  const sourceRows = rowsForExport ?? brief.sections.evidenceRows;
  const isFiltered = rowsForExport != null && rowsForExport.length !== brief.sections.evidenceRows.length;
  const enrichedRows = sourceRows.map((row) => {
    const work = worksById[row.workId];
    return {
      ...row,
      doiUrl: row.doi ? `https://doi.org/${row.doi}` : null,
      region: getGeography(row, work),
      citationCount: work?.citationCount ?? null,
      smsLevel: getSmsLevel(row, work),
      absRating: work?.absRating ?? null,
      repecPercentile: work?.repecPercentile ?? null,
      venue: work?.venue ?? null,
      abstract: work?.abstract ?? null,
    };
  });

  const payload = {
    exportVersion: '1.1',
    exportedAt: new Date().toISOString(),
    query: brief.query,
    briefId: brief.id,
    status: brief.status,
    filterState: {
      isFiltered,
      visibleCount: enrichedRows.length,
      briefBasisCount: brief.sections.evidenceRows.length,
    },
    sections: {
      ...brief.sections,
      evidenceRows: enrichedRows,
      // Preserve the unfiltered original so re-import can rebuild the full
      // synthesis basis if needed.
      briefBasisRows: isFiltered ? brief.sections.evidenceRows : undefined,
    },
    auditTrace: brief.auditTrace,
    metadata: {
      generator: 'Horizon Scanner — IADB Evidence Intelligence Platform',
    },
  };

  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  downloadBlob(blob, `horizon-brief-${brief.id}${isFiltered ? '-filtered' : ''}.json`);
}

// ---------------------------------------------------------------------------
// PDF (print stylesheet)
// ---------------------------------------------------------------------------

export function printBriefAsPdf(): void {
  window.print();
}

// ---------------------------------------------------------------------------
// Citations — standalone export (CSV + bibliography-style clipboard)
// ---------------------------------------------------------------------------

// Normalize "smart" Unicode punctuation to ASCII so plain-text / CSV / clipboard
// exports never mojibake (e.g. em-dash "—" shown as "â€"") when the file is opened
// in a viewer that doesn't honour the UTF-8 BOM (Excel legacy import, Notepad, a
// terminal on a Windows codepage, paste into a non-UTF-8 cell). Generated prose +
// titles are full of em-dashes and curly quotes, so this runs on every export cell.
function asciiPunct(value: string): string {
  return value
    .replace(/[‒–—―]/g, '-')    // figure/en/em/horizontal dash -> -
    .replace(/[‘’‚‛]/g, "'")    // curly single quotes -> '
    .replace(/[“”„‟]/g, '"')    // curly double quotes -> "
    .replace(/…/g, '...')                       // ellipsis -> ...
    .replace(/[  ]/g, ' ')                 // non-breaking spaces -> space
    .replace(/[•·]/g, '*');                // bullets -> *
}

function csvEscape(value: string | number | null | undefined): string {
  if (value == null) return '';
  const str = asciiPunct(String(value));
  if (/[",\n\r]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

/**
 * Export the brief's citations as a CSV — one row per cited paper.
 * Columns: ref#, workId, authors, year, title, venue, methodology,
 * SMS, causal strength, citations, DOI, URL.
 */
export function exportEvidenceTableAsCsv(
  brief: EvidenceBrief,
  worksById: Record<string, Work>,
  rowsForExport?: EvidenceRow[],
  evidenceClassification?: EvidenceClassificationMap,
): void {
  const header = [
    'Ref',
    'WorkID',
    'Title',
    'Authors',
    'Year',
    'Region',
    'Source',
    'Type',
    'Methodology',
    'SMS',
    'Finding',
    'ABSRating',
    'RePEcPercentile',
    'DOI',
    'URL',
    'CitationCount',
  ];

  const sourceRows = rowsForExport ?? brief.sections.evidenceRows;
  const rows = sourceRows.map((row, i) => {
    const work = worksById[row.workId];
    const authors = getAuthors(row, work).join('; ');
    const geography = getGeography(row, work).join('; ') || 'Global';
    const doiUrl = row.doi ? `https://doi.org/${row.doi}` : '';
    const directUrl = row.url || work?.openAccessPdfUrl || '';
    const smsLevel = getSmsLevel(row, work);

    return [
      i + 1,
      row.workId,
      row.title,
      authors,
      row.year ?? '',
      geography,
      getSource(row, work),
      getPublicationType(work, row.sourceName),
      getMethodology(row, work),
      smsLevel ?? '',
      row.finding ?? '',
      work?.absRating ?? '',
      work?.repecPercentile ?? '',
      row.doi ?? '',
      doiUrl || directUrl,
      work?.citationCount ?? row.citationCount ?? '',
    ].map(csvEscape).join(',');
  });

  const csv = [header.map(csvEscape).join(','), ...rows].join('\r\n');
  const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' }); // BOM for Excel
  const filenameSafeQuery = brief.query
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  downloadBlob(blob, `evidence-table-${filenameSafeQuery || 'brief'}.csv`);
}

/**
 * Export a JEL survey paper's evidence table as a CSV — one row per evidence
 * paper, in the paper's bibliography order. Mirrors the brief evidence-table CSV
 * columns (Region, Source, Type, Methodology, SMS, citations, DOI/URL) and adds
 * a "Cited" column (whether the paper was cited in the survey prose).
 *
 * `evidenceWorks` are the corpus Work rows for the bibliography workIds (the
 * rich attributes live on Work, not on JelBibEntry); pass what's available and
 * any missing work degrades to the bibliography fields only.
 */
export function exportJelEvidenceTableAsCsv(
  paper: JelPaper,
  evidenceWorks?: Work[],
): void {
  const worksById: Record<string, Work> = {};
  for (const w of evidenceWorks ?? []) worksById[w.id] = w;

  const header = [
    'Ref',
    'Cited',
    'WorkID',
    'Title',
    'Authors',
    'Year',
    'Region',
    'Source',
    'Type',
    'Methodology',
    'SMS',
    'ABSRating',
    'Abstract',
    'DOI',
    'URL',
    'Unverified',
  ];

  const entries: JelBibEntry[] = paper.bibliography ?? [];
  const rows = entries.map((e) => {
    const work = worksById[e.workId];
    const region = regionsFromGeography(work?.geography || []).join('; ') || 'Global';
    const source = work?.venue || e.venue || work?.institution || work?.source || '';
    const method = work?.methodologyDesign || work?.methodology?.design || 'Unclassified';
    const type = getPublicationType(work, e.venue ?? undefined);
    const doiUrl = e.doi ? `https://doi.org/${e.doi}` : '';
    const directUrl = work?.openAccessPdfUrl || work?.url || '';

    return [
      e.number,
      e.cited ? 'cited' : 'not cited',
      e.workId,
      e.title,
      e.authors,
      e.year ?? '',
      region,
      source,
      type,
      method,
      work?.smsLevel ?? '',
      work?.absRating ?? '',
      work?.abstract ?? '',
      e.doi ?? '',
      doiUrl || directUrl,
      e.unverified ? 'unverified' : '',
    ].map(csvEscape).join(',');
  });

  const csv = [header.map(csvEscape).join(','), ...rows].join('\r\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }); // BOM for Excel
  const safe = (paper.outline?.title ?? paper.query)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  downloadBlob(blob, `jel-evidence-table-${safe || 'paper'}.csv`);
}

/**
 * Copy an APA-ish bibliography of the brief's citations to the clipboard.
 * Useful for pasting into a literature review or working paper.
 */
export async function copyCitationsAsText(
  brief: EvidenceBrief,
  worksById: Record<string, Work>,
): Promise<void> {
  const lines: string[] = [];
  lines.push(`References — ${brief.query}`);
  lines.push(`Exported ${new Date().toLocaleString()} from Horizon Scanner`);
  lines.push('');

  brief.sections.evidenceRows.forEach((row, i) => {
    const work = worksById[row.workId];
    const authorArr = getAuthors(row, work);
    const authors = authorArr.length > 0
      ? (authorArr.length > 6
        ? `${authorArr.slice(0, 6).join(', ')}, et al.`
        : authorArr.join(', '))
      : 'Unknown';
    const year = row.year ?? 'n.d.';
    const venue = work?.venue || row.sourceName || '';
    const url = row.doi ? `https://doi.org/${row.doi}` : (row.url || work?.openAccessPdfUrl || '');
    const badges = [
      getMethodology(row, work) !== 'Unclassified' ? getMethodology(row, work) : null,
      work?.smsLevel != null ? `SMS ${work.smsLevel}` : null,
      work?.citationCount ? `${work.citationCount} cites` : null,
    ].filter(Boolean).join(' · ');

    lines.push(`[${i + 1}] ${authors} (${year}). ${row.title}. ${venue}.`);
    if (url) lines.push(`    ${url}`);
    if (badges) lines.push(`    (${badges})`);
    lines.push('');
  });

  await navigator.clipboard.writeText(lines.join('\n').trim());
}

// ---------------------------------------------------------------------------
// Share link (currently no-op — sharePath is empty until sharing is wired)
// ---------------------------------------------------------------------------

/**
 * Copy the evidence table to the clipboard as tab-separated text.
 */
export async function copyEvidenceTableAsText(
  brief: EvidenceBrief,
  worksById: Record<string, Work>,
  rowsForExport?: EvidenceRow[],
  evidenceClassification?: EvidenceClassificationMap,
): Promise<void> {
  const lines: string[] = [];
  lines.push(`Evidence table - ${brief.query}`);
  lines.push(`Exported ${new Date().toLocaleString()} from Horizon Scanner`);
  lines.push('');
  lines.push([
    'Ref',
    'Title',
    'Authors',
    'Year',
    'Region',
    'Source',
    'Type',
    'Methodology',
    'SMS',
    'Finding',
    'DOI/URL',
  ].join('\t'));

  const sourceRows = rowsForExport ?? brief.sections.evidenceRows;
  sourceRows.forEach((row, i) => {
    const work = worksById[row.workId];
    const authors = getAuthors(row, work).join('; ') || 'Unknown';
    const geography = getGeography(row, work).join('; ') || 'Global';
    const url = row.doi ? `https://doi.org/${row.doi}` : (row.url || work?.openAccessPdfUrl || '');
    const smsLevel = getSmsLevel(row, work);

    lines.push([
      i + 1,
      row.title,
      authors,
      row.year ?? '',
      geography,
      getSource(row, work),
      getPublicationType(work, row.sourceName),
      getMethodology(row, work),
      smsLevel != null ? `SMS ${smsLevel}` : '',
      row.finding ?? '',
      url,
    ].map((value) => asciiPunct(String(value)).replace(/\s+/g, ' ').trim()).join('\t'));
  });

  await navigator.clipboard.writeText(lines.join('\n').trim());
}

export async function copyShareLink(brief: EvidenceBrief): Promise<boolean> {
  if (!brief.sharePath) return false;
  const shareUrl = `${window.location.origin}${brief.sharePath}`;
  await navigator.clipboard.writeText(shareUrl);
  return true;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  link.style.display = 'none';
  // The anchor MUST be in the DOM or .click() is a no-op in Firefox / some
  // Chromium webviews (the "download does nothing" bug). And the object URL must
  // be revoked on a later tick — revoking synchronously after click() races the
  // browser and cancels the download before it reads the blob.
  document.body.appendChild(link);
  link.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    link.remove();
  }, 1500);
}
