import type { Cell, ExportTable } from './table';

/**
 * Text that a spreadsheet would read as a formula (=, +, -, @, tab, carriage return) gets a leading apostrophe, so
 * a guest name or narration can never run as a formula when the file is opened (CSV injection). Number columns are
 * written as they are.
 */
export function safeText(v: string): string {
  return /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
}

function quote(v: string): string {
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

function cell(v: Cell, numeric: boolean): string {
  if (v === null) return '';
  if (typeof v === 'number') return String(v);
  return quote(numeric ? v : safeText(v));
}

/**
 * RFC 4180 CSV in UTF-8 with a byte-order mark (so Excel reads Urdu names and the rupee sign correctly). Several
 * tables follow one another, each under its name, separated by a blank line.
 */
export function toCsv(t: ExportTable): Buffer {
  const lines: string[] = t.title.map((l) => quote(safeText(l)));
  for (const s of t.sheets) {
    lines.push('');
    if (t.sheets.length > 1) lines.push(quote(safeText(s.name)));
    lines.push(s.columns.map((c) => quote(safeText(c.header))).join(','));
    for (const r of s.rows) {
      lines.push(
        r.map((v, i) => cell(v, s.columns[i]!.kind !== 'text' && s.columns[i]!.kind !== 'date')).join(','),
      );
    }
  }
  return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(`${lines.join('\r\n')}\r\n`, 'utf8')]);
}
