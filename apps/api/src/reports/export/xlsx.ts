import { crc32, deflateRawSync } from 'node:zlib';
import { safeText } from './csv';
import type { Cell, Column, ExportTable } from './table';

/**
 * A minimal Office Open XML workbook writer: one worksheet per table, a bold header row, amounts with two
 * decimals and a thousands separator. Written by hand (a zip of a few XML files) so the export needs no third-party
 * package. Amounts go into the file as the decimal text the ledger produced; Excel reads them as numbers.
 */

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

function esc(v: string): string {
  return (
    v
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      // XML 1.0 cannot hold control characters other than tab and line breaks; they are dropped.
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
  );
}

/** Spreadsheet column letters: 0 → A, 26 → AA. */
function letters(i: number): string {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

// Style indexes in styles.xml: 0 normal, 1 bold, 2 amount (#,##0.00), 3 integer (#,##0), 4 decimal (0.0##).
const STYLE: Record<Column['kind'], number> = { text: 0, date: 0, money: 2, int: 3, decimal: 4 };

function cellXml(ref: string, v: Cell, col: Column, header = false): string {
  if (v === null || v === '') return '';
  const numeric = !header && col.kind !== 'text' && col.kind !== 'date';
  if (numeric && (typeof v === 'number' || /^-?\d+(\.\d+)?$/.test(v))) {
    return `<c r="${ref}" s="${STYLE[col.kind]}"><v>${v}</v></c>`;
  }
  const text = typeof v === 'number' ? String(v) : safeText(v);
  return `<c r="${ref}" t="inlineStr"${header ? ' s="1"' : ''}><is><t xml:space="preserve">${esc(text)}</t></is></c>`;
}

function sheetXml(title: string[], s: ExportTable['sheets'][number]): string {
  const rows: string[] = [];
  let r = 1;
  for (const line of title) {
    rows.push(`<row r="${r}">${cellXml(`A${r}`, line, { header: '', kind: 'text' })}</row>`);
    r++;
  }
  r++;
  const header = s.columns.map((c, i) => cellXml(`${letters(i)}${r}`, c.header, c, true)).join('');
  rows.push(`<row r="${r}">${header}</row>`);
  for (const row of s.rows) {
    r++;
    rows.push(
      `<row r="${r}">${row.map((v, i) => cellXml(`${letters(i)}${r}`, v, s.columns[i]!)).join('')}</row>`,
    );
  }
  const widths = s.columns
    .map(
      (c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.kind === 'text' ? 32 : 16}" customWidth="1"/>`,
    )
    .join('');
  return `${XML}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cols>${widths}</cols><sheetData>${rows.join('')}</sheetData></worksheet>`;
}

/** Excel sheet names: at most 31 characters, none of []:*?/\, unique. */
function sheetNames(names: string[]): string[] {
  const used = new Set<string>();
  return names.map((n, i) => {
    let name = n.replace(/[[\]:*?/\\]/g, ' ').slice(0, 31) || `Sheet ${i + 1}`;
    while (used.has(name.toLowerCase())) name = `${name.slice(0, 28)} ${i + 1}`;
    used.add(name.toLowerCase());
    return name;
  });
}

const STYLES = `${XML}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="164" formatCode="0.0##"/></numFmts>
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="5">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
</cellXfs></styleSheet>`;

export function toXlsx(t: ExportTable): Buffer {
  const names = sheetNames(t.sheets.map((s) => s.name));
  const files: [string, string][] = [
    [
      '[Content_Types].xml',
      `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${names
        .map(
          (_, i) =>
            `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
        )
        .join('')}</Types>`,
    ],
    [
      '_rels/.rels',
      `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    ],
    [
      'xl/workbook.xml',
      `${XML}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${names
        .map((n, i) => `<sheet name="${esc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
        .join('')}</sheets></workbook>`,
    ],
    [
      'xl/_rels/workbook.xml.rels',
      `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${names
        .map(
          (_, i) =>
            `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
        )
        .join(
          '',
        )}<Relationship Id="rId${names.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    ],
    ['xl/styles.xml', STYLES],
    ...t.sheets.map((s, i): [string, string] => [`xl/worksheets/sheet${i + 1}.xml`, sheetXml(t.title, s)]),
  ];
  return zip(files.map(([name, text]) => [name, Buffer.from(text, 'utf8')]));
}

/** A zip archive with deflated entries (APPNOTE 6.3): local headers, then the central directory. */
export function zip(entries: [string, Buffer][]): Buffer {
  const DOS_DATE = (0 << 9) | (1 << 5) | 1; // 1980-01-01; no timestamps are needed inside an export.
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const fileName = Buffer.from(name, 'utf8');
    const packed = deflateRawSync(data);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(fileName.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, fileName, packed);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0x0800, 8);
    dir.writeUInt16LE(8, 10);
    dir.writeUInt16LE(0, 12);
    dir.writeUInt16LE(DOS_DATE, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(packed.length, 20);
    dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(fileName.length, 28);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, fileName);
    offset += 30 + fileName.length + packed.length;
  }
  const dirSize = central.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(dirSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...central, end]);
}
