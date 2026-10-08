import { test } from "node:test";
import assert from "node:assert/strict";
import { analyze, enumerateCounts, disagreementWeight } from "../src/kappa";
import { frac, fnum, fdiv, fint, fadd, fmul } from "../src/fraction";

const B = (m: number[][]) => m.map(r => r.map(BigInt));
const cats2 = ["neg", "pos"];

test("手算夹具 [[3,1],[1,3]]: 完全一致率 0.75, 偶然一致率 0.5, kappa 0.5", () => {
  const r = analyze(cats2, B([[3, 1], [1, 3]]), "unweighted");
  assert.equal(r.n, "8");
  assert.equal(r.rawAgreement, 0.75);
  assert.equal(r.expectedAgreement, 0.5);
  assert.equal(r.observedDisagreement, 0.25);
  assert.equal(r.expectedDisagreement, 0.5);
  assert.equal(r.kappa, 0.5);
});

test("手算夹具 [[0,4],[4,0]]: kappa = -1（负值合法，不裁剪）", () => {
  const r = analyze(cats2, B([[0, 4], [4, 0]]), "unweighted");
  assert.equal(r.kappa, -1);
  assert.equal(r.rawAgreement, 0);
});

test("有序三类别：相邻误分权 1/2，跨两级误分权 1（线性）；二次为 1/4 与 1", () => {
  const cats = ["low", "mid", "high"];
  assert.equal(fnum(disagreementWeight("linear", 0, 1, 3)), 0.5);
  assert.equal(fnum(disagreementWeight("linear", 0, 2, 3)), 1);
  assert.equal(fnum(disagreementWeight("quadratic", 0, 1, 3)), 0.25);
  assert.equal(fnum(disagreementWeight("quadratic", 0, 2, 3)), 1);
  // 同样计数下三种模式 kappa 不同，但计数表不变
  const m = B([[2, 1, 1], [0, 2, 1], [1, 0, 2]]);
  const u = analyze(cats, m, "unweighted");
  const l = analyze(cats, m, "linear");
  const q = analyze(cats, m, "quadratic");
  assert.deepEqual(u.counts, l.counts);
  assert.deepEqual(l.counts, q.counts);
  assert.notEqual(u.kappa, l.kappa);
  assert.notEqual(l.kappa, q.kappa);
});

test("退化：全体同类 De=0 → kappa null 并给出原因，不强行定为 1", () => {
  const r = analyze(cats2, B([[5, 0], [0, 0]]), "unweighted");
  assert.equal(r.status, "degenerate");
  assert.equal(r.kappa, null);
  assert.match(r.degenerateReason!, /DE_ZERO/);
});

test("退化：n=0（全部缺失）→ no_valid_pairs，不伪造零一致性", () => {
  const r = analyze(cats2, B([[0, 0], [0, 0]]), "unweighted");
  assert.equal(r.status, "no_valid_pairs");
  assert.equal(r.kappa, null);
});

test("交换评定者只转置计数，系数不变", () => {
  const cats = ["a", "b", "c"];
  const m = B([[3, 1, 0], [2, 4, 1], [0, 1, 5]]);
  const t = m.map((row, i) => row.map((_, j) => m[j][i]));
  for (const mode of ["unweighted", "linear", "quadratic"] as const) {
    const r1 = analyze(cats, m, mode);
    const r2 = analyze(cats, t, mode);
    assert.equal(r1.kappa, r2.kappa, mode);
    assert.deepEqual(r2.counts, t.map(r => r.map(String)));
  }
});

test("复制全部样本保持系数", () => {
  const m = B([[3, 1], [1, 3]]);
  const m2 = B([[6, 2], [2, 6]]);
  for (const mode of ["unweighted", "linear", "quadratic"] as const)
    assert.equal(analyze(cats2, m, mode).kappa, analyze(cats2, m2, mode).kappa);
});

test("完整反转类别顺序保持线性与二次距离，kappa 不变；报告保存原序", () => {
  const cats = ["low", "mid", "high"];
  const m = B([[2, 1, 1], [0, 2, 1], [1, 0, 2]]);
  const revCats = [...cats].reverse();
  const k = 3;
  const revM = m.map((row, i) => row.map((_, j) => m[k - 1 - i][k - 1 - j]));
  for (const mode of ["linear", "quadratic"] as const) {
    assert.equal(analyze(cats, m, mode).kappa, analyze(revCats, revM, mode).kappa);
  }
  const r = analyze(cats, m, "linear");
  assert.deepEqual(r.categories, cats); // 原序保存
});

test("随意交换中间类别可能改变加权结果", () => {
  const cats = ["low", "mid", "high"];
  const m = B([[5, 2, 0], [0, 3, 1], [1, 0, 4]]);
  const swapped = ["low", "high", "mid"];
  const perm = [0, 2, 1];
  const m2 = m.map((row, i) => row.map((_, j) => m[perm[i]][perm[j]]));
  assert.notEqual(analyze(cats, m, "linear").kappa, analyze(swapped, m2, "linear").kappa);
});

test("独立从样本枚举配对并按边际乘积核对 De", () => {
  const cats = ["a", "b", "c"];
  const pairs = [
    { a: "a", b: "a" }, { a: "a", b: "b" }, { a: "b", b: "a" },
    { a: "b", b: "b" }, { a: "c", b: "c" }, { a: "c", b: "a" },
    { a: "a", b: "c" }, { a: "b", b: "b" },
  ];
  const m = enumerateCounts(cats, pairs);
  const r = analyze(cats, m, "quadratic");
  // 手工按边际乘积重算 De
  const n = 8n;
  const rows = m.map(row => row.reduce((x, y) => x + y, 0n));
  const cols = [0, 1, 2].map(j => m.reduce((x, row) => x + row[j], 0n));
  let de = frac(0n);
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) {
      const d = disagreementWeight("quadratic", i, j, 3);
      de = fadd(de, fdiv(fmul(d, fint(rows[i] * cols[j])), fint(n * n)));
    }
  assert.ok(Math.abs(fnum(de) - r.expectedDisagreement!) < 1e-12);
});
