/* ============================================================
   T-CMD — K4 PDF Generator
   Fills the official Skatteverket K4 (SKV 2104) template PDF
   with crypto disposal data using pdf-lib.
   Section D: Övriga värdepapper, andra tillgångar (kryptovalutor)
   ============================================================ */

const K4PDFGenerator = (() => {

    const ROWS_PER_PAGE = 7; // Section D allows 7 rows per page

    // ── Field coordinates for Section D on K4 template ──────
    // These are approximate positions based on the official form layout.
    // Page 2 of K4 contains Section D.
    // Coordinates are in PDF points (1 point = 1/72 inch), origin at bottom-left.
    const HEADER_FIELDS = {
        inkomstar: { x: 415, y: 782, size: 11 },   // Income year (top right header)
        datum: { x: 415, y: 762, size: 9 },     // Date form filled
        numrering: { x: 540, y: 782, size: 10 },    // "Blankett X av Y"
        namn: { x: 72, y: 782, size: 10 },    // Name
        personnummer: { x: 72, y: 762, size: 10 },    // Personal ID number
    };

    // Each row in Section D has these column positions (X coordinates)
    const COL_X = {
        antal: 72,   // Antal/Belopp
        beteckning: 160,  // Beteckning/Valutakod
        forsaljning: 335,  // Försäljningspris (SEK)
        omkostnad: 420,  // Omkostnadsbelopp (SEK)
        vinst: 495,  // Vinst
        forlust: 545,  // Förlust
    };

    // Row Y positions (from top of Section D area on page 2)
    // These are the vertical centers of each of the 7 data rows
    const ROW_Y_START = 555;  // First row Y position
    const ROW_HEIGHT = 22;   // Height between rows

    // Totals row Y position
    const TOTALS_Y = ROW_Y_START - (ROWS_PER_PAGE * ROW_HEIGHT) - 15;

    /**
     * Generate a K4 PDF by filling the official template.
     * @param {Object} taxResult - from TaxEngine.computeTaxYear()
     * @param {Object} userInfo - { name, personnummer }
     * @param {number} year - tax year
     * @returns {Promise<Uint8Array>} - PDF bytes
     */
    async function generateK4PDF(taxResult, userInfo = {}, year) {
        // Load pdf-lib (must be available globally via CDN)
        if (typeof PDFLib === 'undefined') {
            throw new Error('pdf-lib not loaded. Add <script src="https://unpkg.com/pdf-lib@1.17.1/dist/pdf-lib.min.js"></script> to your HTML.');
        }

        const { PDFDocument, rgb, StandardFonts } = PDFLib;

        // Generate K4 report data from TaxEngine
        const k4Data = TaxEngine.generateK4Report(taxResult, userInfo);
        const { k4Rows, totalGains, totalLosses, formsNeeded } = k4Data;

        // Load the template
        let templateBytes;
        try {
            const response = await fetch('assets/k4-template.pdf');
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            templateBytes = await response.arrayBuffer();
        } catch (e) {
            throw new Error('Could not load K4 template PDF. Make sure assets/k4-template.pdf exists. ' + e.message);
        }

        // Create the output document
        const outputPdf = await PDFDocument.create();
        const font = await outputPdf.embedFont(StandardFonts.Helvetica);
        const fontBold = await outputPdf.embedFont(StandardFonts.HelveticaBold);
        const today = new Date().toLocaleDateString('sv-SE');

        // For each page of K4 rows needed
        for (let pageIdx = 0; pageIdx < formsNeeded; pageIdx++) {
            const pageRows = k4Rows.slice(pageIdx * ROWS_PER_PAGE, (pageIdx + 1) * ROWS_PER_PAGE);

            // Load fresh template for each page
            const templatePdf = await PDFDocument.load(templateBytes);
            const templatePages = templatePdf.getPages();

            // Copy all pages from template (usually 2 pages: page 1 = A-C, page 2 = D)
            const copiedPages = await outputPdf.copyPages(templatePdf, templatePages.map((_, i) => i));
            for (const p of copiedPages) {
                outputPdf.addPage(p);
            }

            // Get the pages we just added — Section D is on page 2 of each K4 form
            const totalPagesNow = outputPdf.getPageCount();
            const sectionDPage = outputPdf.getPage(totalPagesNow - 1); // Last page = Section D
            const headerPage = outputPdf.getPage(totalPagesNow - copiedPages.length); // First page of this form

            const textColor = rgb(0, 0, 0);
            const textOpts = { font, color: textColor };

            // ── Fill header fields (on page 1 of this form) ─────
            headerPage.drawText(String(year || ''), {
                x: HEADER_FIELDS.inkomstar.x, y: HEADER_FIELDS.inkomstar.y,
                size: HEADER_FIELDS.inkomstar.size, font: fontBold, color: textColor,
            });
            headerPage.drawText(today, {
                x: HEADER_FIELDS.datum.x, y: HEADER_FIELDS.datum.y,
                size: HEADER_FIELDS.datum.size, ...textOpts,
            });
            if (formsNeeded > 1) {
                headerPage.drawText(`${pageIdx + 1}`, {
                    x: HEADER_FIELDS.numrering.x, y: HEADER_FIELDS.numrering.y,
                    size: HEADER_FIELDS.numrering.size, ...textOpts,
                });
            }
            if (userInfo.name) {
                headerPage.drawText(userInfo.name, {
                    x: HEADER_FIELDS.namn.x, y: HEADER_FIELDS.namn.y,
                    size: HEADER_FIELDS.namn.size, ...textOpts,
                });
            }
            if (userInfo.personnummer) {
                headerPage.drawText(userInfo.personnummer, {
                    x: HEADER_FIELDS.personnummer.x, y: HEADER_FIELDS.personnummer.y,
                    size: HEADER_FIELDS.personnummer.size, ...textOpts,
                });
            }

            // ── Fill Section D rows ─────────────────────────────
            for (let rowIdx = 0; rowIdx < pageRows.length; rowIdx++) {
                const row = pageRows[rowIdx];
                const y = ROW_Y_START - (rowIdx * ROW_HEIGHT);
                const sz = 8;

                // Antal (quantity) — formatted with up to 8 decimals
                sectionDPage.drawText(formatQty(row.qty), {
                    x: COL_X.antal, y, size: sz, ...textOpts,
                });

                // Beteckning — asset name + "(kryptovaluta)"
                const beteckning = `${row.displayName || row.sym} kryptovaluta`;
                sectionDPage.drawText(truncate(beteckning, 28), {
                    x: COL_X.beteckning, y, size: sz, ...textOpts,
                });

                // Försäljningspris — whole SEK
                sectionDPage.drawText(String(Math.round(row.proc)), {
                    x: COL_X.forsaljning, y, size: sz, ...textOpts,
                });

                // Omkostnadsbelopp — whole SEK
                sectionDPage.drawText(String(Math.round(row.cost)), {
                    x: COL_X.omkostnad, y, size: sz, ...textOpts,
                });

                // Vinst OR Förlust — never both (whole SEK)
                if (row.gain > 0) {
                    sectionDPage.drawText(String(Math.round(row.gain)), {
                        x: COL_X.vinst, y, size: sz, ...textOpts,
                    });
                }
                if (row.loss > 0) {
                    sectionDPage.drawText(String(Math.round(row.loss)), {
                        x: COL_X.forlust, y, size: sz, ...textOpts,
                    });
                }
            }

            // ── Fill totals row ─────────────────────────────────
            const pageGain = pageRows.reduce((s, r) => s + r.gain, 0);
            const pageLoss = pageRows.reduce((s, r) => s + r.loss, 0);

            if (pageGain > 0) {
                sectionDPage.drawText(String(Math.round(pageGain)), {
                    x: COL_X.vinst, y: TOTALS_Y, size: 9, font: fontBold, color: textColor,
                });
            }
            if (pageLoss > 0) {
                sectionDPage.drawText(String(Math.round(pageLoss)), {
                    x: COL_X.forlust, y: TOTALS_Y, size: 9, font: fontBold, color: textColor,
                });
            }
        }

        // Serialize to bytes
        return await outputPdf.save();
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
        // Remove trailing zeros, max 8 decimals
        return parseFloat(n.toFixed(8)).toString();
    }

    function truncate(str, max) {
        return str.length > max ? str.slice(0, max - 1) + '…' : str;
    }

    // ── Public API ─────────────────────────────────────────────
    return {
        generateK4PDF,
        downloadK4PDF,
    };

})();
