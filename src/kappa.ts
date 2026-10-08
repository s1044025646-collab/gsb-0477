import { AppError } from './errors.js';
import { Rational } from './rational.js';
import type {
  AnalysisInput,
  AnalysisResult,
  CellContribution,
  DegenerateReason,
  ModeResult,
  WeightMode,
} from './types.js';
import { WEIGHT_MODES } from './types.js';

export const MAX_CATEGORIES = 20;
export const MIN_CATEGORIES = 2;

export function validateCategories(categories: unknown): string[] {
  if (!Array.isArray(categories)) {
    throw new AppError('INVALID_CATEGORIES', 'categories 必须为数组');
  }
  if (categories.length < MIN_CATEGORIES || categories.length > MAX_CATEGORIES) {
    throw new AppError(
      'INVALID_CATEGORIES',
      `唯一类别数量必须在 ${MIN_CATEGORIES} 到 ${MAX_CATEGORIES} 之间，实际为 ${categories.length}`,
    );
  }
  const result: string[] = [];
  const seen = new Set<string>();
  for (const item of categories) {
    if (typeof item !== 'string' || item.length === 0) {
      throw new AppError('INVALID_CATEGORIES', '类别必须为非空字符串');
    }
    if (seen.has(item)) {
      throw new AppError('INVALID_CATEGORIES', `类别列表存在重复类别: ${item}`);
    }
    seen.add(item);
    result.push(item);
  }
  return result;
}

export function validatePairs(pairs: unknown, maxSamples: number) {
  if (!Array.isArray(pairs)) {
    throw new AppError('INVALID_REQUEST', 'pairs 必须为数组');
  }
  if (pairs.length > maxSamples) {
    throw new AppError('LIMIT_EXCEEDED', `样本数量超过上限 ${maxSamples}`);
  }
  const ids = new Set<string>();
  for (const row of pairs) {
    if (row === null || typeof row !== 'object') {
      throw new AppError('INVALID_REQUEST', '每条样本必须为对象');
    }
    const { sampleId, labelA, labelB } = row as Record<string, unknown>;
    if (typeof sampleId !== 'string' || sampleId.length === 0) {
      throw new AppError('INVALID_REQUEST', 'sampleId 必须为非空字符串');
    }
    if (ids.has(sampleId)) {
      throw new AppError('DUPLICATE_SAMPLE_ID', `重复样本 ID: ${sampleId}`, 409, { sampleId });
    }
    ids.add(sampleId);
    if (labelA !== null && typeof labelA !== 'string') {
      throw new AppError('INVALID_REQUEST', `样本 ${sampleId} 的 labelA 必须为字符串或 null`);
    }
    if (labelB !== null && typeof labelB !== 'string') {
      throw new AppError('INVALID_REQUEST', `样本 ${sampleId} 的 labelB 必须为字符串或 null`);
    }
  }
}

export function weightMatrix(k: number, mode: WeightMode): Rational[][] {
  const matrix: Rational[][] = [];
  for (let i = 0; i < k; i += 1) {
    const row: Rational[] = [];
    for (let j = 0; j < k; j += 1) {
      if (i === j) {
        row.push(Rational.zero());
      } else if (mode === 'unweighted') {
        row.push(Rational.from(1));
      } else {
        const linear = Rational.from(Math.abs(i - j), k - 1);
        row.push(mode === 'linear' ? linear : linear.mul(linear));
      }
    }
    matrix.push(row);
  }
  return matrix;
}

function countUsedCategories(
  counts: bigint[][],
  rowTotals: bigint[],
  colTotals: bigint[],
): number {
  let used = 0;
  for (let i = 0; i < counts.length; i += 1) {
    if (rowTotals[i] !== 0n || colTotals[i] !== 0n) used += 1;
  }
  return used;
}

function computeMode(
  mode: WeightMode,
  categories: string[],
  counts: bigint[][],
  rowTotals: bigint[],
  colTotals: bigint[],
  n: bigint,
): ModeResult {
  const k = categories.length;
  const weights = weightMatrix(k, mode);
  const cells: CellContribution[] = [];
  let doSum = Rational.zero();
  let deSum = Rational.zero();

  if (n > 0n) {
    for (let i = 0; i < k; i += 1) {
      for (let j = 0; j < k; j += 1) {
        const w = weights[i]![j]!;
        const observed = w.mul(Rational.from(counts[i]![j]!, n));
        const expected = w.mul(Rational.from(rowTotals[i]! * colTotals[j]!, n * n));
        doSum = doSum.add(observed);
        deSum = deSum.add(expected);
        cells.push({
          categoryA: categories[i]!,
          categoryB: categories[j]!,
          rowIndex: i,
          colIndex: j,
          count: counts[i]![j]!.toString(),
          weight: w.toJSON(),
          observedShare: observed.toJSON(),
          expectedShare: expected.toJSON(),
        });
      }
    }
  }

  let rawAgreement = Rational.zero();
  for (let i = 0; i < k; i += 1) {
    if (n > 0n) rawAgreement = rawAgreement.add(Rational.from(counts[i]![i]!, n));
  }

  let kappa: Rational | null = null;
  let reason: DegenerateReason | null = null;
  if (n === 0n) {
    reason = 'no_valid_pairs';
  } else if (deSum.isZero()) {
    reason = countUsedCategories(counts, rowTotals, colTotals) <= 1
      ? 'single_used_category'
      : 'perfect_marginal_alignment';
  } else {
    kappa = Rational.from(1).sub(doSum.div(deSum));
  }

  const chanceAgreement = n === 0n ? Rational.zero() : Rational.from(1).sub(deSum);

  return {
    mode,
    k,
    n: n.toString(),
    rawAgreement: rawAgreement.toJSON(),
    do: doSum.toJSON(),
    de: deSum.toJSON(),
    chanceAgreement: chanceAgreement.toJSON(),
    kappa: kappa === null ? null : kappa.toJSON(),
    kappaNullReason: reason,
    cells,
    weights: weights.map((row) => row.map((value) => value.toDecimal())),
  };
}

export function analyze(input: AnalysisInput, maxSamples: number): AnalysisResult {
  const categories = validateCategories(input.categories);
  validatePairs(input.pairs, maxSamples);
  const k = categories.length;
  const index = new Map(categories.map((category, i) => [category, i]));

  const counts: bigint[][] = Array.from({ length: k }, () =>
    Array.from({ length: k }, () => 0n),
  );
  const rowTotals = Array.from({ length: k }, () => 0n);
  const colTotals = Array.from({ length: k }, () => 0n);

  let missingA = 0;
  let missingB = 0;
  let missingBoth = 0;

  for (const pair of input.pairs) {
    const aNull = pair.labelA === null;
    const bNull = pair.labelB === null;
    if (aNull && bNull) {
      missingBoth += 1;
      continue;
    }
    if (aNull) {
      missingA += 1;
      continue;
    }
    if (bNull) {
      missingB += 1;
      continue;
    }
    const labelA = pair.labelA as string;
    const labelB = pair.labelB as string;
    const i = index.get(labelA);
    const j = index.get(labelB);
    if (i === undefined) {
      throw new AppError('UNKNOWN_CATEGORY', `样本 ${pair.sampleId} 的 A 标签不在类别表中: ${labelA}`, 422, {
        sampleId: pair.sampleId,
        rater: 'A',
        label: pair.labelA,
      });
    }
    if (j === undefined) {
      throw new AppError('UNKNOWN_CATEGORY', `样本 ${pair.sampleId} 的 B 标签不在类别表中: ${labelB}`, 422, {
        sampleId: pair.sampleId,
        rater: 'B',
        label: pair.labelB,
      });
    }
    counts[i]![j]! += 1n;
    rowTotals[i]! += 1n;
    colTotals[j]! += 1n;
  }

  let n = 0n;
  for (const total of rowTotals) n += total;
  let colCheck = 0n;
  for (const total of colTotals) colCheck += total;
  if (n !== colCheck) throw new Error('行列总量不一致，计数内部错误');
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new AppError('LIMIT_EXCEEDED', `有效对数超过 JS 安全整数上限: ${n}`, 422);
  }

  const modes = {} as Record<WeightMode, ModeResult>;
  for (const mode of WEIGHT_MODES) {
    modes[mode] = computeMode(mode, categories, counts, rowTotals, colTotals, n);
  }

  return {
    categories,
    k,
    counts: counts.map((row) => row.map((value) => value.toString())),
    rowTotals: rowTotals.map((value) => value.toString()),
    colTotals: colTotals.map((value) => value.toString()),
    n: n.toString(),
    inputTotal: input.pairs.length,
    exclusions: {
      missingA,
      missingB,
      missingBoth,
      excludedTotal: missingA + missingB + missingBoth,
    },
    modes,
  };
}
