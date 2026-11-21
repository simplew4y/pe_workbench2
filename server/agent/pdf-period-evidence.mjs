import { pdfReportAmounts } from '../../lib/financial-evidence.mjs';
import { pdfPageRanges } from '../../lib/pdf-period-evidence.mjs';
import { toolEvidenceState } from '../../lib/citations.mjs';
import { dividendTotals } from '../../lib/pdf-dividend-evidence.mjs';
import { pdfReportIssuer } from '../../lib/fact-memory/pdf-semantic.mjs';

export async function readCitedPdfReports(ctx, attachments, calls, answer, includePage) {
  const ranges = pdfPageRanges(answer);
  if (!ctx?.pdfs) return [];

  const ids = new Set();
  for (const path of attachments || []) {
    if (!/\.pdf$/i.test(path)) continue;
    const material = ctx.store.findMaterialByPath(path);
    if (material) ids.add(material.id);
  }
  const reads = calls.flatMap(call => {
    const details = call.details || call.result?.details;
    return call.name === 'pdf_read' && call.success && details?.materialId && toolEvidenceState(call) === 'success' ? [details] : [];
  });
  for (const read of reads) ids.add(read.materialId);

  const reports = await Promise.all([...ids].map(async id => {
    const row = ctx.store.getVersionRow(id);
    if (!row) return null;
    const filename = row.version.displayName;
    const version = row.version.v;
    const material = {filename, materialId:id, version, sha256:row.version.blob_sha256};
    const readPages = new Set(reads.filter(read => read.materialId === id && read.version === version &&
      read.sha256 === row.version.blob_sha256).flatMap(read => (read.evidence || []).map(page => page.page)));
    if (!ranges.length && !readPages.size && !includePage) return { ...material, facts: [] };
    try {
      const { document } = await ctx.pdfs.getForMaterial(id, version);
      const issuer = pdfReportIssuer(document);
      const facts = document.pages
        .filter(page => !page.scanned && (includePage?.(page) || readPages.has(page.page) ||
          ranges.some(([first, last]) => first <= page.page && page.page <= last)))
        .flatMap(page => pdfReportAmounts(page, issuer));
      return { ...material, facts: [...facts, ...dividendTotals(facts)] };
    } catch (error) {
      console.warn('[chat] Could not check PDF reporting periods:', error.message);
      return { filename, facts: [] };
    }
  }));
  return reports.filter(Boolean);
}
