import * as http from "node:http";
import { Store, ApiError, MAX_EXPORT } from "./store";
import { analyze, WEIGHT_MODES, WeightMode } from "./kappa";

function parseMode(q: URLSearchParams): WeightMode {
  const m = q.get("mode") ?? "unweighted";
  if (!WEIGHT_MODES.includes(m as WeightMode))
    throw new ApiError("INVALID_MODE", `mode 必须是 ${WEIGHT_MODES.join("|")}`);
  return m as WeightMode;
}

export function computeAndFreeze(store: Store, datasetId: string, version: number, mode: WeightMode) {
  const ds = store.getDataset(datasetId);
  const counts = store.countMatrix(datasetId, version, ds.categories.length);
  const result = analyze(ds.categories, counts, mode);
  store.freezeReport(datasetId, version, mode, result);
  return result;
}

function toCsv(result: any): string {
  const lines: string[] = [];
  lines.push(`mode,${result.mode}`);
  lines.push(`n,${result.n}`);
  lines.push(`status,${result.status}`);
  lines.push(`kappa,${result.kappa ?? ""}`);
  lines.push(`rawAgreement,${result.rawAgreement ?? ""}`);
  lines.push(`observedDisagreement,${result.observedDisagreement ?? ""}`);
  lines.push(`expectedDisagreement,${result.expectedDisagreement ?? ""}`);
  lines.push("");
  lines.push(["" , ...result.categories].join(","));
  result.counts.forEach((row: string[], i: number) =>
    lines.push([result.categories[i], ...row].join(",")));
  return lines.join("\r\n");
}

export function createServer(store: Store): http.Server {
  return http.createServer(async (req, res) => {
    const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      const isStr = typeof body === "string";
      res.writeHead(status, { "content-type": isStr ? "text/csv; charset=utf-8" : "application/json; charset=utf-8", ...headers });
      res.end(isStr ? body : JSON.stringify(body, null, 2));
    };
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean);
      const readBody = async (): Promise<any> => {
        let raw = "";
        for await (const c of req!) raw += c;
        if (!raw) return {};
        try { return JSON.parse(raw); } catch { throw new ApiError("INVALID_JSON", "请求体不是合法 JSON"); }
      };

      if (req.method === "GET" && url.pathname === "/health")
        return send(200, { ok: true });

      if (req.method === "POST" && url.pathname === "/datasets") {
        const b = await readBody();
        return send(201, store.importDataset(b.name, b.categories, b.records));
      }

      if (parts[0] === "datasets" && parts[1]) {
        const id = parts[1];
        const version = url.searchParams.has("version")
          ? Number(url.searchParams.get("version"))
          : store.currentVersion(id);

        if (req.method === "GET" && parts.length === 2) {
          const ds = store.getDataset(id);
          return send(200, { ...ds, version, exclusions: store.exclusions(id, version) });
        }
        if (req.method === "GET" && parts[2] === "preview") {
          const ds = store.getDataset(id);
          const recs = store.getRecords(id, version);
          const excluded = recs.filter(r => r.exclude_reason !== "INCLUDED")
            .map(r => ({ id: r.sample_id, a: r.label_a, b: r.label_b, reason: r.exclude_reason }));
          return send(200, { categories: ds.categories, version, exclusions: store.exclusions(id, version), excluded });
        }
        if (req.method === "GET" && parts[2] === "matrix") {
          const ds = store.getDataset(id);
          const counts = store.countMatrix(id, version, ds.categories.length);
          const n = counts.flat().reduce((a, b) => a + b, 0n);
          return send(200, {
            categories: ds.categories, version, n: n.toString(),
            counts: counts.map(r => r.map(String)),
            note: "行=A，列=B；权重模式不改变本计数表及有效样本集合",
          });
        }
        if (req.method === "GET" && parts[2] === "kappa") {
          const mode = parseMode(url.searchParams);
          return send(200, computeAndFreeze(store, id, version, mode));
        }
        if (req.method === "GET" && parts[2] === "compare") {
          const out: any = { version, modes: {} };
          for (const m of WEIGHT_MODES) {
            const r = computeAndFreeze(store, id, version, m);
            out.modes[m] = {
              status: r.status, degenerateReason: r.degenerateReason,
              rawAgreement: r.rawAgreement, Do: r.observedDisagreement, De: r.expectedDisagreement,
              kappa: r.kappa,
              note: m === "unweighted" ? "普通 kappa（无权）" : `${m} 加权 kappa，勿称为普通 kappa`,
            };
          }
          return send(200, out);
        }
        if (req.method === "GET" && parts[2] === "cell" && parts[3] !== undefined && parts[4] !== undefined) {
          const ds = store.getDataset(id);
          const i = Number(parts[3]), j = Number(parts[4]);
          if (!Number.isInteger(i) || !Number.isInteger(j) || i < 0 || j < 0 || i >= ds.categories.length || j >= ds.categories.length)
            throw new ApiError("INVALID_CELL", "行列索引越界");
          const page = Number(url.searchParams.get("page") ?? 1);
          const pageSize = Number(url.searchParams.get("pageSize") ?? 100);
          const r = store.cellSamples(id, version, ds.categories[i], ds.categories[j], page, pageSize);
          return send(200, { ...r, categoryA: ds.categories[i], categoryB: ds.categories[j], note: "分页不改变参与统计的 n" });
        }
        if (req.method === "POST" && parts[2] === "revisions") {
          const b = await readBody();
          return send(201, store.revise(id, b.records));
        }
        if (req.method === "GET" && parts[2] === "diff") {
          const from = Number(url.searchParams.get("from") ?? version - 1);
          const to = Number(url.searchParams.get("to") ?? version);
          const a = new Map(store.getRecords(id, from).map(r => [r.sample_id, r]));
          const b = new Map(store.getRecords(id, to).map(r => [r.sample_id, r]));
          const changed: any[] = [];
          for (const [sid, rb] of b) {
            const ra = a.get(sid);
            if (!ra) changed.push({ id: sid, type: "added", to: { a: rb.label_a, b: rb.label_b } });
            else if (ra.label_a !== rb.label_a || ra.label_b !== rb.label_b)
              changed.push({ id: sid, type: "modified", from: { a: ra.label_a, b: ra.label_b }, to: { a: rb.label_a, b: rb.label_b } });
          }
          for (const [sid] of a) if (!b.has(sid)) changed.push({ id: sid, type: "removed" });
          return send(200, { from, to, changed });
        }
        if (req.method === "GET" && parts[2] === "export") {
          const format = url.searchParams.get("format") ?? "json";
          const mode = parseMode(url.searchParams);
          const result = computeAndFreeze(store, id, version, mode);
          const n = Number(result.n);
          if (n > MAX_EXPORT)
            throw new ApiError("EXPORT_LIMIT", `有效对数 ${n} 超过导出上限 ${MAX_EXPORT}`);
          if (format === "csv") return send(200, toCsv(result));
          if (format === "json") return send(200, result);
          throw new ApiError("INVALID_FORMAT", "format 必须是 json 或 csv");
        }
      }
      throw new ApiError("NOT_FOUND", `路由不存在: ${req.method} ${url.pathname}`, 404);
    } catch (e: any) {
      if (e instanceof ApiError)
        return send(e.status, { error: { code: e.code, message: e.message, details: e.details ?? null } });
      send(500, { error: { code: "INTERNAL", message: String(e?.message ?? e) } });
    }
  });
}

export function startServer(store: Store): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer(store);
    // 默认端口 0 = 由系统分配空闲端口；可用 PORT 环境变量固定
    const port = Number(process.env.PORT ?? 0);
    server.listen(port, () => {
      const addr = server.address() as any;
      console.log(`kappa-verifier API 已启动: http://127.0.0.1:${addr.port}`);
      resolve(addr.port);
    });
  });
}
