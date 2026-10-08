import { DatabaseSync } from "node:sqlite";
import * as crypto from "node:crypto";
import * as path from "node:path";
import * as fs from "node:fs";
import { WEIGHT_VERSION } from "./kappa";

export const MAX_SAMPLES = Number(process.env.KAPPA_MAX_SAMPLES ?? 100000);
export const MAX_EXPORT = Number(process.env.KAPPA_MAX_EXPORT ?? 10000);

export class ApiError extends Error {
  constructor(public code: string, message: string, public status = 400, public details?: unknown) {
    super(message);
  }
}

export interface RawRecord { id: string; a: string | null; b: string | null; }

export interface ExclusionSummary {
  total: number; included: number;
  missingA: number; missingB: number; missingBoth: number;
}

export class Store {
  db: DatabaseSync;
  constructor(dbPath?: string) {
    const dir = process.env.KAPPA_DATA_DIR ?? path.join(process.cwd(), "data");
    fs.mkdirSync(dir, { recursive: true });
    this.db = new DatabaseSync(dbPath ?? path.join(dir, "kappa.db"));
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS datasets(
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        categories TEXT NOT NULL,
        weight_version TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS records(
        dataset_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        sample_id TEXT NOT NULL,
        label_a TEXT,
        label_b TEXT,
        exclude_reason TEXT NOT NULL,
        PRIMARY KEY(dataset_id, version, sample_id)
      );
      CREATE TABLE IF NOT EXISTS reports(
        dataset_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        mode TEXT NOT NULL,
        frozen_at TEXT NOT NULL,
        payload TEXT NOT NULL,
        PRIMARY KEY(dataset_id, version, mode)
      );
    `);
  }
  close() { this.db.close(); }

  private validateCategories(categories: unknown): string[] {
    if (!Array.isArray(categories)) throw new ApiError("INVALID_CATEGORIES", "categories 必须是字符串数组");
    if (categories.length < 2 || categories.length > 20)
      throw new ApiError("INVALID_CATEGORIES", "类别数量必须在 2 到 20 之间");
    for (const c of categories)
      if (typeof c !== "string" || c.length === 0)
        throw new ApiError("INVALID_CATEGORIES", "类别必须是非空字符串（大小写敏感，保持声明顺序）");
    if (new Set(categories).size !== categories.length)
      throw new ApiError("INVALID_CATEGORIES", "类别列表存在重复项");
    return categories as string[];
  }

  private validateRecords(records: unknown): RawRecord[] {
    if (!Array.isArray(records)) throw new ApiError("INVALID_RECORDS", "records 必须是数组");
    if (records.length > MAX_SAMPLES)
      throw new ApiError("TOO_MANY_SAMPLES", `样本数 ${records.length} 超过上限 ${MAX_SAMPLES}`);
    const seen = new Set<string>();
    const out: RawRecord[] = [];
    for (const r of records as any[]) {
      if (!r || typeof r.id !== "string" || r.id.length === 0)
        throw new ApiError("INVALID_RECORDS", "每条记录必须有非空字符串 id");
      if (seen.has(r.id))
        throw new ApiError("DUPLICATE_SAMPLE_ID", `重复样本 ID: ${r.id}，导入整体失败`);
      seen.add(r.id);
      const chk = (v: unknown) => v === null || typeof v === "string";
      if (!chk(r.a) || !chk(r.b))
        throw new ApiError("INVALID_RECORDS", `样本 ${r.id} 的 a/b 必须是类别字符串或 null`);
      out.push({ id: r.id, a: r.a, b: r.b });
    }
    return out;
  }

  private exclusion(a: string | null, b: string | null): string {
    if (a !== null && b !== null) return "INCLUDED";
    if (a === null && b === null) return "MISSING_BOTH";
    return a === null ? "MISSING_A" : "MISSING_B";
  }

  /** 幂等导入：同名同内容返回已有数据集；任何校验错误整体失败，不留部分数据。 */
  importDataset(name: string, categories: unknown, records: unknown): { datasetId: string; version: number; exclusions: ExclusionSummary; idempotent: boolean } {
    if (typeof name !== "string" || !name) throw new ApiError("INVALID_NAME", "name 必须是非空字符串");
    const cats = this.validateCategories(categories);
    const recs = this.validateRecords(records);
    const catSet = new Set(cats);
    for (const r of recs) {
      if (r.a !== null && !catSet.has(r.a)) throw new ApiError("UNKNOWN_CATEGORY", `样本 ${r.id} 的 a 标签未知: ${r.a}`);
      if (r.b !== null && !catSet.has(r.b)) throw new ApiError("UNKNOWN_CATEGORY", `样本 ${r.id} 的 b 标签未知: ${r.b}`);
    }
    const existing = this.db.prepare("SELECT id, categories FROM datasets WHERE name=?").get(name) as any;
    if (existing) {
      if (existing.categories !== JSON.stringify(cats))
        throw new ApiError("NAME_CONFLICT", `数据集名称 ${name} 已存在且类别顺序不同`, 409);
      const cur = this.currentVersion(existing.id);
      const curRecs = this.getRecords(existing.id, cur).map(r => ({ id: r.sample_id, a: r.label_a, b: r.label_b }));
      if (JSON.stringify(curRecs) === JSON.stringify(recs))
        return { datasetId: existing.id, version: cur, exclusions: this.exclusions(existing.id, cur), idempotent: true };
      throw new ApiError("NAME_CONFLICT", `数据集名称 ${name} 已存在且记录不同；请使用修订接口`, 409);
    }
    const id = crypto.randomUUID();
    this.db.exec("BEGIN");
    try {
      this.db.prepare("INSERT INTO datasets(id,name,categories,weight_version,created_at) VALUES(?,?,?,?,?)")
        .run(id, name, JSON.stringify(cats), WEIGHT_VERSION, new Date().toISOString());
      const ins = this.db.prepare("INSERT INTO records(dataset_id,version,sample_id,label_a,label_b,exclude_reason) VALUES(?,?,?,?,?,?)");
      for (const r of recs) ins.run(id, 1, r.id, r.a, r.b, this.exclusion(r.a, r.b));
      this.db.exec("COMMIT");
    } catch (e) { this.db.exec("ROLLBACK"); throw e; }
    return { datasetId: id, version: 1, exclusions: this.exclusions(id, 1), idempotent: false };
  }

  /** 修订：产生新版本；内容与上一版一致则幂等返回当前版本。 */
  revise(datasetId: string, records: unknown): { version: number; exclusions: ExclusionSummary; idempotent: boolean } {
    const ds = this.getDataset(datasetId);
    const recs = this.validateRecords(records);
    const catSet = new Set(ds.categories);
    for (const r of recs) {
      if (r.a !== null && !catSet.has(r.a)) throw new ApiError("UNKNOWN_CATEGORY", `样本 ${r.id} 的 a 标签未知: ${r.a}`);
      if (r.b !== null && !catSet.has(r.b)) throw new ApiError("UNKNOWN_CATEGORY", `样本 ${r.id} 的 b 标签未知: ${r.b}`);
    }
    const cur = this.currentVersion(datasetId);
    const curRecs = this.getRecords(datasetId, cur).map(r => ({ id: r.sample_id, a: r.label_a, b: r.label_b }));
    if (JSON.stringify(curRecs) === JSON.stringify(recs))
      return { version: cur, exclusions: this.exclusions(datasetId, cur), idempotent: true };
    const next = cur + 1;
    this.db.exec("BEGIN");
    try {
      const ins = this.db.prepare("INSERT INTO records(dataset_id,version,sample_id,label_a,label_b,exclude_reason) VALUES(?,?,?,?,?,?)");
      for (const r of recs) ins.run(datasetId, next, r.id, r.a, r.b, this.exclusion(r.a, r.b));
      this.db.exec("COMMIT");
    } catch (e) { this.db.exec("ROLLBACK"); throw e; }
    return { version: next, exclusions: this.exclusions(datasetId, next), idempotent: false };
  }

  getDataset(id: string): { id: string; name: string; categories: string[]; weightVersion: string } {
    const row = this.db.prepare("SELECT * FROM datasets WHERE id=?").get(id) as any;
    if (!row) throw new ApiError("DATASET_NOT_FOUND", `数据集不存在: ${id}`, 404);
    return { id: row.id, name: row.name, categories: JSON.parse(row.categories), weightVersion: row.weight_version };
  }

  currentVersion(datasetId: string): number {
    const row = this.db.prepare("SELECT MAX(version) v FROM records WHERE dataset_id=?").get(datasetId) as any;
    return row?.v ?? 0;
  }

  getRecords(datasetId: string, version: number): { sample_id: string; label_a: string | null; label_b: string | null; exclude_reason: string }[] {
    return this.db.prepare("SELECT sample_id,label_a,label_b,exclude_reason FROM records WHERE dataset_id=? AND version=? ORDER BY rowid")
      .all(datasetId, version) as any[];
  }

  exclusions(datasetId: string, version: number): ExclusionSummary {
    const rows = this.db.prepare("SELECT exclude_reason r, COUNT(*) c FROM records WHERE dataset_id=? AND version=? GROUP BY exclude_reason")
      .all(datasetId, version) as any[];
    const m = Object.fromEntries(rows.map(r => [r.r, Number(r.c)]));
    const s: ExclusionSummary = {
      total: rows.reduce((a, r) => a + Number(r.c), 0),
      included: m.INCLUDED ?? 0,
      missingA: m.MISSING_A ?? 0,
      missingB: m.MISSING_B ?? 0,
      missingBoth: m.MISSING_BOTH ?? 0,
    };
    return s;
  }

  /** 有效对计数矩阵（只含双侧非空记录；缺一方的观测不进入边际）。 */
  countMatrix(datasetId: string, version: number, k: number): bigint[][] {
    const m: bigint[][] = Array.from({ length: k }, () => new Array<bigint>(k).fill(0n));
    const rows = this.db.prepare(
      "SELECT label_a,label_b,COUNT(*) c FROM records WHERE dataset_id=? AND version=? AND exclude_reason='INCLUDED' GROUP BY label_a,label_b"
    ).all(datasetId, version) as any[];
    const cats = this.getDataset(datasetId).categories;
    const idx = new Map(cats.map((c, i) => [c, i]));
    for (const r of rows) m[idx.get(r.label_a)!][idx.get(r.label_b)!] += BigInt(r.c);
    return m;
  }

  /** 某格来源样本，分页不影响统计口径 n。 */
  cellSamples(datasetId: string, version: number, catA: string, catB: string, page: number, pageSize: number) {
    const size = Math.min(Math.max(1, pageSize), 1000);
    const offset = Math.max(0, page - 1) * size;
    const total = (this.db.prepare(
      "SELECT COUNT(*) c FROM records WHERE dataset_id=? AND version=? AND exclude_reason='INCLUDED' AND label_a=? AND label_b=?"
    ).get(datasetId, version, catA, catB) as any).c as number;
    const items = this.db.prepare(
      "SELECT sample_id,label_a,label_b FROM records WHERE dataset_id=? AND version=? AND exclude_reason='INCLUDED' AND label_a=? AND label_b=? ORDER BY rowid LIMIT ? OFFSET ?"
    ).all(datasetId, version, catA, catB, size, offset);
    return { total, page, pageSize: size, items };
  }

  freezeReport(datasetId: string, version: number, mode: string, payload: unknown) {
    this.db.prepare(
      "INSERT INTO reports(dataset_id,version,mode,frozen_at,payload) VALUES(?,?,?,?,?) " +
      "ON CONFLICT(dataset_id,version,mode) DO UPDATE SET payload=excluded.payload"
    ).run(datasetId, version, mode, new Date().toISOString(), JSON.stringify(payload));
  }

  getReport(datasetId: string, version: number, mode: string) {
    const row = this.db.prepare("SELECT payload,frozen_at FROM reports WHERE dataset_id=? AND version=? AND mode=?")
      .get(datasetId, version, mode) as any;
    return row ? { frozenAt: row.frozen_at, payload: JSON.parse(row.payload) } : null;
  }
}
