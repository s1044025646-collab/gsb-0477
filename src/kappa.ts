import { Frac, frac, fadd, fmul, fsub, fdiv, fisZero, fnum, fint } from "./fraction";

export type WeightMode = "unweighted" | "linear" | "quadratic";
export const WEIGHT_MODES: WeightMode[] = ["unweighted", "linear", "quadratic"];
export const WEIGHT_VERSION = "cohen-kappa/v1";

/** 不一致权 d_ij：无权 0/1；线性 |i-j|/(k-1)；二次为其平方。i、j 用声明类别顺序。 */
export function disagreementWeight(mode: WeightMode, i: number, j: number, k: number): Frac {
  const dist = BigInt(Math.abs(i - j));
  const span = BigInt(k - 1);
  switch (mode) {
    case "unweighted": return frac(i === j ? 0n : 1n, 1n);
    case "linear": return frac(dist, span);
    case "quadratic": return frac(dist * dist, span * span);
  }
}

export interface CellContribution {
  row: number; col: number;
  categoryA: string; categoryB: string;
  count: string;            // 安全整数字符串
  weight: number;
  doContribution: number;   // d_ij * C_ij / n
  deContribution: number;   // d_ij * row_i * col_j / n^2
}

export interface KappaResult {
  mode: WeightMode;
  weightVersion: string;
  categories: string[];      // 原序保存
  n: string;
  counts: string[][];
  rowMarginals: string[];    // A 边际
  colMarginals: string[];    // B 边际
  status: "ok" | "no_valid_pairs" | "degenerate";
  degenerateReason: string | null;
  rawAgreement: number | null;   // 原始完全相同标签比例
  expectedAgreement: number | null; // 偶然一致比例（1-De 口径下为 sum row*col/n^2）
  observedDisagreement: number | null;  // Do
  expectedDisagreement: number | null;  // De
  kappa: number | null;          // 可为负，不裁剪
  cells: CellContribution[];
}

/** 核心：Do 与 De 使用同一有效样本口径（同一 n）。 */
export function analyze(categories: string[], counts: bigint[][], mode: WeightMode): KappaResult {
  const k = categories.length;
  const rows: bigint[] = new Array(k).fill(0n);
  const cols: bigint[] = new Array(k).fill(0n);
  let n = 0n, diag = 0n;
  for (let i = 0; i < k; i++) {
    for (let j = 0; j < k; j++) {
      const c = counts[i][j];
      rows[i] += c; cols[j] += c; n += c;
      if (i === j) diag += c;
    }
  }
  const base: KappaResult = {
    mode, weightVersion: WEIGHT_VERSION, categories: [...categories],
    n: n.toString(),
    counts: counts.map(r => r.map(c => c.toString())),
    rowMarginals: rows.map(String), colMarginals: cols.map(String),
    status: "ok", degenerateReason: null,
    rawAgreement: null, expectedAgreement: null,
    observedDisagreement: null, expectedDisagreement: null,
    kappa: null, cells: [],
  };
  if (n === 0n) {
    base.status = "no_valid_pairs";
    base.degenerateReason = "NO_VALID_PAIRS: 有效成对样本数 n 为 0，不伪造零一致性";
    return base;
  }
  const nf = fint(n);
  let Do = frac(0n), De = frac(0n), agreeE = frac(0n);
  const cells: CellContribution[] = [];
  for (let i = 0; i < k; i++) {
    for (let j = 0; j < k; j++) {
      const d = disagreementWeight(mode, i, j, k);
      const doC = fdiv(fmul(d, fint(counts[i][j])), nf);
      const deC = fdiv(fmul(d, fint(rows[i] * cols[j])), fmul(nf, nf));
      Do = fadd(Do, doC);
      De = fadd(De, deC);
      if (i === j) agreeE = fadd(agreeE, fdiv(fint(rows[i] * cols[j]), fmul(nf, nf)));
      cells.push({
        row: i, col: j,
        categoryA: categories[i], categoryB: categories[j],
        count: counts[i][j].toString(),
        weight: fnum(d),
        doContribution: fnum(doC),
        deContribution: fnum(deC),
      });
    }
  }
  base.cells = cells;
  base.rawAgreement = fnum(fdiv(fint(diag), nf));
  base.expectedAgreement = fnum(agreeE);
  base.observedDisagreement = fnum(Do);
  base.expectedDisagreement = fnum(De);
  if (fisZero(De)) {
    // 精确有理数判定：偶然不一致分母为零（全部边际集中于同一类别）
    base.status = "degenerate";
    base.degenerateReason = "DE_ZERO: 偶然不一致分母 De 为 0（有效样本边际集中于同一类别），kappa 未定义，不强行定为 1";
    return base;
  }
  base.kappa = fnum(fsub(frac(1n), fdiv(Do, De)));
  return base;
}

/** 从成对样本独立枚举计数（用于复核 / 测试交叉验证）。 */
export function enumerateCounts(categories: string[], pairs: { a: string; b: string }[]): bigint[][] {
  const k = categories.length;
  const idx = new Map(categories.map((c, i) => [c, i]));
  const m: bigint[][] = Array.from({ length: k }, () => new Array<bigint>(k).fill(0n));
  for (const p of pairs) m[idx.get(p.a)!][idx.get(p.b)!] += 1n;
  return m;
}
