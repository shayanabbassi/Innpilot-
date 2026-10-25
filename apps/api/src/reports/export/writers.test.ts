import { inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { safeText, toCsv } from './csv';
import { col, rowCount, type ExportTable } from './table';
import { toXlsx } from './xlsx';

const table: ExportTable = {
  title: ['Report', '+Hotel'],
  sheets: [
    {
      name: 'Main: [1]/2',
      columns: [col('Name'), col('Amount', 'money'), col('Count', 'int')],
      rows: [
        ['=1+1', '-12.50', 3],
        ['Line "one", two\nthree', '1000.00', null],
        ['Ali <&> Co', null, 0],
      ],
    },
    { name: 'Main: [1]/2', columns: [col('Only')], rows: [] },
  ],
};

describe('CSV writer', () => {
  it('guards formulas in text but not in amounts', () => {
    expect(['=SUM(A1)', '+1', '-2', '@x', '\tx', 'plain'].map(safeText)).toEqual([
      "'=SUM(A1)",
      "'+1",
      "'-2",
      "'@x",
      "'\tx",
      'plain',
    ]);
    const text = toCsv(table).toString('utf8');
    expect(text.charCodeAt(0)).toBe(0xfeff);
    expect(text).toContain("\r\n'=1+1,-12.50,3\r\n");
    expect(text).toContain('"Line ""one"", two\nthree",1000.00,\r\n');
    expect(text).toContain("'+Hotel\r\n");
  });

  it('counts rows across sheets', () => {
    expect(rowCount(table)).toBe(3);
  });
});

describe('Excel writer', () => {
  it('writes a valid zip with escaped text, numeric amounts and safe, unique sheet names', () => {
    const buf = toXlsx(table);
    const files = new Map<string, string>();
    let i = 0;
    while (buf.readUInt32LE(i) === 0x04034b50) {
      const size = buf.readUInt32LE(i + 18);
      const nameLen = buf.readUInt16LE(i + 26);
      const name = buf.toString('utf8', i + 30, i + 30 + nameLen);
      const start = i + 30 + nameLen;
      files.set(name, inflateRawSync(buf.subarray(start, start + size)).toString('utf8'));
      i = start + size;
    }
    // Central directory and end record follow the entries.
    expect(buf.readUInt32LE(buf.length - 22)).toBe(0x06054b50);
    expect(buf.readUInt16LE(buf.length - 12)).toBe(files.size);
    const sheet = files.get('xl/worksheets/sheet1.xml')!;
    expect(sheet).toContain('<c r="B5" s="2"><v>-12.50</v></c>');
    expect(sheet).toContain('<c r="C5" s="3"><v>3</v></c>');
    expect(sheet).toContain('<t xml:space="preserve">\'=1+1</t>');
    expect(sheet).toContain('Ali &lt;&amp;&gt; Co');
    expect(files.get('xl/workbook.xml')).toContain('<sheet name="Main   1  2" sheetId="1"');
    expect(files.get('xl/workbook.xml')).toContain('<sheet name="Main   1  2 2" sheetId="2"');
  });
});
