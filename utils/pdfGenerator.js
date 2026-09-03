const fs = require('fs').promises;
const path = require('path');
const puppeteer = require('puppeteer');
const QRCode = require('qrcode');
const { PDFDocument } = require('pdf-lib');
const { v4: uuidv4 } = require('uuid');

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function pad2(n) { return String(n).padStart(2, '0'); }

function formatDateWithMonthName(value) {
    if (!value && value !== 0) return value;

    // Date object
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
        const d = value;
        const hh = pad2(d.getHours());
        const mm = pad2(d.getMinutes());
        if (hh === '00' && mm === '00') {
            return `${pad2(d.getDate())}-${MONTH_NAMES[d.getMonth()]}-${d.getFullYear()}`;
        }
        return `${pad2(d.getDate())}-${MONTH_NAMES[d.getMonth()]}-${d.getFullYear()} ${hh}:${mm}`;
    }

    // String input - accept DD/MM/YYYY or DD-MM-YYYY with optional time HH:mm(:ss)
    if (typeof value === 'string') {
        const s = value.trim();
        if (!s) return value;

        const dmy = s.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
        if (dmy) {
            const day = Number(dmy[1]);
            const month = Number(dmy[2]);
            const year = Number(dmy[3]);
            const hh = dmy[4] ? pad2(Number(dmy[4])) : null;
            const mm = dmy[5] ? pad2(Number(dmy[5])) : null;
            const ss = dmy[6] ? pad2(Number(dmy[6])) : null;
            if (month >= 1 && month <= 12) {
                const base = `${pad2(day)}-${MONTH_NAMES[month - 1]}-${year}`;
                if (hh && mm) {
                    if (hh === '00' && mm === '00') return base;
                    return ss ? `${base} ${hh}:${mm}:${ss}` : `${base} ${hh}:${mm}`;
                }
                return base;
            }
        }

        // fallback to Date parse
        const parsed = new Date(s);
        if (!Number.isNaN(parsed.getTime())) {
            const ph = pad2(parsed.getHours());
            const pm = pad2(parsed.getMinutes());
            const base = `${pad2(parsed.getDate())}-${MONTH_NAMES[parsed.getMonth()]}-${parsed.getFullYear()}`;
            if (ph === '00' && pm === '00') return base;
            return `${base} ${ph}:${pm}`;
        }
    }

    return value;
}

function escapeHtml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

/** Detect Arabic (and related) script so PDF can use a joining-capable font */
function containsArabic(text) {
    return /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/.test(String(text || ''));
}

/**
 * Escape and wrap user-entered text so Arabic joins correctly in the PDF.
 * English/Latin values stay LTR; Arabic gets Noto + RTL isolation.
 */
function formatUserText(value) {
    if (value === undefined || value === null) return '';
    const text = String(value);
    if (!text) return '';
    const escaped = escapeHtml(text);
    if (containsArabic(text)) {
        return `<span class="user-text has-arabic" dir="auto">${escaped}</span>`;
    }
    return `<span class="user-text" dir="auto">${escaped}</span>`;
}

function createOptionalFieldRows(formData, language) {
    const fields = [
        ['CALL_SIGN', 'Call Sign:', ':نداء السفينة'],
        ['NEXT_PORT', 'Next Port:', ':الميناء التالي'],
        ['VOYAGE_NUMBER', 'Voyage Number:', ':رقم الرحلة'],
        ['MASTER_NAME', 'Master Name:', ':اسم الربان'],
        ['MASTER_NATIONALITY', 'Master Nationality:', ':جنسية الربان'],
        ['CREW_NUMBER', 'Crew Number:', ':عدد أفراد الطاقم'],
        ['CARGO_TYPE', 'Cargo Type:', ':نوع الحمولة'],
        ['CARGO_QUANTITY', 'Cargo Quantity:', ':كمية الحمولة']
    ];

    return fields
        .filter(([key]) => formData[key] !== undefined && formData[key] !== null && String(formData[key]).trim() !== '')
        .map(([key, englishLabel, arabicLabel]) => {
            const raw = String(formData[key]);
            const valueHtml = formatUserText(raw);
            const valueClass = containsArabic(raw) ? 'field-value has-arabic' : 'field-value';
            if (language === 'ar') {
                return `<div class="field-row" style="justify-content:flex-end;"><span class="${valueClass}" dir="auto">${valueHtml}</span><span class="field-label ar">${arabicLabel}</span></div>`;
            }
            return `<div class="field-row"><span class="field-label">${englishLabel}</span><span class="${valueClass}" dir="auto">${valueHtml}</span></div>`;
        })
        .join('\n');
}

function hasOptionalFields(formData) {
    const keys = [
        'CALL_SIGN', 'NEXT_PORT', 'VOYAGE_NUMBER', 'MASTER_NAME',
        'MASTER_NATIONALITY', 'CREW_NUMBER', 'CARGO_TYPE', 'CARGO_QUANTITY'
    ];
    return keys.some(key => formData[key] !== undefined && formData[key] !== null && String(formData[key]).trim() !== '');
}

/**
 * Fill template with form data
 */
function fillTemplate(templateHtml, formData, qrCodeUrl = null, signatureImage = null, isSigned = false) {
    let filled = templateHtml;

    // Format current date/time for printed timestamp
    const now = new Date();
    const printedOn = formatDateWithMonthName(now);

    

    // Calculate total pages FIRST (before creating placeholders)
    // Always assume at least 2 pages (page 1 approval + page 2 crew)
    let totalPages = 2;
    let numAdditionalPages = 0;
    
    if (formData.CREW_MEMBERS && Array.isArray(formData.CREW_MEMBERS)) {
        const totalCrew = formData.CREW_MEMBERS.length;
        const crewPerFirstPage = 15;
        const crewPerAdditionalPage = 15;
        
        // Calculate additional pages only if crew exceeds first page capacity
        if (totalCrew > crewPerFirstPage) {
            numAdditionalPages = Math.ceil((totalCrew - crewPerFirstPage) / crewPerAdditionalPage);
            totalPages = 2 + numAdditionalPages;
        }
        // If <= 15 crew: totalPages stays at 2
    }

    // NOW create placeholders object (can reference totalPages)
    // formatUserText enables Arabic (joined glyphs) in any English/Arabic text field
    const text = (v) => formatUserText(v || '');
    const placeholders = {
        // Port Clearance specific fields
        'PERMIT_NUMBER': text(formData.PERMIT_NUMBER),
        'ISSUANCE_DATE': text(formData.ISSUANCE_DATE ? formatDateWithMonthName(formData.ISSUANCE_DATE) : ''),
        'VESSEL_NAME': text(formData.VESSEL_NAME),
        'VESSEL_IMO': text(formData.VESSEL_IMO),
        'FLAG': text(formData.FLAG),
        'CLASSIFICATION_SOCIETY': text(formData.CLASSIFICATION_SOCIETY),
        'DEPARTURE_PORT': text(formData.DEPARTURE_PORT),
        'VESSEL_TYPE': text(formData.VESSEL_TYPE),
        'VESSEL_GRT': text(formData.VESSEL_GRT),
        'AGENCY_NAME': text(formData.AGENCY_NAME),
        'ARRIVAL_DATE': text(formData.ARRIVAL_DATE ? formatDateWithMonthName(formData.ARRIVAL_DATE) : ''),
        'DEPARTURE_DATE': text(formData.DEPARTURE_DATE ? formatDateWithMonthName(formData.DEPARTURE_DATE) : ''),
        'OPTIONAL_LAYOUT_CLASS': hasOptionalFields(formData) ? 'has-optional-fields' : '',
        'OPTIONAL_FIELDS_EN': createOptionalFieldRows(formData, 'en'),
        'OPTIONAL_FIELDS_AR': createOptionalFieldRows(formData, 'ar'),
        
        // Sail Certificate specific fields
        'CERTIFICATE_NUMBER': text(formData.CERTIFICATE_NUMBER),
        'VESSEL_NAME_AR': text(formData.VESSEL_NAME_AR),
        'VESSEL_NATIONALITY': text(formData.VESSEL_NATIONALITY),
        'VESSEL_NATIONALITY_AR': text(formData.VESSEL_NATIONALITY_AR),
        'FLAG_AR': text(formData.FLAG_AR),
        'VESSEL_AGENT_NAME': text(formData.VESSEL_AGENT_NAME),
        'VESSEL_AGENT_NAME_AR': text(formData.VESSEL_AGENT_NAME_AR),
        'PORT_OF_DEPARTURE': text(formData.PORT_OF_DEPARTURE),
        'PORT_OF_DEPARTURE_AR': text(formData.PORT_OF_DEPARTURE_AR),
        'NEXT_PORT_OF_CALL': text(formData.NEXT_PORT_OF_CALL),
        'NEXT_PORT_OF_CALL_AR': text(formData.NEXT_PORT_OF_CALL_AR),
        'VOYAGE_NUMBER': text(formData.VOYAGE_NUMBER),
        'CAPTAIN_NAME': text(formData.CAPTAIN_NAME),
        'CAPTAIN_NAME_AR': text(formData.CAPTAIN_NAME_AR),
        'ETD': text(formData.ETD),
        'CUSTOMS_REMARKS': text(formData.CUSTOMS_REMARKS),
        'PRINTED_ON': text(formData.PRINTED_ON ? formatDateWithMonthName(formData.PRINTED_ON) : printedOn),
        'IMO_NUMBER': text(formData.IMO_NUMBER),
        'TOTAL_PAGES_COUNT': totalPages.toString(),
        
        // Legacy fields (kept for backward compatibility)
        'MARINE_AFFAIRS_NO': text(formData.MARINE_AFFAIRS_NO),
        'MARINE_AFFAIRS_NO_FA': text(formData.MARINE_AFFAIRS_NO_FA),
        'SERIAL_NO': text(formData.SERIAL_NO),
        'SERIAL_NO_FA': text(formData.SERIAL_NO_FA),
        'ISSUE_DATE_TIME': text(formData.ISSUE_DATE_TIME ? new Date(formData.ISSUE_DATE_TIME).toLocaleString('en-US', { year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', hour12: true }) : ''),
        'ISSUE_DATE_TIME_FA': text(formData.ISSUE_DATE_TIME_FA),
        'PORT_CLEARANCE_NO': text(formData.PORT_CLEARANCE_NO),
        'PORT_CLEARANCE_NO_FA': text(formData.PORT_CLEARANCE_NO_FA),
        'CUSTOM_LEAVE_NO': text(formData.CUSTOM_LEAVE_NO),
        'CUSTOM_LEAVE_NO_FA': text(formData.CUSTOM_LEAVE_NO_FA),
        'AGENT': text(formData.AGENT),
        'AGENT_FA': text(formData.AGENT_FA),
        'VESSEL_NAME_FA': text(formData.VESSEL_NAME_FA),
        'ARRIVED_FROM': text(formData.ARRIVED_FROM),
        'ARRIVED_FROM_FA': text(formData.ARRIVED_FROM_FA),
        'ON_DATE': text(formData.ON_DATE),
        'ON_DATE_FA': text(formData.ON_DATE_FA),
        'IMO_NO': text(formData.IMO_NO),
        'IMO_NO_FA': text(formData.IMO_NO_FA),
        'SHIPS_FLAG': text(formData.SHIPS_FLAG),
        'SHIPS_FLAG_FA': text(formData.SHIPS_FLAG_FA),
        'REGISTRY_PORT': text(formData.REGISTRY_PORT),
        'REGISTRY_PORT_FA': text(formData.REGISTRY_PORT_FA),
        'GROSS_TONNAGE': text(formData.GROSS_TONNAGE),
        'GROSS_TONNAGE_FA': text(formData.GROSS_TONNAGE_FA),
        'MASTER': text(formData.MASTER),
        'MASTER_FA': text(formData.MASTER_FA),
        'PERMITTED_TO_SAIL': text(formData.PERMITTED_TO_SAIL),
        'PERMITTED_TO_SAIL_FA': text(formData.PERMITTED_TO_SAIL_FA),
        'HEAD_OF_MARITIME': text(formData.HEAD_OF_MARITIME),
        'HEAD_OF_MARITIME_FA': text(formData.HEAD_OF_MARITIME_FA),
        'PORT': text(formData.PORT),
        'PORT_FA': text(formData.PORT_FA)
    };

    // Handle crew members with smart pagination BEFORE replacing main placeholders
    if (formData.CREW_MEMBERS && Array.isArray(formData.CREW_MEMBERS)) {
        const totalCrew = formData.CREW_MEMBERS.length;
        const crewPerFirstPage = 10;
        const crewPerAdditionalPage = 10;
        
        // Generate crew HTML for page 2 (first page with crew)
        let crewHtml = '';
        const firstPageEnd = Math.min(crewPerFirstPage, totalCrew);
        
        for (let i = 0; i < firstPageEnd; i++) {
            const crew = formData.CREW_MEMBERS[i];
            crewHtml += `
            <!-- Row ${i + 1} -->
            <tr>
              <td rowspan="2" class="text-center crew-cell">${i + 1}</td>
              <td rowspan="2" class="text-center crew-cell rtl">${formatUserText(crew.nameAr || '')}</td>
              <td class="text-center crew-cell">${formatUserText(crew.positionEn || '')}</td>
              <td class="text-center crew-cell">${formatUserText(crew.nationalityEn || '')}</td>
              <td rowspan="2" class="text-center crew-cell">${escapeHtml(formatDateWithMonthName(crew.dateOfBirth) || '')}</td>
              <td rowspan="2" class="crew-cell td-thick-right">${formatUserText(crew.travelDocRef || '')}</td>
              <td rowspan="2" class="crew-cell td-thick-right td-thick-left">${escapeHtml(formatDateWithMonthName(crew.dateOfIssue) || '')}</td>
              <td rowspan="2" class="crew-cell td-thick-right td-thick-left">${escapeHtml(formatDateWithMonthName(crew.dateOfExpiry) || '')}</td>
              <td rowspan="2" class="crew-cell td-thick-left">${formatUserText(crew.seamanBook || '')}</td>
            </tr>
            <tr>
              <td class="text-center crew-cell rtl">${formatUserText(crew.positionAr || '')}</td>
              <td class="text-center crew-cell rtl">${formatUserText(crew.nationalityAr || '')}</td>
            </tr>
            `;
        }
        
        // Replace the crew members placeholder on page 2
        filled = filled.replace(/{{CREW_MEMBERS}}/g, crewHtml);
        
        // If there are more crew members, add additional pages
        if (totalCrew > crewPerFirstPage) {
            let additionalPages = '';
            
            for (let pageIdx = 0; pageIdx < numAdditionalPages; pageIdx++) {
                const startIdx = crewPerFirstPage + (pageIdx * crewPerAdditionalPage);
                const endIdx = Math.min(startIdx + crewPerAdditionalPage, totalCrew);
                let pageCrewHtml = '';
                
                // Build crew rows for this page
                for (let i = startIdx; i < endIdx; i++) {
                    const crew = formData.CREW_MEMBERS[i];
                    pageCrewHtml += `
            <!-- Row ${i + 1} -->
            <tr>
              <td rowspan="2" class="text-center crew-cell">${i + 1}</td>
              <td rowspan="2" class="text-center crew-cell rtl">${formatUserText(crew.nameAr || '')}</td>
              <td class="text-center crew-cell">${formatUserText(crew.positionEn || '')}</td>
              <td class="text-center crew-cell">${formatUserText(crew.nationalityEn || '')}</td>
              <td rowspan="2" class="text-center crew-cell">${escapeHtml(formatDateWithMonthName(crew.dateOfBirth) || '')}</td>
              <td rowspan="2" class="crew-cell td-thick-right">${formatUserText(crew.travelDocRef || '')}</td>
              <td rowspan="2" class="crew-cell td-thick-right td-thick-left">${escapeHtml(formatDateWithMonthName(crew.dateOfIssue) || '')}</td>
              <td rowspan="2" class="crew-cell td-thick-right td-thick-left">${escapeHtml(formatDateWithMonthName(crew.dateOfExpiry) || '')}</td>
              <td rowspan="2" class="crew-cell td-thick-left">${formatUserText(crew.seamanBook || '')}</td>
            </tr>
            <tr>
              <td class="text-center crew-cell rtl">${formatUserText(crew.positionAr || '')}</td>
              <td class="text-center crew-cell rtl">${formatUserText(crew.nationalityAr || '')}</td>
            </tr>
            `;
                }
                
                // Calculate page number: page 3 is the first additional page (pageIdx=0), page 4 is pageIdx=1, etc.
                const pageNumber = 3 + pageIdx;
                
                additionalPages += `
    <!-- Page Break -->
    <div class="page-break"></div>

    <!-- Additional Crew Page ${pageNumber} of ${totalPages} -->
    <div class="page-wrapper">
        <!-- Crew Table -->
        <table class="table-main" style="margin-bottom: 60px;">
          <thead>
            <tr>
              <td class="col-w-seq">
                <p class="crew-header rtl text-center">تسلسل</p>
                <p class="crew-subheader">SEQ NO.</p>
              </td>
              <td class="col-w-name">
                <p class="crew-header rtl text-center">الاسم</p>
                <p class="crew-subheader text-center">NAME</p>
              </td>
              <td class="col-w-pos">
                <p class="crew-header rtl text-center">المنصب</p>
                <p class="crew-subheader text-center">POSITION</p>
              </td>
              <td class="col-w-nat">
                <p class="crew-header rtl text-center">الجنسية</p>
                <p class="crew-subheader text-center">NATIONALITY</p>
              </td>
              <td class="col-w-dob">
                <p class="crew-header rtl text-center">تاريخ الميلاد</p>
                <p class="crew-subheader">DATE OF BIRTH</p>
              </td>
              <td class="col-w-doc td-thick-right">
                <p class="crew-header rtl text-center">رقم وثيقة السفر</p>
                <p class="crew-subheader">TRAVEL DOC REF NO.</p>
              </td>
              <td class="col-w-iss td-thick-right td-thick-left">
                <p class="crew-header rtl text-center">تاريخ الاصدار</p>
                <p class="crew-subheader text-center">DATE OF ISSUE</p>
              </td>
              <td class="col-w-exp td-thick-right td-thick-left">
                <p class="crew-header rtl text-center">تاريخ الانتهاء</p>
                <p class="crew-subheader text-center">DATE OF EXPIRY</p>
              </td>
              <td class="col-w-id td-thick-left">
                <p class="crew-header rtl">رقم الهوية (البحرية)</p>
                <p class="crew-subheader">SEAMAN BOOK</p>
              </td>
            </tr>
          </thead>
          <tbody>
            ${pageCrewHtml}
          </tbody>
        </table>
<div class="footer" style="margin-top: 100px;">
          <div class="footer-info">

            <h3>Printed on:</h3>
            <h3>${placeholders.PRINTED_ON}</h3>

            <h3>Computer Generated Report No Signature Required</h3>
            <h3>${placeholders.PRINTED_ON}</h3>
            <p class="text-right rtl" style="font-size: var(--fs-base);">تم الطباعة بتاريخ:</p>

          </div>
          <div style="border-bottom: 1px solid #000; margin: 0px 7.5px 5px 7.5px;"></div>
          <div class="footer-info">
            <span style="font-size: var(--fs-base);"><strong>Page</strong> ${pageNumber} of ${totalPages}</span>
            <span style="font-size: var(--fs-md); font-weight: 400;" class="rtl">صفحة ${pageNumber} من ${totalPages}</span>
          </div>
        </div>
      </div>
    </div>
        `;
            }
            
            // Insert additional pages before closing </body> tag
            const bodyClosingIndex = filled.indexOf('</body>');
            if (bodyClosingIndex !== -1) {
                filled = filled.substring(0, bodyClosingIndex) + additionalPages + '\n' + filled.substring(bodyClosingIndex);
            }
        }
    } else {
        // If no crew members, replace with empty string
        filled = filled.replace(/{{CREW_MEMBERS}}/g, '');
    }

    // NOW replace all remaining placeholders with actual data
    for (const [key, value] of Object.entries(placeholders)) {
        const regex = new RegExp(`{{${key}}}`, 'g');
        filled = filled.replace(regex, value);
    }


    // Replace QR Code URL if provided
    if (qrCodeUrl) {
        filled = filled.replace(/{{QR_CODE_URL}}/g, qrCodeUrl);
    }

    // Replace Signature Image if provided
    if (signatureImage) {
        filled = filled.replace(/{{SIGNATURE_IMAGE}}/g, signatureImage);
    } else {
        // If no signature image, use empty string
        filled = filled.replace(/{{SIGNATURE_IMAGE}}/g, '');
    }

    // Handle conditional signature blocks from the template
    const signedConditionalWithElse = /{{#if IS_SIGNED}}([\s\S]*?){{else}}([\s\S]*?){{\/if}}/g;
    const signedConditional = /{{#if IS_SIGNED}}([\s\S]*?){{\/if}}/g;

    if (isSigned) {
        // Keep the truthy branch when a signature is present
        filled = filled.replace(signedConditionalWithElse, (_, truthy, falsy) => truthy);
        filled = filled.replace(signedConditional, (_, truthy) => truthy);
    } else {
        // Keep the falsy branch (if provided) or remove the block entirely
        filled = filled.replace(signedConditionalWithElse, (_, truthy, falsy) => falsy);
        filled = filled.replace(signedConditional, () => '');
    }

    // Clean up any leftover IS_SIGNED references
    filled = filled.replace(/{{IS_SIGNED}}/g, isSigned ? 'true' : '');

    // ===== FOOTER ENHANCEMENT: Inject page numbers dynamically =====
    // This ensures all pages (1, 2, and 3+) have proper page numbering in footers
    
    // Replace footer page number placeholders with actual page numbers
    // Handles both <strong>Page</strong> formatting and plain text
    
    // Page 1 footer: "<strong>Page</strong> 1 of {totalPages}" or "Page 1 of {totalPages}"
    filled = filled.replace(/<strong>Page<\/strong>\s+1\s+of\s+{{TOTAL_PAGES_COUNT}}/g, `<strong>Page</strong> 1 of ${totalPages}`);
    filled = filled.replace(/([^<]|^)Page\s+1\s+of\s+{{TOTAL_PAGES_COUNT}}/g, `$1Page 1 of ${totalPages}`);
    
    // Page 2 footer: "<strong>Page</strong> 2 of {totalPages}" or "Page 2 of {totalPages}"
    filled = filled.replace(/<strong>Page<\/strong>\s+2\s+of\s+{{TOTAL_PAGES_COUNT}}/g, `<strong>Page</strong> 2 of ${totalPages}`);
    filled = filled.replace(/([^<]|^)Page\s+2\s+of\s+{{TOTAL_PAGES_COUNT}}/g, `$1Page 2 of ${totalPages}`);
    
    // For bilingual Arabic footers (if present)
    // "صفحة 1 من {{TOTAL_PAGES_COUNT}}" -> "صفحة 1 من X"
    filled = filled.replace(/صفحة\s+1\s+من\s+{{TOTAL_PAGES_COUNT}}/g, `صفحة 1 من ${totalPages}`);
    filled = filled.replace(/صفحة\s+2\s+من\s+{{TOTAL_PAGES_COUNT}}/g, `صفحة 2 من ${totalPages}`);
    
    // Additional pages (3+) already use template literals, but ensure they're correct
    // Replace any remaining {{TOTAL_PAGES_COUNT}} in additional pages
    filled = filled.replace(/{{TOTAL_PAGES_COUNT}}/g, totalPages.toString());

    return filled;
}

/**
 * Embed local Arabic fonts as Base64 so PDF rendering does not depend on Google Fonts
 */
async function embedLocalFonts(html, baseDir) {
    const fontFiles = [
        { file: 'assets/fonts/NotoSansArabic-Regular.ttf', weight: '400' },
        { file: 'assets/fonts/NotoSansArabic-Bold.ttf', weight: '700' }
    ];

    let fontCss = '';
    for (const { file, weight } of fontFiles) {
        try {
            const fontPath = path.join(baseDir, file);
            const buffer = await fs.readFile(fontPath);
            const dataUri = `data:font/ttf;base64,${buffer.toString('base64')}`;
            fontCss += `
@font-face {
  font-family: 'Noto Sans Arabic';
  src: url('${dataUri}') format('truetype');
  font-weight: ${weight};
  font-style: normal;
  font-display: swap;
  unicode-range: U+0600-06FF, U+0750-077F, U+08A0-08FF, U+FB50-FDFF, U+FE70-FEFF;
}
`;
            console.log(`Embedded font: ${file}`);
        } catch (error) {
            console.warn(`Font not found, skipping embed: ${file} (${error.message})`);
        }
    }

    if (!fontCss) return html;
    return html.replace(/<style>/i, `<style>${fontCss}`);
}

/**
 * Embed all local images found in HTML as Base64
 */
async function embedAllImages(html, baseDir) {
    let updatedHtml = html;
    // Regex to find img tags with src attribute
    // Capture group 1: the full src attribute value
    const imgRegex = /<img[^>]+src="([^">]+)"/g;
    
    let match;
    // We need to collect matches first to avoid infinite loops if we replace them
    const matches = [];
    while ((match = imgRegex.exec(html)) !== null) {
        matches.push(match[1]);
    }
    
    // Process unique matches
    const uniqueSources = [...new Set(matches)];
    
    for (const src of uniqueSources) {
        // Skip if already base64 or remote URL
        if (src.startsWith('data:') || src.startsWith('http://') || src.startsWith('https://')) {
            continue;
        }
        
        try {
            // Construct absolute path
            // The template uses paths relative to project root usually
            const imagePath = path.join(baseDir, src);
            
            // Check if file exists
            try {
                await fs.access(imagePath);
            } catch (e) {
                console.warn(`Image file not found: ${imagePath}, skipping embedding.`);
                continue;
            }
            
            // Determine mime type based on extension
            const ext = path.extname(src).toLowerCase();
            let mimeType = 'image/png'; // Default
            if (ext === '.jpg' || ext === '.jpeg') mimeType = 'image/jpeg';
            else if (ext === '.svg') mimeType = 'image/svg+xml';
            
            // Read file
            const imgBuffer = await fs.readFile(imagePath);
            const base64Data = imgBuffer.toString('base64');
            const dataUri = `data:${mimeType};base64,${base64Data}`;
            
            // Replace all occurrences in HTML
            // global replacement
            updatedHtml = updatedHtml.split(`src="${src}"`).join(`src="${dataUri}"`);
            console.log(`Embedded image: ${src}`);
            
        } catch (error) {
            console.error(`Failed to embed image ${src}: ${error.message}`);
        }
    }
    
    return updatedHtml;
}

/**
 * Generate QR Code and save to file
 */
async function generateQRCode(url, outputPath) {
    try {
        await QRCode.toFile(outputPath, url, {
            errorCorrectionLevel: 'H',
            type: 'png',
            width: 400,
            margin: 2,
            color: {
                dark: '#000000',
                light: '#FFFFFF'
            }
        });
        console.log('QR Code file created at:', outputPath);
        return outputPath;
    } catch (error) {
        throw new Error(`QR Code generation failed: ${error.message}`);
    }
}

/**
 * Generate temporary PDF without QR code
 */
async function generateTempPDF(htmlContent, outputPath) {
    let browser;
    try {
        // Detect if running in Docker or local
        const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || 
                               (() => {
                                   const os = require('os');
                                   const homedir = os.homedir();
                                   return `${homedir}/.cache/puppeteer/chrome/mac-121.0.6167.85/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
                               })();
        
        browser = await puppeteer.launch({
            headless: 'new',
            executablePath: executablePath,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--disable-gpu',
                '--font-render-hinting=none',
                '--disable-font-subpixel-positioning'
            ]
        });

        const page = await browser.newPage();

        // Avoid networkidle0 — Google Fonts / external CSS can hang forever in Docker
        await page.setContent(htmlContent, {
            waitUntil: 'load',
            timeout: 60000
        });

        // Wait for images to load (especially the QR code)
        await page.waitForSelector('#qr-code-img', { timeout: 5000 });

        // Wait for all images to load completely
        await page.evaluate(() => {
            return Promise.all(
                Array.from(document.images)
                    .filter(img => !img.complete)
                    .map(img => new Promise(resolve => {
                        img.onload = img.onerror = resolve;
                    }))
            );
        });

        // Wait for fonts with a soft timeout so slow/blocked Google Fonts don't fail PDF gen
        await page.evaluate(async () => {
            const fontsReady = document.fonts.ready.then(() => true);
            const timeout = new Promise(resolve => setTimeout(() => resolve(false), 5000));
            const ready = await Promise.race([fontsReady, timeout]);
            console.log('Fonts ready:', ready, 'count:', document.fonts.size);
            await new Promise(resolve => setTimeout(resolve, ready ? 500 : 0));
        });

        await page.pdf({
            path: outputPath,
            format: 'A4',
            printBackground: true,
            preferCSSPageSize: false,
            displayHeaderFooter: true,
            margin: {
                top: '5mm',
                right: '5mm',
                bottom: '5mm',
                left: '5mm'
            },
            scale: 0.92
        });

        console.log('PDF generated successfully');
    } catch (error) {
        console.error('PDF error:', error.message);
        throw new Error(`PDF generation failed: ${error.message}`);
    } finally {
        if (browser) {
            await browser.close();
        }
    }
}

/**
 * Main function to generate Port Clearance PDF with dynamic QR code
 */
async function generatePortClearancePDF(formData, baseUrl, documentId) {
    const tempDir = path.join(__dirname, '../temp');
    const storageDir = path.join(__dirname, '../storage');
    const templatePath = path.join(__dirname, '../template.html');

    // Generate unique filename
    const uniqueId = uuidv4();
    const filename = `port-clearance-${uniqueId}.pdf`;
    const finalPdfPath = path.join(storageDir, filename);
    const qrCodePath = path.join(tempDir, `qr-${uniqueId}.png`);

    try {
        // Step 1: Read template
        const templateHtml = await fs.readFile(templatePath, 'utf-8');

        // Step 2: Generate PDF URL and Validation URL using document ID
        const pdfUrl = `${baseUrl}/pdfs/${filename}`;
        
        // Use the provided documentId for the QR code URL
        const cleanBaseUrl = baseUrl.replace(/\/$/, '');
        const validationUrl = `${cleanBaseUrl}/view/${documentId}`;

        // Step 3: Generate QR code as file pointing to the /view/:documentId route
        await generateQRCode(validationUrl, qrCodePath);
        console.log('QR Code generated for URL:', validationUrl);

        // Step 4: Read QR as base64
        const qrBuffer = await fs.readFile(qrCodePath);
        const qrBase64 = `data:image/png;base64,${qrBuffer.toString('base64')}`;
        console.log('QR Code base64 generated, length:', qrBase64.length);

        // Step 4.5: Read signature stamp image and convert to base64
        const signaturePath = path.join(__dirname, '../assets/signature-stamp.png');
        let signatureBase64 = '';
        try {
            const signatureBuffer = await fs.readFile(signaturePath);
            signatureBase64 = `data:image/png;base64,${signatureBuffer.toString('base64')}`;
            console.log('Signature image loaded successfully');
        } catch (error) {
            console.log('No signature image found, using placeholder');
            signatureBase64 = '';
        }

        // Step 5: Fill template with form data, QR code, and signature
        const filledHtml = fillTemplate(templateHtml, formData, qrBase64, signatureBase64, formData.isSigned);
        
        // Verify QR code was embedded
        if (!filledHtml.includes('data:image/png;base64,')) {
            throw new Error('QR Code was not properly embedded in HTML');
        }
        console.log('QR Code successfully embedded in HTML template');

        // Step 5.5: Embed all other local images
        const projectRoot = path.join(__dirname, '..');
        const finalHtml = await embedLocalFonts(
            await embedAllImages(filledHtml, projectRoot),
            projectRoot
        );

        // Step 6: Generate final PDF with QR code
        await generateTempPDF(finalHtml, finalPdfPath);

        // Clean up QR file
        try {
            await fs.unlink(qrCodePath);
        } catch (e) {
            try {
                 // Retry cleanup if needed or ignore
                 console.log('Cleanup qr code success');
            } catch (err) {}
        }

        console.log('Port Clearance PDF generated successfully:', filename);

        return {
            filename: filename,
            pdfUrl: pdfUrl,
            qrCodeUrl: qrBase64,
            filePath: finalPdfPath
        };

    } catch (error) {
        // Clean up on error
        try {
            await fs.unlink(qrCodePath);
            await fs.unlink(finalPdfPath);
        } catch (e) {
            // Ignore cleanup errors
        }

        throw new Error(`Failed to generate Port Clearance PDF: ${error.message}`);
    }
}

// s

module.exports = {
    generatePortClearancePDF
};
