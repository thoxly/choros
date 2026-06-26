/**
 * src/http/tabular-export.ts — T-0491
 *
 * Zero-dependency tabular export helpers (CSV + XLSX) shared by HTTP routes.
 *
 * WHY ZERO-DEP: the repo has NO spreadsheet library (package.json deps are only
 * `ajv` + `pg`; the existing /api/audit/export is JSON-only). The task forbids
 * adding a new dependency, so this module hand-rolls:
 *   - CSV: RFC-4180 quoting + UTF-8 BOM (so Excel renders Cyrillic correctly).
 *   - XLSX: the OOXML SpreadsheetML container is a ZIP of XML parts. We emit the
 *     minimal viable workbook (one sheet, inline strings, no styles) and pack it
 *     into a STORED (uncompressed) ZIP using only node:buffer. CRC-32 is computed
 *     inline (pure function) so we depend on nothing outside the stdlib type-safe
 *     surface — not even zlib.crc32 (whose typing varies across @types/node).
 *
 * Both generators are PURE (deterministic given input + an injectable clock for
 * the xlsx DOS timestamp, defaulted to a fixed epoch so output is reproducible in
 * tests). They never touch the DB, network, env, or any authz surface — the caller
 * (report-page-render.ts) is responsible for authz/tenant/limits BEFORE shaping the
 * data and calling these.
 */

// ---------------------------------------------------------------------------
// Tabular shape — a header row + body rows. Every cell is rendered to text.
// ---------------------------------------------------------------------------

export interface Tabular {
  /** Column headers (first row of the file). */
  columns: string[];
  /** Body rows; each row is parallel to `columns`. Cells stringified by caller. */
  rows: Array<Array<string | number | null | undefined>>;
}

/** Render a single cell to a string. null/undefined → empty cell. */
function cellToString(cell: string | number | null | undefined): string {
  if (cell === null || cell === undefined) return "";
  return typeof cell === "number" ? String(cell) : cell;
}

// ---------------------------------------------------------------------------
// CSV (RFC-4180) + UTF-8 BOM
// ---------------------------------------------------------------------------

/**
 * Quote a CSV field per RFC-4180: wrap in double-quotes and double any embedded
 * quote IFF the value contains a comma, quote, CR, or LF. Otherwise emit as-is.
 */
export function escapeCsvCell(value: string | number | null | undefined): string {
  const s = cellToString(value);
  if (s === "") return "";
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/** UTF-8 BOM — makes Excel detect UTF-8 so Cyrillic headers/values render. */
export const UTF8_BOM = "﻿";

/**
 * Serialize a Tabular to a CSV string (with leading UTF-8 BOM). Empty `rows`
 * yields header-only output (valid, NOT an error). CRLF line endings per RFC-4180.
 */
export function toCsv(table: Tabular): string {
  const lines: string[] = [];
  lines.push(table.columns.map((c) => escapeCsvCell(c)).join(","));
  for (const row of table.rows) {
    lines.push(row.map((cell) => escapeCsvCell(cell)).join(","));
  }
  return UTF8_BOM + lines.join("\r\n") + "\r\n";
}

// ---------------------------------------------------------------------------
// XLSX (OOXML SpreadsheetML, minimal: 1 sheet, inline strings, STORED zip)
// ---------------------------------------------------------------------------

/** XML-escape a string for use in element text / attribute values. */
function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Convert a 1-based column index to an A1 column letter (1→A, 27→AA). */
function colLetter(colIndex1Based: number): string {
  let n = colIndex1Based;
  let s = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/**
 * Build the sheet XML. Numbers render as numeric cells (t omitted); everything
 * else renders as an inline string cell (t="inlineStr") — no shared-strings table
 * needed, which keeps the writer tiny and fully deterministic.
 */
function buildSheetXml(table: Tabular): string {
  const allRows: Array<Array<string | number | null | undefined>> = [
    table.columns,
    ...table.rows,
  ];
  const parts: string[] = [];
  parts.push('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>');
  parts.push(
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
  );
  parts.push("<sheetData>");
  for (let r = 0; r < allRows.length; r++) {
    const rowNum = r + 1;
    const row = allRows[r] ?? [];
    parts.push(`<row r="${rowNum}">`);
    for (let c = 0; c < row.length; c++) {
      const ref = `${colLetter(c + 1)}${rowNum}`;
      const cell = row[c];
      if (typeof cell === "number" && Number.isFinite(cell)) {
        parts.push(`<c r="${ref}"><v>${cell}</v></c>`);
      } else {
        const text = cellToString(cell);
        if (text === "") {
          parts.push(`<c r="${ref}"/>`);
        } else {
          parts.push(
            `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(text)}</t></is></c>`,
          );
        }
      }
    }
    parts.push("</row>");
  }
  parts.push("</sheetData>");
  parts.push("</worksheet>");
  return parts.join("");
}

function buildContentTypesXml(): string {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
    "</Types>"
  );
}

function buildRootRelsXml(): string {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
    "</Relationships>"
  );
}

function buildWorkbookXml(sheetName: string): string {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    "<sheets>" +
    `<sheet name="${xmlEscape(sheetName)}" sheetId="1" r:id="rId1"/>` +
    "</sheets>" +
    "</workbook>"
  );
}

function buildWorkbookRelsXml(): string {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
    "</Relationships>"
  );
}

// ---- CRC-32 (pure, inline — no zlib dependency) ----------------------------

const CRC32_TABLE: number[] = (() => {
  const table: number[] = new Array<number>(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    const byte = buf[i] as number;
    crc = CRC32_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// ---- Minimal ZIP writer (STORED / no compression) --------------------------

interface ZipEntry {
  name: string;
  data: Buffer;
}

/**
 * Pack entries into a ZIP archive using STORED (method 0, no compression).
 * Sufficient for the small OOXML XML parts; Excel/LibreOffice open STORED zips.
 * DOS date/time fixed (epoch-ish constant) so output bytes are deterministic.
 */
function buildZip(entries: ZipEntry[]): Buffer {
  // Fixed DOS time = 1980-01-01 00:00:00 (the ZIP epoch) for reproducible output.
  const dosTime = 0;
  const dosDate = 0x21; // (year-1980=0)<<9 | month=1<<5 | day=1 → 0b0000000_0001_00001

  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, "utf8");
    const data = entry.data;
    const crc = crc32(data);

    // Local file header (30 bytes + name) + data.
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header signature
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // general purpose flags
    local.writeUInt16LE(0, 8); // compression method = stored
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); // compressed size
    local.writeUInt32LE(data.length, 22); // uncompressed size
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra field length

    localParts.push(local, nameBuf, data);

    // Central directory header (46 bytes + name).
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); // central dir signature
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 8); // flags
    central.writeUInt16LE(0, 10); // method = stored
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra len
    central.writeUInt16LE(0, 32); // comment len
    central.writeUInt16LE(0, 34); // disk number
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42); // local header offset

    centralParts.push(central, nameBuf);

    offset += local.length + nameBuf.length + data.length;
  }

  const centralDir = Buffer.concat(centralParts);
  const localDir = Buffer.concat(localParts);

  // End of central directory record (22 bytes).
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // EOCD signature
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // disk with central dir
  eocd.writeUInt16LE(entries.length, 8); // entries on this disk
  eocd.writeUInt16LE(entries.length, 10); // total entries
  eocd.writeUInt32LE(centralDir.length, 12); // central dir size
  eocd.writeUInt32LE(localDir.length, 16); // central dir offset
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([localDir, centralDir, eocd]);
}

/**
 * Serialize a Tabular to a minimal XLSX workbook Buffer (one worksheet).
 * Empty `rows` yields a header-only sheet (valid, NOT an error).
 *
 * @param table     header + body rows.
 * @param sheetName worksheet tab name (default "Sheet1"). Sanitized to ≤31 chars
 *                  with the OOXML-forbidden characters removed.
 */
export function toXlsx(table: Tabular, sheetName = "Sheet1"): Buffer {
  const safeSheet = sanitizeSheetName(sheetName);
  const entries: ZipEntry[] = [
    { name: "[Content_Types].xml", data: Buffer.from(buildContentTypesXml(), "utf8") },
    { name: "_rels/.rels", data: Buffer.from(buildRootRelsXml(), "utf8") },
    { name: "xl/workbook.xml", data: Buffer.from(buildWorkbookXml(safeSheet), "utf8") },
    { name: "xl/_rels/workbook.xml.rels", data: Buffer.from(buildWorkbookRelsXml(), "utf8") },
    { name: "xl/worksheets/sheet1.xml", data: Buffer.from(buildSheetXml(table), "utf8") },
  ];
  return buildZip(entries);
}

/** OOXML forbids \ / ? * [ ] : in sheet names and caps length at 31 chars. */
export function sanitizeSheetName(name: string): string {
  const cleaned = name.replace(/[\\/?*[\]:]/g, " ").trim();
  const sliced = cleaned.slice(0, 31);
  return sliced.length > 0 ? sliced : "Sheet1";
}
