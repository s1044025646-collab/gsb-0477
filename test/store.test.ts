import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Store, ApiError } from "../src/store";
import { computeAndFreeze } from "../src/server";

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kappa-"));
  return new Store(path.join(dir, "t.db"));
}

const cats = ["neg", "pos"];
const recs = [
  { id: "s1", a: "pos", b: "pos" }, { id: "s2", a: "pos", b: "pos" }, { id: "s3", a: "pos", b: "pos" },
  { id: "s4", a: "pos", b: "neg" }, { id: "s5", a: "neg", b: "pos" },
  { id: "s6", a: "neg", b: "neg" }, { id: "s7", a: "neg", b: "neg" }, { id: "s8", a: "neg", b: "neg" },
];

test("导入 + 计数 + kappa 与手算一致", () => {
  const s = tmpStore();
  const r = s.importDataset("d1", cats, recs);
  assert.equal(r.exclusions.included, 8);
  const k = computeAndFreeze(s, r.datasetId, 1, "unweighted");
  assert.equal(k.kappa, 0.5);
  assert.equal(k.rawAgreement, 0.75);
  s.close();
});

test("缺失配对：整对排除并分别计数，缺一方不混入边际", () => {
  const s = tmpStore();
  const r = s.importDataset("d2", cats, [
    { id: "a", a: "pos", b: "pos" },
    { id: "b", a: null, b: "pos" },
    { id: "c", a: "neg", b: null },
    { id: "d", a: null, b: null },
  ]);
  assert.deepEqual(r.exclusions, { total: 4, included: 1, missingA: 1, missingB: 1, missingBoth: 1 });
  const k = computeAndFreeze(s, r.datasetId, 1, "unweighted");
  assert.equal(k.n, "1");
  assert.equal(k.rowMarginals.join(), "0,1"); // 缺 B 的 neg 不进入 A 边际
  s.close();
});

test("未知类别与重复 ID 整体失败，不留部分统计", () => {
  const s = tmpStore();
  assert.throws(() => s.importDataset("d3", cats, [{ id: "x", a: "nope", b: "pos" }]),
    (e: ApiError) => e.code === "UNKNOWN_CATEGORY");
  assert.throws(() => s.importDataset("d3", cats, [...recs, { id: "s1", a: "pos", b: "pos" }]),
    (e: ApiError) => e.code === "DUPLICATE_SAMPLE_ID");
  assert.throws(() => s.getDataset("anything"), (e: ApiError) => e.code === "DATASET_NOT_FOUND");
  s.close();
});

test("幂等导入：同名同内容返回已有数据集", () => {
  const s = tmpStore();
  const r1 = s.importDataset("d4", cats, recs);
  const r2 = s.importDataset("d4", cats, recs);
  assert.equal(r1.datasetId, r2.datasetId);
  assert.equal(r2.idempotent, true);
  s.close();
});

test("修订产生新版本，diff 报告变更，冻结报告可复核", () => {
  const s = tmpStore();
  const r = s.importDataset("d5", cats, recs);
  const recs2 = recs.map(x => x.id === "s4" ? { ...x, b: "pos" } : x);
  const rv = s.revise(r.datasetId, recs2);
  assert.equal(rv.version, 2);
  const rv2 = s.revise(r.datasetId, recs2); // 幂等
  assert.equal(rv2.version, 2);
  assert.equal(rv2.idempotent, true);
  const k1 = computeAndFreeze(s, r.datasetId, 1, "unweighted");
  const k2 = computeAndFreeze(s, r.datasetId, 2, "unweighted");
  assert.notEqual(k1.kappa, k2.kappa);
  const frozen = s.getReport(r.datasetId, 1, "unweighted");
  assert.equal(frozen!.payload.kappa, 0.5);
  s.close();
});

test("重启后可从原样本复核计数", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kappa-"));
  const p = path.join(dir, "t.db");
  const s1 = new Store(p);
  const r = s1.importDataset("d6", cats, recs);
  s1.close();
  const s2 = new Store(p);
  const k = computeAndFreeze(s2, r.datasetId, 1, "unweighted");
  assert.equal(k.kappa, 0.5);
  assert.equal(k.n, "8");
  s2.close();
});

test("某格来源样本分页不改变 n", () => {
  const s = tmpStore();
  const r = s.importDataset("d7", cats, recs);
  const page1 = s.cellSamples(r.datasetId, 1, "pos", "pos", 1, 2);
  assert.equal(page1.total, 3);
  assert.equal(page1.items.length, 2);
  const k = computeAndFreeze(s, r.datasetId, 1, "unweighted");
  assert.equal(k.n, "8");
  s.close();
});
