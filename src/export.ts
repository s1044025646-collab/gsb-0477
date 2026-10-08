import type { AnalysisResult, ModeResult, WeightMode } from './types.js';

function escapeCsv(value: string | number | null): string {
  if (value === null) return '';
  const text = String(value);
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function toCsv(rows: Array<Record<string, string | number | null>>): string {
  if (rows.length === 0) return '';
  const headers = Object.keys(rows[0]!);
  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(headers.map((header) => escapeCsv(row[header] ?? null)).join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}

export function matrixCsv(result: AnalysisResult): string {
  const rows: Array<Record<string, string>> = [];
  result.categories.forEach((categoryA, i) => {
    const row: Record<string, string> = { A_B: categoryA };
    result.categories.forEach((categoryB, j) => {
      row[categoryB] = result.counts[i]![j]!;
    });
    row.__row_total_A = result.rowTotals[i]!;
    rows.push(row);
  });
  const totalRow: Record<string, string> = { A_B: '__col_total_B' };
  result.categories.forEach((categoryB, j) => {
    totalRow[categoryB] = result.colTotals[j]!;
  });
  totalRow.__row_total_A = result.n;
  rows.push(totalRow);
  return toCsv(rows);
}

export function contributionsCsv(mode: ModeResult): string {
  return toCsv(
    mode.cells.map((cell) => ({
      categoryA: cell.categoryA,
      categoryB: cell.categoryB,
      count: cell.count,
      weight: cell.weight.decimal,
      observedShare: cell.observedShare.decimal,
      expectedShare: cell.expectedShare.decimal,
    })),
  );
}

export function summaryCsv(result: AnalysisResult): string {
  return toCsv(
    (Object.keys(result.modes) as WeightMode[]).map((modeName) => {
      const mode = result.modes[modeName];
      return {
        mode: modeName,
        n: mode.n,
        rawAgreement: mode.rawAgreement.decimal,
        chanceAgreement: mode.chanceAgreement.decimal,
        do: mode.do.decimal,
        de: mode.de.decimal,
        kappa: mode.kappa === null ? null : mode.kappa.decimal,
        kappaNullReason: mode.kappaNullReason,
      };
    }),
  );
}
