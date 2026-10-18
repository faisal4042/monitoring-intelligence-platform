/**
 * Export providers. A provider receives column metadata once and rows in batches, and writes to a Sink.
 * New formats implement ExportProvider and register in PROVIDERS; the engine (jobs.ts) does not change.
 */
import type {ColumnType} from '../definitions.js';
import {excelSerial, guardFormula, jsonValue, textCell, toDate, TIMEZONE} from './values.js';
import {ZipWriter, type ZipEntry} from './zip.js';

export interface ExportColumn { key: string; label: string; type: ColumnType; group: string }
export interface ExportMeta { schemaVersion: string; reportType: string; reportLabel: string; generatedAt: string; filters: unknown; headerLang: 'ar' | 'en'; rowsEstimate: number | null }
/** Writes bytes; resolves after backpressure. */
export type Write = (chunk: string | Buffer) => Promise<void>;
export interface RowWriter { rows(batch: unknown[][]): Promise<void>; close(): Promise<{parts: number}> }
export interface ExportProvider {
  format: 'csv' | 'tsv' | 'json' | 'jsonl' | 'xlsx';
  extension: string; contentType: string;
  open(sink: {write: Write; zip: ZipWriter | null}, columns: ExportColumn[], meta: ExportMeta, opts: ProviderOptions): Promise<RowWriter>;
}
export interface ProviderOptions { jsonMode?: 'flat' | 'structured'; partRows?: number; sheetRows?: number; baseName: string }

// ── CSV / TSV ───────────────────────────────────────────────────────────────
function csvQuote(s: string) { return /[",\r\n]|^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }
function tsvClean(s: string) { return s.replace(/[\t\r\n]+/g, ' '); }
function delimited(format: 'csv' | 'tsv'): ExportProvider {
  const sep = format === 'csv' ? ',' : '\t';
  const enc = (s: string) => format === 'csv' ? csvQuote(s) : tsvClean(s);
  return {
    format, extension: format, contentType: format === 'csv' ? 'text/csv; charset=utf-8' : 'text/tab-separated-values; charset=utf-8',
    async open(sink, columns, _meta, opts) {
      const header = '﻿' + columns.map((c) => enc(guardFormula(c.label))).join(sep) + '\r\n';
      const line = (r: unknown[]) => r.map((v, i) => enc(textCell(v, columns[i].type))).join(sep) + '\r\n';
      if (!sink.zip) {
        await sink.write(header);
        return {async rows(batch) { if (batch.length) await sink.write(batch.map(line).join('')); }, async close() { return {parts: 1}; }};
      }
      return partitioned(sink.zip, opts, format, header, line);
    },
  };
}
/** Multi-part archive: each part is a complete file with its own header, at most partRows rows. Every write is awaited. */
function partitioned(zip: ZipWriter, opts: ProviderOptions, ext: string, header: string, line: (r: unknown[]) => string): RowWriter {
  const per = opts.partRows ?? 1_000_000;
  let part = 0, inPart = 0;
  let entry: ZipEntry | null = null;
  const startPart = async () => {
    part += 1; inPart = 0;
    entry = await zip.openEntry(`${opts.baseName}-part-${String(part).padStart(3, '0')}.${ext}`);
    if (header) await entry.write(header);
  };
  return {
    async rows(batch) {
      let i = 0;
      while (i < batch.length) {
        if (!entry || inPart >= per) { if (entry) await entry.close(); await startPart(); }
        const take = batch.slice(i, i + (per - inPart)); i += take.length; inPart += take.length;
        await entry!.write(take.map(line).join(''));
      }
    },
    async close() { if (!entry) await startPart(); await entry!.close(); entry = null; return {parts: part}; },
  };
}

// ── JSON (flat / structured) and JSONL ─────────────────────────────────────
function record(columns: ExportColumn[], row: unknown[], mode: 'flat' | 'structured') {
  if (mode === 'flat') return Object.fromEntries(columns.map((c, i) => [c.key, jsonValue(row[i], c.type)]));
  const out: Record<string, Record<string, unknown>> = {};
  columns.forEach((c, i) => { (out[c.group] ??= {})[c.key] = jsonValue(row[i], c.type); });
  return out;
}
const jsonProvider: ExportProvider = {
  format: 'json', extension: 'json', contentType: 'application/json; charset=utf-8',
  async open(sink, columns, meta, opts) {
    const mode = opts.jsonMode ?? 'flat';
    const head = {schema_version: meta.schemaVersion, report_type: meta.reportType, generated_at: meta.generatedAt, timezone: TIMEZONE,
      record_layout: mode, filters: meta.filters, columns: columns.map((c) => ({key: c.key, label: c.label, type: c.type, group: c.group}))};
    await sink.write(JSON.stringify(head).slice(0, -1) + ',"records":[');
    let first = true;
    return {
      async rows(batch) {
        if (!batch.length) return;
        const text = batch.map((r) => JSON.stringify(record(columns, r, mode))).join(',');
        await sink.write((first ? '' : ',') + text); first = false;
      },
      async close() { await sink.write(']}'); return {parts: 1}; },
    };
  },
};
const jsonlProvider: ExportProvider = {
  format: 'jsonl', extension: 'jsonl', contentType: 'application/x-ndjson; charset=utf-8',
  async open(sink, columns, _meta, opts) {
    const mode = opts.jsonMode ?? 'flat';
    const line = (r: unknown[]) => JSON.stringify(record(columns, r, mode)) + '\n';
    if (sink.zip) return partitioned(sink.zip, opts, 'jsonl', '', line);
    return {async rows(batch) { if (batch.length) await sink.write(batch.map(line).join('')); }, async close() { return {parts: 1}; }};
  },
};

// ── XLSX (streamed SpreadsheetML inside a ZIP) ──────────────────────────────
const XML_BAD = /[^\t\n\r -퟿-�]/g;
const xmlEsc = (s: string) => s.replace(XML_BAD, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const CELL_MAX = 32767;
const colName = (i: number) => { let s = ''; for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };
const WIDTH: Record<ColumnType, number> = {id: 24, text: 30, int: 12, number: 14, minutes: 16, datetime: 19, bool: 10};
// Style ids: 0 default, 1 header, 2 datetime, 3 integer, 4 decimal, 5 wrapped text, 6 id text
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="2"><numFmt numFmtId="164" formatCode="yyyy-mm-dd hh:mm"/><numFmt numFmtId="165" formatCode="#,##0.0"/></numFmts>
<fonts count="2"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/><family val="2"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF0E2A47"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left/><right/><top/><bottom style="thin"><color rgb="FFD9E1EA"/></bottom><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="7">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
<xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;

function xlsxCell(ref: string, v: unknown, type: ColumnType) {
  if (v === null || v === undefined || v === '') return '';
  if (type === 'datetime') { const d = toDate(v); return d ? `<c r="${ref}" s="2"><v>${excelSerial(d)}</v></c>` : ''; }
  if (type === 'int' || type === 'number' || type === 'minutes') {
    const n = Number(v); if (!Number.isFinite(n)) return '';
    return `<c r="${ref}" s="${type === 'int' ? 3 : 4}"><v>${n}</v></c>`;
  }
  let s = type === 'bool' ? (jsonValue(v, 'bool') ? 'نعم' : 'لا') : String(v);
  if (s.length > CELL_MAX) s = s.slice(0, CELL_MAX - 20) + ' …[مقتطع]';
  // Inline strings are never evaluated: ids keep leading zeros and full precision, formulas stay text.
  return `<c r="${ref}" t="inlineStr" s="${type === 'id' ? 6 : 5}"><is><t xml:space="preserve">${xmlEsc(s)}</t></is></c>`;
}

const xlsxProvider: ExportProvider = {
  format: 'xlsx', extension: 'xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  async open(sink, columns, meta, opts) {
    const zip = sink.zip!;
    const perSheet = opts.sheetRows ?? 1_048_575;
    const rtl = meta.headerLang === 'ar';
    const lastCol = colName(columns.length - 1);
    let sheets = 0, rowInSheet = 0;
    let sheet: ZipEntry | null = null;
    const headerRow = `<row r="1" ht="22" customHeight="1">${columns.map((c, i) => `<c r="${colName(i)}1" t="inlineStr" s="1"><is><t>${xmlEsc(c.label)}</t></is></c>`).join('')}</row>`;
    const startSheet = async () => {
      sheets += 1; rowInSheet = 0;
      sheet = await zip.openEntry(`xl/worksheets/sheet${sheets}.xml`);
      await sheet.write(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">`
        + `<sheetViews><sheetView workbookViewId="0"${rtl ? ' rightToLeft="1"' : ''}><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>`
        + `<sheetFormatPr defaultRowHeight="15"/><cols>${columns.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${Math.max(WIDTH[c.type], Math.min(48, c.label.length + 4))}" customWidth="1"/>`).join('')}</cols><sheetData>${headerRow}`);
    };
    const endSheet = async () => {
      await sheet!.write(`</sheetData><autoFilter ref="A1:${lastCol}${rowInSheet + 1}"/><pageMargins left="0.5" right="0.5" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>`);
      await sheet!.close(); sheet = null;
    };
    return {
      async rows(batch) {
        let i = 0;
        while (i < batch.length) {
          if (!sheet || rowInSheet >= perSheet) { if (sheet) await endSheet(); await startSheet(); }
          const take = batch.slice(i, i + (perSheet - rowInSheet)); i += take.length;
          const xml = take.map((r) => { rowInSheet += 1; const n = rowInSheet + 1;
            return `<row r="${n}">${r.map((v, ci) => xlsxCell(`${colName(ci)}${n}`, v, columns[ci].type)).join('')}</row>`; }).join('');
          await sheet!.write(xml);
        }
      },
      async close() {
        if (!sheet) await startSheet();
        await endSheet();
        const sheetName = (n: number) => xmlEsc((sheets > 1 ? `${meta.reportLabel} ${n}` : meta.reportLabel).replace(/[\\/?*[\]:]/g, ' ').slice(0, 31));
        await zip.entry('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${Array.from({length: sheets}, (_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`);
        await zip.entry('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`);
        await zip.entry('docProps/core.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${xmlEsc(meta.reportLabel)}</dc:title><dc:creator>MIP</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${meta.generatedAt.slice(0, 19)}Z</dcterms:created></cp:coreProperties>`);
        await zip.entry('xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView/></bookViews><sheets>${Array.from({length: sheets}, (_, i) => `<sheet name="${sheetName(i + 1)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets><definedNames>${Array.from({length: sheets}, (_, i) => `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">'${sheetName(i + 1)}'!$A$1:$${lastCol}$1</definedName>`).join('')}</definedNames></workbook>`);
        await zip.entry('xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${Array.from({length: sheets}, (_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`);
        await zip.entry('xl/styles.xml', STYLES);
        return {parts: sheets};
      },
    };
  },
};

export const PROVIDERS: Record<ExportProvider['format'], ExportProvider> = {
  csv: delimited('csv'), tsv: delimited('tsv'), json: jsonProvider, jsonl: jsonlProvider, xlsx: xlsxProvider,
};
