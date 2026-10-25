/**
 * A report as plain tables, the one shape both export formats are written from. Money is kept as its decimal
 * string all the way into the file: it is never turned into a JavaScript number.
 */
export type ColumnKind = 'text' | 'money' | 'int' | 'decimal' | 'date';

export interface Column {
  header: string;
  kind: ColumnKind;
}

/** A cell: text, a decimal string (money or decimal columns), an integer, or empty. */
export type Cell = string | number | null;

export interface Sheet {
  name: string;
  columns: Column[];
  rows: Cell[][];
}

export interface ExportTable {
  /** Lines printed above the first table: report name, property, dates, currency, generated at. */
  title: string[];
  sheets: Sheet[];
}

export const col = (header: string, kind: ColumnKind = 'text'): Column => ({ header, kind });

export function rowCount(t: ExportTable): number {
  return t.sheets.reduce((n, s) => n + s.rows.length, 0);
}
