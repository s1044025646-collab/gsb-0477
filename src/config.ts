import path from 'node:path';

export interface Config {
  dataDir: string;
  dbPath: string;
  port: number;
  maxSamples: number;
  maxExportRows: number;
  pageSize: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): Config {
  const dataDir = path.resolve(cwd, env.KAPPA_DATA_DIR ?? 'data');
  return {
    dataDir,
    dbPath: path.join(dataDir, 'kappa.sqlite'),
    port: env.KAPPA_PORT ? Number(env.KAPPA_PORT) : 0,
    maxSamples: Number(env.KAPPA_MAX_SAMPLES ?? 100000),
    maxExportRows: Number(env.KAPPA_MAX_EXPORT_ROWS ?? 100000),
    pageSize: Number(env.KAPPA_PAGE_SIZE ?? 100),
  };
}
