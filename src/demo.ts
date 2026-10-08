import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.js';
import { Store } from './db.js';
import { AnalysisService } from './service.js';

const config = loadConfig(process.env, path.resolve(process.cwd()));
fs.rmSync(config.dbPath, { force: true });
for (const suffix of ['-wal', '-shm']) fs.rmSync(`${config.dbPath}${suffix}`, { force: true });

const categories = ['差', '中', '好'];
const pairs = [
  { sampleId: 's01', labelA: '差', labelB: '差' },
  { sampleId: 's02', labelA: '差', labelB: '中' },
  { sampleId: 's03', labelA: '中', labelB: '好' },
  { sampleId: 's04', labelA: '好', labelB: '好' },
  { sampleId: 's05', labelA: '好', labelB: '中' },
  { sampleId: 's06', labelA: null, labelB: '好' },
  { sampleId: 's07', labelA: '中', labelB: null },
  { sampleId: 's08', labelA: null, labelB: null },
];

using store = new Store(config);
const service = new AnalysisService(store, config);
const first = service.import({
  categories,
  pairs,
  clientRequestId: 'demo-v1',
  note: '演示修订 v1',
});

const revised = pairs.map((pair) =>
  pair.sampleId === 's02' ? { ...pair, labelB: '差' } : pair,
);
const second = service.import({
  categories,
  pairs: revised,
  clientRequestId: 'demo-v2',
  note: '修订 s02 后形成新版本',
});

console.log('修订 v1:');
console.log(JSON.stringify({
  n: first.analysis.n,
  exclusions: first.analysis.exclusions,
  summary: first.analysis.modes,
}, null, 2));
console.log('\n修订 v2 普通 kappa:', second.analysis.modes.unweighted.kappa);
console.log('\n比较:');
console.log(JSON.stringify(service.compare(first.revision.revisionId, second.revision.revisionId).changedSamples, null, 2));
console.log(`\n数据库: ${config.dbPath}`);
