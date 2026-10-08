#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.js';
import { Store } from './db.js';
import { AppError } from './errors.js';
import { contributionsCsv, matrixCsv, summaryCsv } from './export.js';
import { analyze } from './kappa.js';
import { AnalysisService, WEIGHT_VERSION } from './service.js';
import type { PairInput, WeightMode } from './types.js';

interface CliArgs {
  command: string;
  values: Map<string, string>;
  flags: Set<string>;
  positional: string[];
}

function parseArgs(argv: string[]): CliArgs {
  const [command = 'help', ...rest] = argv;
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const positional: string[] = [];
  for (const arg of rest) {
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq >= 0) values.set(arg.slice(2, eq), arg.slice(eq + 1));
      else flags.add(arg.slice(2));
    } else {
      positional.push(arg);
    }
  }
  return { command, values, flags, positional };
}

function readJsonFile<T>(filename: string): T {
  return JSON.parse(fs.readFileSync(path.resolve(filename), 'utf8')) as T;
}

function writeOutput(filename: string | undefined, content: string): void {
  if (!filename || filename === '-') process.stdout.write(content);
  else fs.writeFileSync(path.resolve(filename), content, 'utf8');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const store = new Store(config);
  const service = new AnalysisService(store, config);

  try {
    if (args.command === 'import') {
      const body = readJsonFile<{
        categories: string[];
        pairs: PairInput[];
        note?: string;
        clientRequestId?: string;
      }>(args.values.get('file') ?? args.positional[0] ?? '');
      const result = service.import(body);
      writeOutput(args.values.get('out'), JSON.stringify(result, null, 2));
      if (args.values.get('out')) {
        console.log(`已导入修订版本 ${result.revision.revisionId}`);
      }
    } else if (args.command === 'report') {
      const revisionId = args.values.has('revision') ? Number(args.values.get('revision')) : undefined;
      const report = service.matrix(revisionId);
      writeOutput(args.values.get('out'), JSON.stringify(report, null, 2));
    } else if (args.command === 'mode') {
      const mode = (args.values.get('weight') ?? 'unweighted') as WeightMode;
      const revisionId = args.values.has('revision') ? Number(args.values.get('revision')) : undefined;
      const result = service.modeResult(revisionId, mode, args.flags.has('freeze'));
      const csv = args.flags.has('csv');
      writeOutput(
        args.values.get('out'),
        csv ? contributionsCsv(result.result as never) : JSON.stringify(result, null, 2),
      );
    } else if (args.command === 'matrix-csv') {
      const revisionId = args.values.has('revision') ? Number(args.values.get('revision')) : undefined;
      writeOutput(args.values.get('out') ?? '-', matrixCsv(service.matrix(revisionId).analysis));
    } else if (args.command === 'summary-csv') {
      const revisionId = args.values.has('revision') ? Number(args.values.get('revision')) : undefined;
      writeOutput(args.values.get('out') ?? '-', summaryCsv(service.matrix(revisionId).analysis));
    } else if (args.command === 'exclusions') {
      const revisionId = args.values.has('revision') ? Number(args.values.get('revision')) : undefined;
      writeOutput(args.values.get('out'), JSON.stringify(service.exclusions(revisionId), null, 2));
    } else if (args.command === 'cell') {
      const revisionId = args.values.has('revision') ? Number(args.values.get('revision')) : undefined;
      const result = service.cellSources(
        revisionId,
        requireValue(args, 'label-a'),
        requireValue(args, 'label-b'),
        Number(args.values.get('page') ?? 1),
        Number(args.values.get('page-size') ?? config.pageSize),
      );
      writeOutput(args.values.get('out'), JSON.stringify(result, null, 2));
    } else if (args.command === 'compare') {
      const result = service.compare(
        Number(requireValue(args, 'base')),
        Number(requireValue(args, 'target')),
      );
      writeOutput(args.values.get('out'), JSON.stringify(result, null, 2));
    } else if (args.command === 'compute-file') {
      const body = readJsonFile<{ categories: string[]; pairs: PairInput[] }>(
        args.values.get('file') ?? args.positional[0] ?? '',
      );
      const result = analyze(body, config.maxSamples);
      writeOutput(args.values.get('out') ?? '-', JSON.stringify(result, null, 2));
    } else if (args.command === 'revisions') {
      writeOutput(args.values.get('out'), JSON.stringify({ weightVersion: WEIGHT_VERSION, revisions: store.listRevisions() }, null, 2));
    } else {
      console.log(`用法:
  kappa import --file=pairs.json [--out=report.json] [--client-request-id 见 JSON]
  kappa report [--revision=N] [--out=report.json]
  kappa mode --weight=unweighted|linear|quadratic [--revision=N] [--freeze] [--csv]
  kappa matrix-csv [--revision=N] [--out=matrix.csv]
  kappa summary-csv [--revision=N] [--out=summary.csv]
  kappa exclusions [--revision=N]
  kappa cell --label-a=X --label-b=Y [--page=1] [--page-size=100]
  kappa compare --base=N --target=M
  kappa compute-file --file=pairs.json
  kappa revisions`);
    }
  } finally {
    store[Symbol.dispose]();
  }
}

function requireValue(args: CliArgs, name: string): string {
  const value = args.values.get(name);
  if (value === undefined) throw new AppError('INVALID_REQUEST', `缺少参数 --${name}`);
  return value;
}

main().catch((error: unknown) => {
  if (error instanceof AppError) {
    console.error(`错误 [${error.code}]: ${error.message}`);
  } else {
    console.error((error as Error).message);
  }
  process.exitCode = 1;
});
