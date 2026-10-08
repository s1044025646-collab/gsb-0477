import * as fs from "node:fs";
import { Store, ApiError } from "./store";
import { WEIGHT_MODES, WeightMode } from "./kappa";
import { computeAndFreeze, startServer } from "./server";

const store = new Store();

function out(v: unknown) { console.log(JSON.stringify(v, null, 2)); }
function fail(e: any): never {
  if (e instanceof ApiError) { console.error(`错误 [${e.code}] ${e.message}`); process.exit(2); }
  throw e;
}
const readJson = (p: string) => JSON.parse(fs.readFileSync(p, "utf-8"));

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  try {
    switch (cmd) {
      case "serve": {
        const port = await startServer(store);
        console.log(`端口: ${port}（PORT 环境变量可固定端口）`);
        return; // 保持进程
      }
      case "import": {
        // import <name> <file.json>  —— 文件含 {categories, records}
        const [name, file] = args;
        const f = readJson(file);
        out(store.importDataset(name, f.categories, f.records));
        break;
      }
      case "preview": {
        const id = args[0];
        const ds = store.getDataset(id);
        const version = store.currentVersion(id);
        const recs = store.getRecords(id, version).filter(r => r.exclude_reason !== "INCLUDED");
        out({ categories: ds.categories, version, exclusions: store.exclusions(id, version), excluded: recs });
        break;
      }
      case "matrix": {
        const id = args[0];
        const ds = store.getDataset(id);
        const counts = store.countMatrix(id, store.currentVersion(id), ds.categories.length);
        out({ categories: ds.categories, counts: counts.map(r => r.map(String)) });
        break;
      }
      case "kappa": {
        const [id, mode = "unweighted"] = args;
        out(computeAndFreeze(store, id, store.currentVersion(id), mode as WeightMode));
        break;
      }
      case "compare": {
        const id = args[0];
        const v = store.currentVersion(id);
        for (const m of WEIGHT_MODES) {
          const r = computeAndFreeze(store, id, v, m);
          console.log(`${m}: kappa=${r.kappa} Do=${r.observedDisagreement} De=${r.expectedDisagreement} status=${r.status}`);
        }
        break;
      }
      case "cell": {
        const [id, i, j, page = "1", pageSize = "100"] = args;
        const ds = store.getDataset(id);
        out(store.cellSamples(id, store.currentVersion(id), ds.categories[+i], ds.categories[+j], +page, +pageSize));
        break;
      }
      case "revise": {
        const [id, file] = args;
        out(store.revise(id, readJson(file).records ?? readJson(file)));
        break;
      }
      case "diff": {
        const [id, from, to] = args;
        const v = store.currentVersion(id);
        const f = from ? +from : v - 1, t = to ? +to : v;
        const a = new Map(store.getRecords(id, f).map(r => [r.sample_id, r]));
        const b = new Map(store.getRecords(id, t).map(r => [r.sample_id, r]));
        const changed: any[] = [];
        for (const [sid, rb] of b) {
          const ra = a.get(sid);
          if (!ra) changed.push({ id: sid, type: "added" });
          else if (ra.label_a !== rb.label_a || ra.label_b !== rb.label_b)
            changed.push({ id: sid, type: "modified", from: { a: ra.label_a, b: ra.label_b }, to: { a: rb.label_a, b: rb.label_b } });
        }
        for (const [sid] of a) if (!b.has(sid)) changed.push({ id: sid, type: "removed" });
        out({ from: f, to: t, changed });
        break;
      }
      case "export": {
        const [id, mode = "unweighted", format = "json"] = args;
        const r = computeAndFreeze(store, id, store.currentVersion(id), mode as WeightMode);
        if (format === "json") out(r);
        else {
          console.log([["", ...r.categories].join(","), ...r.counts.map((row, i) => [r.categories[i], ...row].join(","))].join("\n"));
          console.log(`kappa,${r.kappa}`);
        }
        break;
      }
      case "demo": {
        const fixture = JSON.parse(fs.readFileSync(require("node:path").join(__dirname, "../../fixtures/demo.json"), "utf-8"));
        for (const ds of fixture.datasets) {
          const r = store.importDataset(ds.name, ds.categories, ds.records);
          console.log(`\n=== ${ds.name} (id=${r.datasetId}) ===`);
          console.log(`排除: ${JSON.stringify(r.exclusions)}`);
          for (const m of WEIGHT_MODES) {
            const k = computeAndFreeze(store, r.datasetId, r.version, m);
            console.log(`  ${m.padEnd(11)} kappa=${k.kappa} Do=${k.observedDisagreement} De=${k.expectedDisagreement} status=${k.status}${k.degenerateReason ? " (" + k.degenerateReason + ")" : ""}`);
          }
        }
        break;
      }
      default:
        console.log(`用法: node dist/src/cli.js <命令>
  serve                        启动 API（默认空闲端口，PORT 可固定）
  import <name> <file.json>    幂等导入配对标注
  preview <datasetId>          预览排除原因
  matrix <datasetId>           计数矩阵
  kappa <datasetId> [mode]     按模式计算（unweighted|linear|quadratic）
  compare <datasetId>          三模式并排对照
  cell <id> <i> <j> [p] [sz]   查询某格来源样本（分页）
  revise <id> <file.json>      导入修订（新版本）
  diff <id> [from] [to]        比较标注修订
  export <id> [mode] [json|csv] 导出
  demo                         运行内置演示`);
        if (cmd) process.exit(2);
    }
  } catch (e) { fail(e); }
  if (cmd !== "serve") store.close();
}
main();
