import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { analyze } from '../src/kappa.ts';
import type { PairInput } from '../src/types.ts';

const categories2 = ['N', 'Y'];

function pairsFromCounts(matrix: number[][], categories: string[]): PairInput[] {
  const pairs: PairInput[] = [];
  let seq = 0;
  for (let i = 0; i < matrix.length; i += 1) {
    for (let j = 0; j < matrix[i]!.length; j += 1) {
      for (let c = 0; c < matrix[i]![j]!; c += 1) {
        seq += 1;
        pairs.push({ sampleId: `s${seq}`, labelA: categories[i]!, labelB: categories[j]! });
      }
    }
  }
  return pairs;
}

describe('Cohen kappa 手算夹具', () => {
  it('[[3,1],[1,3]] 得到完全一致 0.75、偶然一致 0.5、kappa 0.5', () => {
    const result = analyze({ categories: categories2, pairs: pairsFromCounts([[3, 1], [1, 3]], categories2) }, 1000);
    const mode = result.modes.unweighted;
    assert.equal(result.n, '8');
    assert.equal(mode.rawAgreement.decimal, '0.75');
    assert.equal(mode.chanceAgreement.decimal, '0.5');
    assert.equal(mode.kappa?.decimal, '0.5');
  });

  it('[[0,4],[4,0]] 为 -1 且不裁剪', () => {
    const result = analyze({ categories: categories2, pairs: pairsFromCounts([[0, 4], [4, 0]], categories2) }, 1000);
    assert.equal(result.modes.unweighted.kappa?.decimal, '-1');
  });

  it('三类别相邻距离为 1/2，跨两级为 1；二次权重为平方', () => {
    const ordered = ['low', 'mid', 'high'];
    const result = analyze({ categories: ordered, pairs: pairsFromCounts([[0, 1, 1], [1, 0, 1], [1, 1, 0]], ordered) }, 1000);
    assert.equal(result.modes.linear.weights[0]?.[1], '0.5');
    assert.equal(result.modes.linear.weights[0]?.[2], '1');
    assert.equal(result.modes.quadratic.weights[0]?.[1], '0.25');
    assert.equal(result.modes.quadratic.weights[0]?.[2], '1');
  });

  it('全体同类时 De 为零，返回 null 与 single_used_category', () => {
    const result = analyze({
      categories: categories2,
      pairs: Array.from({ length: 4 }, (_, i) => ({ sampleId: `s${i}`, labelA: 'N', labelB: 'N' })),
    }, 1000);
    assert.equal(result.modes.unweighted.kappa, null);
    assert.equal(result.modes.unweighted.kappaNullReason, 'single_used_category');
  });

  it('全部缺失时为无有效数据状态', () => {
    const result = analyze({
      categories: categories2,
      pairs: [
        { sampleId: 'a', labelA: null, labelB: 'Y' },
        { sampleId: 'b', labelA: 'N', labelB: null },
        { sampleId: 'c', labelA: null, labelB: null },
      ],
    }, 1000);
    assert.equal(result.n, '0');
    assert.deepEqual(result.exclusions, { missingA: 1, missingB: 1, missingBoth: 1, excludedTotal: 3 });
    assert.equal(result.modes.unweighted.kappaNullReason, 'no_valid_pairs');
  });
});

describe('对称性、顺序和有效样本口径', () => {
  it('交换评定者只转置矩阵，系数不变', () => {
    const ordered = ['a', 'b', 'c'];
    const pairs = pairsFromCounts([[2, 1, 0], [0, 3, 2], [1, 0, 4]], ordered);
    const first = analyze({ categories: ordered, pairs }, 1000);
    const swappedPairs = pairs.map((pair) => ({ sampleId: pair.sampleId, labelA: pair.labelB, labelB: pair.labelA }));
    const swapped = analyze({ categories: ordered, pairs: swappedPairs }, 1000);
    assert.deepEqual(swapped.counts, first.counts[0]!.map((_, j) => first.counts.map((row) => row[j]!)));
    for (const mode of ['unweighted', 'linear', 'quadratic'] as const) {
      assert.equal(swapped.modes[mode].kappa?.decimal, first.modes[mode].kappa?.decimal);
    }
  });

  it('复制全部样本保持系数', () => {
    const ordered = ['x', 'y'];
    const pairs = pairsFromCounts([[3, 1], [1, 3]], ordered);
    const doubled = [...pairs, ...pairs.map((pair) => ({ ...pair, sampleId: `${pair.sampleId}-copy` }))];
    assert.equal(
      analyze({ categories: ordered, pairs }, 1000).modes.unweighted.kappa?.decimal,
      analyze({ categories: ordered, pairs: doubled }, 1000).modes.unweighted.kappa?.decimal,
    );
  });

  it('输入行序变化不影响结果，类别声明顺序不按名称排序', () => {
    const ordered = ['z', 'a', 'm'];
    const pairs = pairsFromCounts([[1, 2, 0], [0, 2, 1], [2, 0, 1]], ordered);
    const shuffled = [...pairs].reverse();
    const a = analyze({ categories: ordered, pairs }, 1000);
    const b = analyze({ categories: ordered, pairs: shuffled }, 1000);
    assert.deepEqual(a.counts, b.counts);
    assert.deepEqual(a.categories, ['z', 'a', 'm']);
  });

  it('完整反转类别顺序保持线性和二次 kappa', () => {
    const ordered = ['low', 'mid', 'high'];
    const pairs = pairsFromCounts([[2, 1, 0], [0, 3, 2], [1, 0, 4]], ordered);
    const reversedCategories = [...ordered].reverse();
    const reverseLabel = (label: string) => reversedCategories[ordered.indexOf(label)]!;
    const reversedPairs = pairs.map((pair) => ({
      sampleId: pair.sampleId,
      labelA: reverseLabel(pair.labelA!),
      labelB: reverseLabel(pair.labelB!),
    }));
    const original = analyze({ categories: ordered, pairs }, 1000);
    const reversed = analyze({ categories: reversedCategories, pairs: reversedPairs }, 1000);
    assert.equal(reversed.modes.linear.kappa?.decimal, original.modes.linear.kappa?.decimal);
    assert.equal(reversed.modes.quadratic.kappa?.decimal, original.modes.quadratic.kappa?.decimal);
  });

  it('单侧缺失不进入边际，且报告各缺失原因', () => {
    const pairs: PairInput[] = [
      { sampleId: '1', labelA: 'N', labelB: 'N' },
      { sampleId: '2', labelA: null, labelB: 'Y' },
      { sampleId: '3', labelA: 'Y', labelB: null },
    ];
    const result = analyze({ categories: categories2, pairs }, 1000);
    assert.equal(result.n, '1');
    assert.deepEqual(result.rowTotals, ['1', '0']);
    assert.deepEqual(result.colTotals, ['1', '0']);
  });
});
