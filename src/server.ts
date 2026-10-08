import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { loadConfig } from './config.js';
import { Store } from './db.js';
import { AppError } from './errors.js';
import { contributionsCsv, matrixCsv, summaryCsv } from './export.js';
import { AnalysisService } from './service.js';
import type { WeightMode } from './types.js';

const config = loadConfig();
const store = new Store(config);
const service = new AnalysisService(store, config);

function send(response: http.ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body, null, 2));
}

function sendCsv(response: http.ServerResponse, filename: string, csv: string): void {
  response.writeHead(200, {
    'content-type': 'text/csv; charset=utf-8',
    'content-disposition': `attachment; filename="${filename}"`,
  });
  response.end(`\uFEFF${csv}`);
}

async function readJson(request: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 20 * 1024 * 1024) {
      throw new AppError('LIMIT_EXCEEDED', '请求体超过 20 MiB', 413);
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new AppError('INVALID_REQUEST', '请求体不是合法 JSON');
  }
}

function intParam(url: URL, name: string, fallback?: number): number | undefined {
  const value = url.searchParams.get(name);
  if (value === null) return fallback;
  if (!/^-?\d+$/.test(value)) {
    throw new AppError('INVALID_REQUEST', `参数 ${name} 必须为整数`);
  }
  return Number(value);
}

async function handler(
  request: http.IncomingMessage,
  response: http.ServerResponse,
): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://localhost');
  const method = request.method ?? 'GET';
  const segments = url.pathname.split('/').filter(Boolean);

  if (segments.length === 1 && segments[0] === 'health') {
    send(response, 200, { ok: true, weightVersion: 'cohen-kappa-v1' });
    return;
  }

  if (segments.length === 1 && segments[0] === 'revisions' && method === 'POST') {
    const body = (await readJson(request)) as Record<string, unknown>;
    const report = service.import({
      categories: body.categories as string[],
      pairs: body.pairs as never,
      note: typeof body.note === 'string' ? body.note : undefined,
      clientRequestId:
        typeof body.clientRequestId === 'string' ? body.clientRequestId : undefined,
    });
    send(response, report.reusedIdempotentRequest ? 200 : 201, report);
    return;
  }

  if (segments.length === 1 && segments[0] === 'revisions' && method === 'GET') {
    send(response, 200, { revisions: store.listRevisions() });
    return;
  }

  if (
    segments.length === 2 &&
    segments[1] === 'report' &&
    method === 'GET'
  ) {
    const id = segments[0] === 'latest' ? undefined : Number(segments[0]);
    send(response, 200, service.matrix(id));
    return;
  }

  if (segments.length === 2 && segments[1] === 'matrix' && method === 'GET') {
    const id = segments[0] === 'latest' ? undefined : Number(segments[0]);
    const report = service.matrix(id);
    if (url.searchParams.get('format') === 'csv') {
      sendCsv(response, `matrix-revision-${id ?? report.revision.revisionId}.csv`, matrixCsv(report.analysis));
    } else {
      send(response, 200, report);
    }
    return;
  }

  if (segments.length === 2 && segments[1] === 'exclusions' && method === 'GET') {
    const id = segments[0] === 'latest' ? undefined : Number(segments[0]);
    send(response, 200, service.exclusions(id, intParam(url, 'limit', 1000)));
    return;
  }

  if (segments.length === 3 && segments[1] === 'modes' && method === 'GET') {
    const id = segments[0] === 'latest' ? undefined : Number(segments[0]);
    const mode = segments[2] as WeightMode;
    const freeze = url.searchParams.get('freeze') === 'true';
    const payload = service.modeResult(id, mode, freeze);
    if (url.searchParams.get('format') === 'csv') {
      const result = payload.result as never;
      sendCsv(response, `${mode}-revision-${id ?? payload.revisionId}.csv`, contributionsCsv(result));
    } else {
      send(response, 200, payload);
    }
    return;
  }

  if (segments.length === 3 && segments[1] === 'cells' && method === 'GET') {
    const id = segments[0] === 'latest' ? undefined : Number(segments[0]);
    const coordinate = decodeURIComponent(segments[2]!);
    const [labelA, labelB] = coordinate.split('||', 2);
    if (!labelA || !labelB) {
      throw new AppError('INVALID_REQUEST', '格坐标路径必须为 A类别||B类别');
    }
    send(
      response,
      200,
      service.cellSources(
        id,
        labelA,
        labelB,
        intParam(url, 'page', 1)!,
        intParam(url, 'pageSize', config.pageSize)!,
      ),
    );
    return;
  }

  if (segments.length === 2 && segments[1] === 'export' && method === 'GET') {
    const id = segments[0] === 'latest' ? undefined : Number(segments[0]);
    const report = service.matrix(id);
    const kind = url.searchParams.get('kind') ?? 'summary';
    if (kind === 'matrix') sendCsv(response, 'matrix.csv', matrixCsv(report.analysis));
    else if (kind === 'summary') sendCsv(response, 'summary.csv', summaryCsv(report.analysis));
    else throw new AppError('INVALID_REQUEST', 'kind 仅支持 summary 或 matrix');
    return;
  }

  if (segments.length === 2 && segments[0] === 'compare' && method === 'GET') {
    const base = intParam(url, 'base');
    const target = intParam(url, 'target') ?? Number(segments[1]);
    send(response, 200, service.compare(base, target));
    return;
  }

  throw new AppError('NOT_FOUND', `路由不存在: ${method} ${url.pathname}`, 404);
}

const server = http.createServer((request, response) => {
  handler(request, response).catch((error: unknown) => {
    if (error instanceof AppError) {
      send(response, error.status, {
        error: { code: error.code, message: error.message, details: error.details ?? null },
      });
    } else {
      send(response, 500, {
        error: { code: 'INTERNAL', message: (error as Error).message },
      });
    }
  });
});

server.listen(config.port, '127.0.0.1', () => {
  const address = server.address() as AddressInfo;
  console.log(`Cohen kappa 后端已启动: http://127.0.0.1:${address.port}`);
  console.log(`数据目录: ${config.dataDir}`);
});
