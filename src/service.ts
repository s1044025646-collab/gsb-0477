import type { Config } from './config.js';
import { Store, type StoredPair, type StoredRevision } from './db.js';
import { AppError } from './errors.js';
import { analyze } from './kappa.js';
import type { AnalysisResult, PairInput, WeightMode } from './types.js';
import { WEIGHT_MODES } from './types.js';

export const WEIGHT_VERSION = 'cohen-kappa-v1';

export interface ImportBody {
  categories: string[];
  pairs: PairInput[];
  note?: string;
  clientRequestId?: string;
}

export interface RevisionReport {
  revision: StoredRevision;
  analysis: AnalysisResult;
  reusedIdempotentRequest: boolean;
}

export class AnalysisService {
  constructor(private readonly store: Store, private readonly config: Config) {}

  import(body: ImportBody): RevisionReport {
    analyze({ categories: body.categories, pairs: body.pairs }, this.config.maxSamples);
    const { revision, reused } = this.store.importRevision({
      categories: body.categories,
      pairs: body.pairs,
      weightVersion: WEIGHT_VERSION,
      clientRequestId: body.clientRequestId,
      note: body.note,
    });
    return this.buildReport(revision.revisionId, reused);
  }

  private resolveRevisionId(revisionId?: number): number {
    if (revisionId !== undefined) return revisionId;
    const latest = this.store.latestRevisionId();
    if (latest === null) throw new AppError('NOT_FOUND', '尚无导入的修订版本', 404);
    return latest;
  }

  buildReport(requestedRevisionId?: number, reused = false): RevisionReport {
    const revisionId = this.resolveRevisionId(requestedRevisionId);
    const revision = this.store.getRevision(revisionId);
    const pairs = this.store.getPairs(revisionId);
    const analysis = analyze(
      { categories: revision.categories, pairs },
      this.config.maxSamples,
    );
    return { revision, analysis, reusedIdempotentRequest: reused };
  }

  modeResult(revisionId: number | undefined, mode: WeightMode, freeze = false) {
    if (!WEIGHT_MODES.includes(mode)) {
      throw new AppError('INVALID_REQUEST', `未知权重模式: ${String(mode)}`);
    }
    const id = this.resolveRevisionId(revisionId);
    if (freeze) {
      const frozen = this.store.getFrozenReport(id, mode);
      if (frozen) {
      return {
        revisionId: id,
        mode,
        result: frozen.payload,
        frozenAt: frozen.createdAt,
        reusedFrozenReport: true,
      };
      }
      const report = this.buildReport(id);
      const result = report.analysis.modes[mode];
      this.store.freezeReport(id, mode, result);
      return {
        revisionId: id,
        mode,
        result,
        frozenAt: new Date().toISOString(),
        reusedFrozenReport: false,
      };
    }
    const report = this.buildReport(id);
    return { revisionId: id, mode, result: report.analysis.modes[mode] };
  }

  matrix(revisionId?: number): RevisionReport {
    return this.buildReport(this.resolveRevisionId(revisionId));
  }

  exclusions(revisionId?: number, limit = 1000): { revisionId: number; pairs: StoredPair[] } {
    const id = this.resolveRevisionId(revisionId);
    if (limit > this.config.maxExportRows) {
      throw new AppError('LIMIT_EXCEEDED', `导出预览上限为 ${this.config.maxExportRows}`);
    }
    return { revisionId: id, pairs: this.store.getExcludedPairs(id).slice(0, limit) };
  }

  cellSources(
    revisionId: number | undefined,
    labelA: string,
    labelB: string,
    page: number,
    pageSize: number,
  ) {
    const id = this.resolveRevisionId(revisionId);
    const revision = this.store.getRevision(id);
    if (!revision.categories.includes(labelA) || !revision.categories.includes(labelB)) {
      throw new AppError('NOT_FOUND', '指定类别不在声明类别表中', 404);
    }
    if (!Number.isInteger(page) || page < 1) {
      throw new AppError('INVALID_REQUEST', 'page 必须为 >=1 的整数');
    }
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > this.config.pageSize) {
      throw new AppError('INVALID_REQUEST', `pageSize 必须为 1 到 ${this.config.pageSize} 的整数`);
    }
    const offset = (page - 1) * pageSize;
    const pageResult = this.store.getPairsForCell(id, labelA, labelB, pageSize, offset);
    return {
      revisionId: id,
      labelA,
      labelB,
      page,
      pageSize,
      total: pageResult.total,
      rows: pageResult.rows,
    };
  }

  compare(baseRevisionId?: number, targetRevisionId?: number) {
    const baseId = this.resolveRevisionId(baseRevisionId);
    const targetId = this.resolveRevisionId(targetRevisionId);
    if (baseId === targetId) {
      throw new AppError('INVALID_REQUEST', '比较需要两个不同的修订版本');
    }
    const base = this.buildReport(baseId);
    const target = this.buildReport(targetId);
    const changed: Array<{ sampleId: string; from: PairInput; to: PairInput }> = [];
    const basePairs = new Map(this.store.getPairs(baseId).map((pair) => [pair.sampleId, pair]));
    const targetPairs = this.store.getPairs(targetId);
    for (const targetPair of targetPairs) {
      const basePair = basePairs.get(targetPair.sampleId);
      if (!basePair || basePair.labelA !== targetPair.labelA || basePair.labelB !== targetPair.labelB) {
        changed.push({
          sampleId: targetPair.sampleId,
          from: basePair
            ? { sampleId: basePair.sampleId, labelA: basePair.labelA, labelB: basePair.labelB }
            : { sampleId: targetPair.sampleId, labelA: null, labelB: null },
          to: { sampleId: targetPair.sampleId, labelA: targetPair.labelA, labelB: targetPair.labelB },
        });
      }
    }
    for (const basePair of this.store.getPairs(baseId)) {
      if (!targetPairs.some((pair) => pair.sampleId === basePair.sampleId)) {
        changed.push({
          sampleId: basePair.sampleId,
          from: { sampleId: basePair.sampleId, labelA: basePair.labelA, labelB: basePair.labelB },
          to: { sampleId: basePair.sampleId, labelA: null, labelB: null },
        });
      }
    }
    return {
      baseRevisionId: baseId,
      targetRevisionId: targetId,
      base: summarizeKappas(base.analysis),
      target: summarizeKappas(target.analysis),
      changedSamples: changed,
    };
  }
}

export function summarizeKappas(analysis: AnalysisResult) {
  const result = {} as Record<WeightMode, { kappaDecimal: string | null; n: string; do: string; de: string }>;
  for (const mode of WEIGHT_MODES) {
    const item = analysis.modes[mode];
    result[mode] = {
      kappaDecimal: item.kappa === null ? null : item.kappa.decimal,
      n: item.n,
      do: item.do.decimal,
      de: item.de.decimal,
    };
  }
  return result;
}
