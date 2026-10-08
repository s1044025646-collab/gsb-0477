export type WeightMode = 'unweighted' | 'linear' | 'quadratic';

export const WEIGHT_MODES: readonly WeightMode[] = ['unweighted', 'linear', 'quadratic'];

export type Label = string | null;

export interface PairInput {
  sampleId: string;
  labelA: Label;
  labelB: Label;
}

export type DegenerateReason =
  | 'no_valid_pairs'
  | 'single_used_category'
  | 'perfect_marginal_alignment';

export interface CellContribution {
  categoryA: string;
  categoryB: string;
  rowIndex: number;
  colIndex: number;
  count: string;
  weight: { num: string; den: string; decimal: string };
  observedShare: { num: string; den: string; decimal: string };
  expectedShare: { num: string; den: string; decimal: string };
}

export interface ModeResult {
  mode: WeightMode;
  k: number;
  n: string;
  rawAgreement: { num: string; den: string; decimal: string };
  do: { num: string; den: string; decimal: string };
  de: { num: string; den: string; decimal: string };
  chanceAgreement: { num: string; den: string; decimal: string };
  kappa: { num: string; den: string; decimal: string } | null;
  kappaNullReason: DegenerateReason | null;
  cells: CellContribution[];
  weights: string[][];
}

export interface ExclusionCounts {
  missingA: number;
  missingB: number;
  missingBoth: number;
  excludedTotal: number;
}

export interface AnalysisInput {
  categories: string[];
  pairs: PairInput[];
}

export interface AnalysisResult {
  categories: string[];
  k: number;
  counts: string[][];
  rowTotals: string[];
  colTotals: string[];
  n: string;
  inputTotal: number;
  exclusions: ExclusionCounts;
  modes: Record<WeightMode, ModeResult>;
}
