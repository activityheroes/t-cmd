/* ============================================================
   T-CMD — K4 PDF Generator
   Generates a Skatteverket K4 (SKV 2104) Section D PDF using
   jsPDF. Works entirely client-side — no server needed.

   The official k4-empty.pdf is an Adobe XFA form, which cannot
   be filled programmatically in the browser. This module instead
   replicates the SKV 2104 Section D layout pixel-for-pixel using
   jsPDF and delivers an immediately downloadable PDF.

   Usage:
     const buf = await K4PdfFiller.generate(k4Report, userInfo);
     // buf is an ArrayBuffer — wrap in Blob and trigger download
   ============================================================ */

window.K4PdfFiller = (() => {

  // ── Layout constants (A4 = 210 × 297 mm) ─────────────────
  const PAGE_W = 210;
  const PAGE_H = 297;
  const MARGIN_L = 14;
  const MARGIN_R = PAGE_W - 14;

  // Column left-edges and right-align anchors (mm)
  const COL = {
    antal:    { x: MARGIN_L, w: 24, label: 'Antal/\nBelopp' },
    beteckn:  { x: 39,       w: 56, label: 'Beteckning' },
    proc:     { x: 97,       w: 32, label: 'Försäljnings-\npris' },
    cost:     { x: 131,      w: 32, label: 'Omkostnads-\nbelopp' },
    vinst:    { x: 165,      w: 22, label: 'Vinst' },
    forlust:  { x: 189,      w: 17, label: 'Förlust' },
  };

  const ROWS_PER_PAGE = 7;
  const ROW_H         = 10;   // mm per data row
  const TABLE_TOP     = 54;   // y where first data row starts
  const HDR_TOP       = 44;   // y of column header row

  // ── Helpers ───────────────────────────────────────────────
  function fmtSEK(val) {
    if (val == null || val === 0) return '';
    return Math.round(val).toLocaleString('sv-SE');
  }

  function fmtQty(val) {
    if (val == null || val === 0) return '';
    // Show up to 8 significant digits, trim trailing zeros
    const s = parseFloat(val.toPrecision(8)).toString();
    return s.replace('.', ',');
  }

  function rAlign(doc, text, rightX, y) {
    const w = doc.getTextWidth(text);
    doc.text(text, rightX - w, y);
  }

  function chunk(arr, size) {
    const result = [];
    for (let i = 0; i < arr.length; i += size) result.push(arr.slice(i, i + size));
    return result.length ? result : [[]];
  }

  // ── Page layout ───────────────────────────────────────────
  function drawPageHeader(doc, userInfo, pageNum, totalPages) {
    const { name = '', pnr = '', year } = userInfo;

    // Top bar background
    doc.setFillColor(0, 70, 127); // Skatteverket dark blue
    doc.rect(MARGIN_L, 8, PAGE_W - 28, 8, 'F');

    // "Skatteverket" white text
    doc.setFontSize(9);
    doc.setTextColor(255, 255, 255);
    doc.setFont('helvetica', 'bold');
    doc.text('Skatteverket', MARGIN_L + 2, 13.5);

    // Title right-aligned
    doc.setFontSize(8);
    doc.text('K4 – Avyttring av värdepapper m.m.', MARGIN_R, 13.5, { align: 'right' });

    // Reset colour
    doc.setTextColor(0, 0, 0);
    doc.setFont('helvetica', 'normal');

    // Inkomstår + bilaga nr
    doc.setFontSize(8);
    doc.text(`Inkomstår: ${year}`, MARGIN_R, 21, { align: 'right' });
    doc.text(`Bilaga K4 nr: ${pageNum} av ${totalPages}`, MARGIN_R, 25.5, { align: 'right' });
    doc.text('SKV 2104', MARGIN_R, 30, { align: 'right' });

    // Namn + Personnummer
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7.5);
    doc.text('Namn', MARGIN_L, 21);
    doc.text('Personnummer', 110, 21);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.text(name || '—', MARGIN_L, 26);
    doc.text(pnr  || '—', 110, 26);

    // Horizontal rule
    doc.setDrawColor(0, 70, 127);
    doc.setLineWidth(0.4);
    doc.line(MARGIN_L, 30, MARGIN_R, 30);
    doc.setDrawColor(0, 0, 0);
    doc.setLineWidth(0.2);
  }

  function drawSectionHeader(doc) {
    doc.setFontSize(8.5);
    doc.setFont('helvetica', 'bold');
    doc.text('D', MARGIN_L, 37);
    doc.setFont('helvetica', 'normal');
    doc.text(
      'Övriga värdepapper, andra tillgångar (kapitalplaceringar t.ex. råvaror, kryptovalutor)',
      MARGIN_L + 5, 37
    );
    doc.setFontSize(7.5);
    doc.setTextColor(80, 80, 80);
    doc.text(
      'Genomsnittsmetoden tillämpas. Belopp i hela kronor (SEK). Vinst eller Förlust – aldrig båda.',
      MARGIN_L + 5, 41
    );
    doc.setTextColor(0, 0, 0);
  }

  function drawTableHeader(doc) {
    // Gray fill for header row
    doc.setFillColor(220, 225, 232);
    doc.rect(MARGIN_L, HDR_TOP, MARGIN_R - MARGIN_L, 9, 'F');

    doc.setFontSize(6.8);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(30, 30, 30);

    const yLine1 = HDR_TOP + 4;
    const yLine2 = HDR_TOP + 7.5;

    // Antal (two-line)
    doc.text('Antal/', COL.antal.x, yLine1);
    doc.text('Belopp', COL.antal.x, yLine2);

    // Beteckning
    doc.text('Beteckning', COL.beteckn.x, yLine1);

    // Försäljningspris (two-line, right-aligned)
    const pRa = COL.proc.x + COL.proc.w;
    rAlign(doc, 'Försäljnings-', pRa, yLine1);
    rAlign(doc, 'pris', pRa, yLine2);

    // Omkostnadsbelopp (two-line, right-aligned)
    const cRa = COL.cost.x + COL.cost.w;
    rAlign(doc, 'Omkostnads-', cRa, yLine1);
    rAlign(doc, 'belopp', cRa, yLine2);

    // Vinst
    rAlign(doc, 'Vinst', COL.vinst.x + COL.vinst.w, yLine1);

    // Förlust
    rAlign(doc, 'Förlust', COL.forlust.x + COL.forlust.w, yLine1);

    doc.setFont('helvetica', 'normal');
    doc.setTextColor(0, 0, 0);

    // Bottom border of header
    doc.setDrawColor(100, 100, 100);
    doc.setLineWidth(0.3);
    doc.line(MARGIN_L, HDR_TOP + 9, MARGIN_R, HDR_TOP + 9);
    doc.setLineWidth(0.1);
  }

  function drawRow(doc, row, rowIndex) {
    const y = TABLE_TOP + rowIndex * ROW_H;
    const textY = y + 6.5; // baseline within the 10mm row

    // Alternating very light row tint
    if (rowIndex % 2 === 1) {
      doc.setFillColor(246, 248, 251);
      doc.rect(MARGIN_L, y, MARGIN_R - MARGIN_L, ROW_H, 'F');
    }

    doc.setFontSize(8);
    doc.setFont('helvetica', 'normal');

    // Antal
    const qtyStr = fmtQty(row.qty);
    rAlign(doc, qtyStr, COL.antal.x + COL.antal.w, textY);

    // Beteckning — truncate long names
    const label = (row.displayName || row.sym || '').substring(0, 28);
    doc.text(label, COL.beteckn.x, textY);

    // Försäljningspris
    rAlign(doc, fmtSEK(row.proc), COL.proc.x + COL.proc.w, textY);

    // Omkostnadsbelopp
    rAlign(doc, fmtSEK(row.cost), COL.cost.x + COL.cost.w, textY);

    // Vinst OR Förlust — never both
    if (row.side === 'gain' && row.gain > 0) {
      doc.setTextColor(0, 110, 40);
      rAlign(doc, fmtSEK(row.gain), COL.vinst.x + COL.vinst.w, textY);
      doc.setTextColor(0, 0, 0);
    } else if (row.side === 'loss' && row.loss > 0) {
      doc.setTextColor(180, 0, 0);
      rAlign(doc, fmtSEK(row.loss), COL.forlust.x + COL.forlust.w, textY);
      doc.setTextColor(0, 0, 0);
    }

    // Row bottom separator
    doc.setDrawColor(200, 200, 200);
    doc.setLineWidth(0.1);
    doc.line(MARGIN_L, y + ROW_H, MARGIN_R, y + ROW_H);
    doc.setDrawColor(0, 0, 0);
  }

  function drawTotalsRow(doc, rows, isLastPage, grandTotals) {
    // Position below last row (fill empty rows up to 7)
    const afterLastRow = TABLE_TOP + ROWS_PER_PAGE * ROW_H;
    const y = afterLastRow;
    const textY = y + 6.5;

    // Bold border above totals
    doc.setDrawColor(0, 70, 127);
    doc.setLineWidth(0.5);
    doc.line(MARGIN_L, y, MARGIN_R, y);
    doc.setLineWidth(0.2);
    doc.setDrawColor(0, 0, 0);

    // Light tint
    doc.setFillColor(230, 235, 242);
    doc.rect(MARGIN_L, y, MARGIN_R - MARGIN_L, ROW_H, 'F');

    doc.setFontSize(8);
    doc.setFont('helvetica', 'bold');

    // For intermediate pages show page sub-total;
    // for last page show grand total
    const totals = isLastPage ? grandTotals : (() => {
      return rows.reduce((acc, r) => ({
        proc: acc.proc + (r.proc || 0),
        cost: acc.cost + (r.cost || 0),
        gain: acc.gain + (r.gain || 0),
        loss: acc.loss + (r.loss || 0),
      }), { proc: 0, cost: 0, gain: 0, loss: 0 });
    })();

    const label = isLastPage ? 'Totalt' : 'Delsumma';
    doc.text(label, MARGIN_L, textY);

    rAlign(doc, fmtSEK(totals.proc), COL.proc.x + COL.proc.w, textY);
    rAlign(doc, fmtSEK(totals.cost), COL.cost.x + COL.cost.w, textY);

    if (totals.gain > 0) {
      doc.setTextColor(0, 110, 40);
      rAlign(doc, fmtSEK(totals.gain), COL.vinst.x + COL.vinst.w, textY);
      doc.setTextColor(0, 0, 0);
    }
    if (totals.loss > 0) {
      doc.setTextColor(180, 0, 0);
      rAlign(doc, fmtSEK(totals.loss), COL.forlust.x + COL.forlust.w, textY);
      doc.setTextColor(0, 0, 0);
    }

    doc.setFont('helvetica', 'normal');

    // Outer border
    doc.setDrawColor(0, 70, 127);
    doc.setLineWidth(0.4);
    doc.line(MARGIN_L, y + ROW_H, MARGIN_R, y + ROW_H);
    doc.setLineWidth(0.2);
    doc.setDrawColor(0, 0, 0);
  }

  function drawTableBorder(doc) {
    const tableBottom = TABLE_TOP + ROWS_PER_PAGE * ROW_H + ROW_H; // includes totals row
    doc.setDrawColor(80, 80, 80);
    doc.setLineWidth(0.3);
    doc.rect(MARGIN_L, HDR_TOP, MARGIN_R - MARGIN_L, tableBottom - HDR_TOP);
    // Vertical column dividers
    const dividers = [
      COL.beteckn.x,
      COL.proc.x,
      COL.cost.x,
      COL.vinst.x,
      COL.forlust.x,
    ];
    dividers.forEach(x => {
      doc.line(x, HDR_TOP, x, tableBottom);
    });
    doc.setLineWidth(0.2);
    doc.setDrawColor(0, 0, 0);
  }

  function drawFooter(doc, isLastPage, grandTotals) {
    const footerY = TABLE_TOP + ROWS_PER_PAGE * ROW_H + ROW_H + 6;

    doc.setFontSize(6.8);
    doc.setTextColor(80, 80, 80);
    doc.text(
      'Beräknad enligt genomsnittsmetoden (SFS 1999:1229, 44 kap. 7 §, IL). Belopp i hela kronor (SEK).',
      MARGIN_L, footerY
    );

    if (isLastPage && grandTotals) {
      // Declaration boxes referencing the main declaration form
      const boxY = footerY + 8;
      doc.setFontSize(7.5);
      doc.setTextColor(0, 0, 0);
      doc.setFont('helvetica', 'bold');
      doc.text('För ifyllnad av inkomstdeklaration 1:', MARGIN_L, boxY);
      doc.setFont('helvetica', 'normal');

      // Ruta 7.4 / 7.5 (gains)
      doc.setFontSize(7);
      doc.text(`Ruta 7.4 (Vinst på övriga tillgångar):  ${fmtSEK(grandTotals.proc)} kr`, MARGIN_L, boxY + 6);
      doc.text(`Ruta 7.5 (Vinst):   ${fmtSEK(grandTotals.gain)} kr`, MARGIN_L, boxY + 11);
      // Ruta 8.4 (losses — deductible at 70%)
      const deductible = Math.round(grandTotals.loss * 0.70);
      doc.text(`Ruta 8.4 (Förlust, avdragsgill 70%):   ${fmtSEK(deductible)} kr`, MARGIN_L, boxY + 16);

      doc.setTextColor(80, 80, 80);
    }

    // Page number bottom-right
    doc.setFontSize(7);
    doc.text('www.skatteverket.se', MARGIN_R, PAGE_H - 8, { align: 'right' });
  }

  // ── Main generator ────────────────────────────────────────
  async function generate(k4Report, userInfo) {
    // Require jsPDF to be loaded
    if (typeof jspdf === 'undefined' && typeof window.jspdf === 'undefined') {
      throw new Error('jsPDF library not loaded. Add the CDN script tag to index.html.');
    }

    const { jsPDF } = (typeof jspdf !== 'undefined' ? jspdf : window.jspdf);
    const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });

    // Use a font that supports Swedish characters
    doc.setFont('helvetica');

    const { k4Rows = [], totalGains = 0, totalLosses = 0, year } = k4Report;
    const info = { ...userInfo, year: year || userInfo.year };

    const pages = chunk(k4Rows, ROWS_PER_PAGE);
    const totalPages = pages.length;

    const grandTotals = {
      proc: k4Rows.reduce((s, r) => s + (r.proc || 0), 0),
      cost: k4Rows.reduce((s, r) => s + (r.cost || 0), 0),
      gain: totalGains,
      loss: totalLosses,
    };

    pages.forEach((rows, pageIdx) => {
      if (pageIdx > 0) doc.addPage();
      const isLastPage = pageIdx === totalPages - 1;

      drawPageHeader(doc, info, pageIdx + 1, totalPages);
      drawSectionHeader(doc);
      drawTableHeader(doc);

      // Draw rows (fill up to 7 even if fewer)
      rows.forEach((row, i) => drawRow(doc, row, i));

      drawTotalsRow(doc, rows, isLastPage, grandTotals);
      drawTableBorder(doc);
      drawFooter(doc, isLastPage, isLastPage ? grandTotals : null);
    });

    // Return as ArrayBuffer for Blob creation
    return doc.output('arraybuffer');
  }

  return { generate };
})();
