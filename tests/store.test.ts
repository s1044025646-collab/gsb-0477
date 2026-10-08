import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { loadConfig } from '../src/config.ts';
import { Store } from '../src/db.ts';
import { AppError } from '../src/errors.ts';
import { AnalysisService } from '../src/service.ts';

function tempService() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kappa-test-'));
  const config = { ...loadConfig({}, dataDir), dataDir, dbPath: path.join(dataDir, 'test.sqlite') };
  const store = new Store(config);
  const service = new AnalysisService(store, config);
  return { config, store, service };
}

describe('SQLite 修订、幂等和分页', () => {
  it('重复 clientRequestId 返回同一修订；不同请求体冲突', () => {
    const { store, service } = tempService();
    const body = {
      categories: ['a', 'b'],
      pairs: [{ sampleId: 's1', labelA: 'a', labelB: 'b' }],
      clientRequestId: 'fixed-id',
    };
    const first = service.import(body);
    const second = service.import(body);
    assert.equal(first.revision.revisionId, second.revision.revisionId);
    assert.equal(second.reusedIdempotentRequest, true);
    assert.throws(
      () => service.import({
        ...body,
        pairs: [
          { sampleId: 's1', labelA: 'a', labelB: 'b' },
          { sampleId: 's2', labelA: 'b', labelB: 'a' },
        ],
      }),
      (error: unknown) => error instanceof AppError && error.code === 'CONFLICT',
    );
    store[Symbol.dispose]();
  });

  it('未知类别与重复样本 ID 整体失败且无修订残留', () => {
    const { store, service } = tempService();
    assert.throws(() => service.import({
      categories: ['a', 'b'],
      pairs: [{ sampleId: 'x', labelA: 'a', labelB: 'unknown' }],
    }));
    assert.equal(store.listRevisions().length, 0);
    assert.throws(() => service.import({
      categories: ['a', 'b'],
      pairs: [
        { sampleId: 'x', labelA: 'a', labelB: 'a' },
        { sampleId: 'x', labelA: 'b', labelB: 'b' },
      ],
    }));
    assert.equal(store.listRevisions().length, 0);
    store[Symbol.dispose]();
  });

  it('重启后可从原样本重建相同报告，来源分页不改变 n', () => {
    const { config, store, service } = tempService();
    const imported = service.import({
      categories: ['a', 'b'],
      pairs: [
        { sampleId: 's1', labelA: 'a', labelB: 'b' },
        { sampleId: 's2', labelA: 'a', labelB: 'b' },
        { sampleId: 's3', labelA: 'b', labelB: 'a' },
      ],
    });
    const id = imported.revision.revisionId;
    store[Symbol.dispose]();

    const reopened = new Store(config);
    const reopenedService = new AnalysisService(reopened, config);
    const rebuilt = reopenedService.matrix(id);
    assert.equal(rebuilt.analysis.n, '3');
    assert.deepEqual(rebuilt.analysis.counts, [['0', '2'], ['1', '0']]);
    const page = reopenedService.cellSources(id, 'a', 'b', 1, 1);
    assert.equal(page.total, 2);
    assert.equal(page.rows.length, 1);
    assert.equal(reopenedService.matrix(id).analysis.n, '3');
    reopened[Symbol.dispose]();
  });

  it('修订比较输出变化样本', () => {
    const { store, service } = tempService();
    const first = service.import({
      categories: ['a', 'b'],
      pairs: [{ sampleId: 's1', labelA: 'a', labelB: 'a' }],
    });
    const second = service.import({
      categories: ['a', 'b'],
      pairs: [{ sampleId: 's1', labelA: 'a', labelB: 'b' }],
    });
    const comparison = service.compare(first.revision.revisionId, second.revision.revisionId);
    assert.equal(comparison.changedSamples.length, 1);
    assert.equal(comparison.changedSamples[0]!.to.labelB, 'b');
    store[Symbol.dispose]();
  });
});
