import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Config } from './config.js';
import { AppError } from './errors.js';
import type { PairInput } from './types.js';
import crypto from 'node:crypto';

export interface ImportOptions {
  categories: string[];
  pairs: PairInput[];
  weightVersion: string;
  clientRequestId?: string;
  note?: string;
}

export interface StoredRevision {
  revisionId: number;
  weightVersion: string;
  categories: string[];
  createdAt: string;
  note: string | null;
  clientRequestId: string | null;
}

export interface StoredPair extends PairInput {
  revisionId: number;
}

export interface FrozenReport {
  revisionId: number;
  mode: string;
  payload: unknown;
  createdAt: string;
}

export class Store implements Disposable {
  readonly db: DatabaseSync;

  constructor(private readonly config: Config) {
    fs.mkdirSync(config.dataDir, { recursive: true });
    this.db = new DatabaseSync(config.dbPath);
    this.db.exec('PRAGMA journal_mode=WAL');
    this.db.exec('PRAGMA foreign_keys=ON');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS revisions (
        revision_id INTEGER PRIMARY KEY AUTOINCREMENT,
        weight_version TEXT NOT NULL,
        categories TEXT NOT NULL,
        note TEXT,
        client_request_id TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
    `);
    const columns = this.db.prepare('PRAGMA table_info(revisions)').all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === 'payload_hash')) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS revisions_new (
          revision_id INTEGER PRIMARY KEY AUTOINCREMENT,
          weight_version TEXT NOT NULL,
          categories TEXT NOT NULL,
          payload_hash TEXT,
          note TEXT,
          client_request_id TEXT,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );
        INSERT INTO revisions_new
          (revision_id, weight_version, categories, payload_hash, note, client_request_id, created_at)
        SELECT revision_id, weight_version, categories, NULL, note, client_request_id, created_at
        FROM revisions;
        DROP TABLE revisions;
        ALTER TABLE revisions_new RENAME TO revisions;
      `);
    }
    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_revisions_request
        ON revisions(client_request_id) WHERE client_request_id IS NOT NULL;

      CREATE TABLE IF NOT EXISTS pairs (
        revision_id INTEGER NOT NULL REFERENCES revisions(revision_id) ON DELETE CASCADE,
        sample_id TEXT NOT NULL,
        label_a TEXT,
        label_b TEXT,
        PRIMARY KEY (revision_id, sample_id)
      );

      CREATE TABLE IF NOT EXISTS frozen_reports (
        revision_id INTEGER NOT NULL REFERENCES revisions(revision_id) ON DELETE CASCADE,
        mode TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        PRIMARY KEY (revision_id, mode)
      );
    `);
  }

  listRevisions(): StoredRevision[] {
    const rows = this.db
      .prepare('SELECT * FROM revisions ORDER BY revision_id')
      .all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      revisionId: Number(row.revision_id),
      weightVersion: String(row.weight_version),
      categories: JSON.parse(String(row.categories)) as string[],
      createdAt: String(row.created_at),
      note: row.note === null ? null : String(row.note),
      clientRequestId: row.client_request_id === null ? null : String(row.client_request_id),
    }));
  }

  getRevision(revisionId: number): StoredRevision {
    const row = this.db
      .prepare('SELECT * FROM revisions WHERE revision_id = ?')
      .get(revisionId) as Record<string, unknown> | undefined;
    if (!row) throw new AppError('NOT_FOUND', `修订版本不存在: ${revisionId}`, 404);
    return {
      revisionId: Number(row.revision_id),
      weightVersion: String(row.weight_version),
      categories: JSON.parse(String(row.categories)) as string[],
      createdAt: String(row.created_at),
      note: row.note === null ? null : String(row.note),
      clientRequestId: row.client_request_id === null ? null : String(row.client_request_id),
    };
  }

  latestRevisionId(): number | null {
    const row = this.db
      .prepare('SELECT MAX(revision_id) AS revision_id FROM revisions')
      .get() as { revision_id: number | null };
    return row.revision_id ?? null;
  }

  findRevisionByRequestId(requestId: string): StoredRevision | null {
    const row = this.db
      .prepare('SELECT * FROM revisions WHERE client_request_id = ?')
      .get(requestId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.getRevision(Number(row.revision_id));
  }

  importRevision(options: ImportOptions): { revision: StoredRevision; reused: boolean } {
    const payloadHash = stableHash({ categories: options.categories, pairs: options.pairs });
    if (options.clientRequestId) {
      const existing = this.findRevisionByRequestId(options.clientRequestId);
      if (existing) {
        const hashRow = this.db
          .prepare('SELECT payload_hash AS payload_hash FROM revisions WHERE revision_id = ?')
          .get(existing.revisionId) as { payload_hash: string | null } | undefined;
        if (
          JSON.stringify(existing.categories) !== JSON.stringify(options.categories) ||
          existing.weightVersion !== options.weightVersion ||
          hashRow?.payload_hash !== payloadHash
        ) {
          throw new AppError(
            'CONFLICT',
            `幂等键 ${options.clientRequestId} 已存在，但请求体与原请求不一致`,
            409,
          );
        }
        return { revision: existing, reused: true };
      }
    }

    const insertRevision = this.db.prepare(
      `INSERT INTO revisions (weight_version, categories, payload_hash, note, client_request_id)
       VALUES (?, ?, ?, ?, ?)`,
    );
    const insertPair = this.db.prepare(
      `INSERT INTO pairs (revision_id, sample_id, label_a, label_b) VALUES (?, ?, ?, ?)`,
    );

    let revisionId = 0;
    try {
      const result = this.db.exec('BEGIN IMMEDIATE');
      void result;
      const info = insertRevision.run(
        options.weightVersion,
        JSON.stringify(options.categories),
        payloadHash,
        options.note ?? null,
        options.clientRequestId ?? null,
      ) as { lastInsertRowid: number | bigint };
      revisionId = Number(info.lastInsertRowid);
      for (const pair of options.pairs) {
        insertPair.run(revisionId, pair.sampleId, pair.labelA, pair.labelB);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      if (String((error as Error).message).includes('UNIQUE')) {
        throw new AppError('CONFLICT', '重复的幂等键或样本 ID', 409);
      }
      throw new AppError('IMPORT_FAILED', `导入失败，已回滚: ${(error as Error).message}`, 500);
    }
    return { revision: this.getRevision(revisionId), reused: false };
  }

  getPairs(revisionId: number): StoredPair[] {
    this.getRevision(revisionId);
    const rows = this.db
      .prepare('SELECT sample_id, label_a, label_b FROM pairs WHERE revision_id = ? ORDER BY sample_id')
      .all(revisionId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      revisionId,
      sampleId: String(row.sample_id),
      labelA: row.label_a === null ? null : String(row.label_a),
      labelB: row.label_b === null ? null : String(row.label_b),
    }));
  }

  getPairsForCell(
    revisionId: number,
    labelA: string,
    labelB: string,
    limit: number,
    offset: number,
  ): { rows: StoredPair[]; total: number } {
    this.getRevision(revisionId);
    const countRow = this.db
      .prepare(
        `SELECT COUNT(*) AS total FROM pairs
         WHERE revision_id = ? AND label_a = ? AND label_b = ?`,
      )
      .get(revisionId, labelA, labelB) as { total: number };
    const rows = this.db
      .prepare(
        `SELECT sample_id, label_a, label_b FROM pairs
         WHERE revision_id = ? AND label_a = ? AND label_b = ?
         ORDER BY sample_id LIMIT ? OFFSET ?`,
      )
      .all(revisionId, labelA, labelB, limit, offset) as Array<Record<string, unknown>>;
    return {
      total: Number(countRow.total),
      rows: rows.map((row) => ({
        revisionId,
        sampleId: String(row.sample_id),
        labelA: String(row.label_a),
        labelB: String(row.label_b),
      })),
    };
  }

  getExcludedPairs(revisionId: number): StoredPair[] {
    this.getRevision(revisionId);
    const rows = this.db
      .prepare(
        `SELECT sample_id, label_a, label_b FROM pairs
         WHERE revision_id = ? AND (label_a IS NULL OR label_b IS NULL)
         ORDER BY sample_id`,
      )
      .all(revisionId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      revisionId,
      sampleId: String(row.sample_id),
      labelA: row.label_a === null ? null : String(row.label_a),
      labelB: row.label_b === null ? null : String(row.label_b),
    }));
  }

  freezeReport(revisionId: number, mode: string, payload: unknown): void {
    this.db
      .prepare(
        `INSERT INTO frozen_reports (revision_id, mode, payload) VALUES (?, ?, ?)
         ON CONFLICT(revision_id, mode) DO NOTHING`,
      )
      .run(revisionId, mode, JSON.stringify(payload));
  }

  getFrozenReport(revisionId: number, mode: string): FrozenReport | null {
    const row = this.db
      .prepare('SELECT payload, created_at FROM frozen_reports WHERE revision_id = ? AND mode = ?')
      .get(revisionId, mode) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      revisionId,
      mode,
      payload: JSON.parse(String(row.payload)),
      createdAt: String(row.created_at),
    };
  }

 [Symbol.dispose](): void {
    this.db.close();
  }
}

export function resolveDataFile(config: Config, filename: string): string {
  return path.join(config.dataDir, filename);
}

function stableHash(value: unknown): string {
  return crypto.createHash('sha256').update(canonicalString(value)).digest('hex');
}

function canonicalString(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalString).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalString(record[key])}`).join(',')}}`;
}
