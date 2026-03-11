/* ============================================================
   T-CMD — K4 PDF Generator  (AcroForm field-fill approach)
   Fills the official Skatteverket K4 (SKV 2104) template PDF
   using its built-in form fields — no coordinate guessing.
   Crypto disposals go in Section D (Övriga värdepapper).
   ============================================================ */

const K4PDFGenerator = (() => {

    const ROWS_PER_PAGE = 7; // Section D allows 7 data rows per page

    // ── Field name templates ───────────────────────────────────
    // The K4 PDF uses XFA/AcroForm fields with this naming convention:
    //   BlankettTaxFormular[0].Sida2[0].subD[0].subTabell[0].subRad{N}[0].TxtAntal[0]
    // Where N = 1-7 for data rows, 8 for sum row.
    // Header fields are on Sida1.

    const HEADER = {
        date: 'BlankettTaxFormular[0].Sida1[0].subHuvud[0].subdatum[0].TxtDatFramst[0]',
        numrering: 'BlankettTaxFormular[0].Sida1[0].subHuvud[0].subNumrering[0].TxtFler[0]',
        namn: 'BlankettTaxFormular[0].Sida1[0].subHuvud[0].subnamn[0].TxtSkattskyldig-namn[0]',
        personnummer: 'BlankettTaxFormular[0].Sida1[0].subHuvud[0].subPersonnummer[0].TxtPersOrgNr[0]',
    };

    // Section D Personnummer (on page 2)
    const D_PNR = 'BlankettTaxFormular[0].Sida2[0].subD[0].TxtPnr[0]';

    // Build field name for Section D row N (1-7 for data, 8 for sums)
    function dField(rowNum, col) {
        return `BlankettTaxFormular[0].Sida2[0].subD[0].subTabell[0].subRad${rowNum}[0].${col}[0]`;
    }

    // Column field names within a row
    const COLS = {
        antal: 'TxtAntal',
        beteckning: 'TxtBeteckning',
        forsaljning: 'TxtForsaljningspris',
        omkostnad: 'TxtOmkostnadsbelopp',
        vinst: 'TxtVinst',
        forlust: 'TxtForlust',
    };

    // Sum row column names (row 8)
    const SUM_COLS = {
        forsaljning: 'TxtForsaljningspris',
        omkostnad: 'TxtOmkostnadsbelopp',
        vinst: 'TxtVinst',
        forlust: 'TxtForlust',
    };

    /**
     * Generate a K4 PDF by filling the official template form fields.
     * @param {Object} taxResult - from TaxEngine.computeTaxYear()
     * @param {Object} userInfo - { name, personnummer }
     * @param {number} year - tax year
     * @returns {Promise<Uint8Array>} - PDF bytes
     */
    async function generateK4PDF(taxResult, userInfo = {}, year) {
        if (typeof PDFLib === 'undefined') {
            throw new Error('pdf-lib not loaded. Add <script src="https://unpkg.com/pdf-lib@1.17.1/dist/pdf-lib.min.js"></script>');
        }

        const { PDFDocument } = PDFLib;

        // Generate K4 report data
        const k4Data = TaxEngine.generateK4Report(taxResult, userInfo);
        const { k4Rows, totalGains, totalLosses, formsNeeded } = k4Data;

        // Load the template
        let templateBytes;
        try {
            const response = await fetch('assets/k4-template.pdf');
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            templateBytes = await response.arrayBuffer();
        } catch (e) {
            throw new Error('Could not load K4 template PDF. ' + e.message);
        }

        const today = new Date().toLocaleDateString('sv-SE');

        // If only one form needed, fill the original template directly
        if (formsNeeded <= 1) {
            const pdfDoc = await PDFDocument.load(templateBytes, { ignoreEncryption: true });
            const form = pdfDoc.getForm();

            // Fill header
            setField(form, HEADER.date, today);
            if (userInfo.name) setField(form, HEADER.namn, userInfo.name);
            if (userInfo.personnummer) setField(form, HEADER.personnummer, userInfo.personnummer);

            // Fill Section D rows
            fillSectionD(form, k4Rows, 0);

            // Flatten so fields become static text (looks nicer, prevents editing)
            form.flatten();

            return await pdfDoc.save();
        }

        // Multiple forms needed — combine pages from multiple filled templates
        const outputPdf = await PDFDocument.create();

        for (let pageIdx = 0; pageIdx < formsNeeded; pageIdx++) {
            const pageRows = k4Rows.slice(pageIdx * ROWS_PER_PAGE, (pageIdx + 1) * ROWS_PER_PAGE);

            // Load a fresh copy of the template for each form
            const pagePdf = await PDFDocument.load(templateBytes, { ignoreEncryption: true });
            const form = pagePdf.getForm();

            // Fill header
            setField(form, HEADER.date, today);
            setField(form, HEADER.numrering, `Blankett ${pageIdx + 1} av ${formsNeeded}`);
            if (userInfo.name) setField(form, HEADER.namn, userInfo.name);
            if (userInfo.personnummer) setField(form, HEADER.personnummer, userInfo.personnummer);

            // Fill Section D rows for this page
            fillSectionD(form, pageRows, pageIdx === formsNeeded - 1 ? 0 : -1);

            // Flatten so field names don't conflict when combining
            form.flatten();

            // Copy all pages from this filled form into the output
            const copiedPages = await outputPdf.copyPages(pagePdf, pagePdf.getPageIndices());
            for (const p of copiedPages) {
                outputPdf.addPage(p);
            }
        }

        return await outputPdf.save();
    }

    /**
     * Fill Section D rows and sum row in a K4 form.
     */
    function fillSectionD(form, rows, sumMode) {
        let totalProc = 0, totalCost = 0, totalGain = 0, totalLoss = 0;

        for (let i = 0; i < rows.length && i < ROWS_PER_PAGE; i++) {
            const r = rows[i];
            const rowNum = i + 1; // Rows are 1-indexed

            setField(form, dField(rowNum, COLS.antal), formatQty(r.qty));
            setField(form, dField(rowNum, COLS.beteckning), `${r.displayName || r.sym} kryptovaluta`);
            setField(form, dField(rowNum, COLS.forsaljning), String(Math.round(r.proc)));
            setField(form, dField(rowNum, COLS.omkostnad), String(Math.round(r.cost)));

            if (r.gain > 0) {
                setField(form, dField(rowNum, COLS.vinst), String(Math.round(r.gain)));
            }
            if (r.loss > 0) {
                setField(form, dField(rowNum, COLS.forlust), String(Math.round(r.loss)));
            }

            totalProc += r.proc || 0;
            totalCost += r.cost || 0;
            totalGain += r.gain || 0;
            totalLoss += r.loss || 0;
        }

        // Sum row (row 8) — only has Försäljningspris, Omkostnadsbelopp, Vinst, Förlust
        if (sumMode !== -1) {
            setField(form, dField(8, SUM_COLS.forsaljning), String(Math.round(totalProc)));
            setField(form, dField(8, SUM_COLS.omkostnad), String(Math.round(totalCost)));
            if (totalGain > 0) setField(form, dField(8, SUM_COLS.vinst), String(Math.round(totalGain)));
            if (totalLoss > 0) setField(form, dField(8, SUM_COLS.forlust), String(Math.round(totalLoss)));
        }
    }

    /**
     * Safely set a form field value. Silently skips if field not found.
     */
    function setField(form, name, value) {
        try {
            const field = form.getTextField(name);
            field.setText(value);
        } catch (e) {
            // Field not found — template may differ slightly
            console.warn('[K4PDF] Field not found:', name);
        }
    }

    /**
     * Generate and trigger download of K4 PDF
     */
    async function downloadK4PDF(taxResult, userInfo = {}, year) {
        const pdfBytes = await generateK4PDF(taxResult, userInfo, year);
        const blob = new Blob([pdfBytes], { type: 'application/pdf' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `K4_${year}_kryptovalutor.pdf`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    // ── Helpers ────────────────────────────────────────────────
    function formatQty(n) {
        if (!n || n === 0) return '0';
        if (Number.isInteger(n)) return String(n);
        return parseFloat(n.toFixed(8)).toString();
    }

    // ── Public API ─────────────────────────────────────────────
    return {
        generateK4PDF,
        downloadK4PDF,
    };

})();
