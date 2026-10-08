# Cohen 加权一致性与偶然一致分母核验后端

本项目是仅包含后端 API 与 CLI 的 Windows 本地服务，用于比较两名评定者 A、B 对同一批样本的分类标注。它不把任何一方视为真值，不计算准确率、目标检测 AP，也不拟合潜在类别模型。

## 1. 统计口径

- 一次分析声明 2–20 个唯一类别，A、B 共用同一份有序身份表；类别字符串大小写敏感，不按名称排序。
- 每条样本包含唯一 `sampleId`、`labelA`、`labelB`；标签只能是声明类别或 `null`。
- 只有 A、B 都非空的成对记录进入计数矩阵和边际；缺 A、缺 B、两者都缺整对排除，并分别计数。
- 未知类别或重复样本 ID 会让导入整体失败；数据库事务回滚，不产生可统计的新版本。
- 计数矩阵 `C` 的行为 A、列为 B，有效对数为 `n`。计数用 BigInt，响应中的计数以字符串传输，并检查安全整数上限。

类别索引按声明顺序从 0 开始。三种模式的不一致权为：

- `unweighted`：对角 `d=0`，非对角 `d=1`。
- `linear`：`d_ij = |i-j|/(k-1)`。
- `quadratic`：`d_ij = (|i-j|/(k-1))^2`。

对同一有效样本集合：

```text
Do = Σ_i,j d_ij * C_ij / n
De = Σ_i,j d_ij * row_i * col_j / n²
kappa = 1 - Do / De
```

`De` 是在 A、B 独立、且各自边际固定的假设下得到的偶然不一致。本项目只使用不一致权，不混用一致权；普通对角命中率另作为 `rawAgreement` 报告，不替代扣除偶然因素的 kappa。`chanceAgreement = 1 - De`，对应偶然一致比例。

每格同时输出：

- `observedShare = d*C/n`，对 Do 的贡献；
- `expectedShare = d*row*col/n²`，对 De 的贡献。

权重及核心汇总在内部用分子/分母有理数表示；响应同时给出 `num`、`den` 和仅用于显示的 `decimal`。退化判定只看精确值，不看小数。

## 2. 退化和符号

- `n=0`：`kappa=null`，原因为 `no_valid_pairs`，表示无有效数据，不表示零一致性。
- `De=0` 且实际只用到一个类别：`kappa=null`，原因为 `single_used_category`。
- `De=0` 且边际完全对齐但不止一个使用类别：`kappa=null`，原因为 `perfect_marginal_alignment`。
- 负 kappa 是合法结果，不裁剪为 0。
- 很高或很低的数值只表示统计结果，不输出“合格/通过”等业务结论。
- 加权模式依赖声明顺序。完整反转类别顺序会保持所有成对距离，因此线性和二次 kappa 不变；随意交换中间类别可能改变结果。

手算夹具：

- `[[3,1],[1,3]]`：`n=8`，完全一致率 `0.75`，偶然一致率 `0.5`，普通 kappa `0.5`。
- `[[0,4],[4,0]]`：普通 kappa `-1`。

## 3. 环境与构建

要求 Node.js `>=22.5.0`（开发验证版本为 Node 25.5.0）。SQLite 使用 Node 内置的 `node:sqlite`，不需要 Docker、WSL、编译器、付费服务或外部在线 API。

```powershell
npm install
npm run build
npm test
```

启动：

```powershell
# 默认端口 0：由操作系统选择空闲端口，启动日志显示实际地址
npm start

# 或使用构建产物
npm run serve:dist

# 指定端口
$env:KAPPA_PORT='38211'; node dist/server.js
```

演示会创建两个修订版本、展示缺失计数、三种模式和修订比较：

```powershell
npm run demo
```

## 4. 配置

所有数据默认保存在项目内 `data/`。可用环境变量覆盖：

| 变量 | 默认值 | 含义 |
|---|---:|---|
| `KAPPA_PORT` | `0` | HTTP 端口，`0` 为自动空闲端口 |
| `KAPPA_DATA_DIR` | `data` | SQLite 和数据目录 |
| `KAPPA_MAX_SAMPLES` | `100000` | 单次导入样本数上限 |
| `KAPPA_MAX_EXPORT_ROWS` | `100000` | 导出/排除预览行数上限 |
| `KAPPA_PAGE_SIZE` | `100` | 单格来源查询每页最大条数 |

## 5. API

服务监听 `127.0.0.1`。请求和响应均为 UTF-8 JSON。

### 导入配对标注

`POST /revisions`

```json
{
  "clientRequestId": "batch-2026-001",
  "note": "可选说明",
  "categories": ["N", "Y"],
  "pairs": [
    { "sampleId": "s1", "labelA": "N", "labelB": "N" },
    { "sampleId": "s2", "labelA": null, "labelB": "Y" }
  ]
}
```

修订会保存原始记录、类别原序、权重版本和请求哈希。`clientRequestId` 相同且载荷相同为幂等重复，返回同一修订；相同键但不同载荷返回 `409 CONFLICT`。

### 查询

- `GET /health`：健康检查。
- `GET /revisions`：列出修订版本。
- `GET /latest/report` 或 `GET /{revisionId}/report`：完整计数表、边际、缺失计数和三种模式。
- `GET /latest/matrix?format=csv`：计数矩阵 CSV。
- `GET /latest/modes/unweighted|linear|quadratic`：单模式详情；加 `freeze=true` 可写入/读取冻结报告，加 `format=csv` 导出每格贡献。
- `GET /latest/exclusions?limit=1000`：预览被排除样本及缺失原因。
- `GET /latest/cells/{A类别}||{B类别}?page=1&pageSize=100`：查询某格来源样本；路径中的 `||` 需 URL 编码为 `%7C%7C`。
- `GET /latest/export?kind=summary|matrix`：汇总或矩阵 CSV。
- `GET /compare/{targetRevisionId}?base={baseRevisionId}`：比较两个修订版本的指标和变化样本。

分页只改变来源样本返回窗口，不改变参与统计的 `n`。

### 错误码

`INVALID_REQUEST`、`INVALID_CATEGORIES`、`UNKNOWN_CATEGORY`、`DUPLICATE_SAMPLE_ID`、`NOT_FOUND`、`CONFLICT`、`NO_VALID_DATA`、`KAPPA_UNDEFINED`、`LIMIT_EXCEEDED`、`IMPORT_FAILED`。响应结构：

```json
{ "error": { "code": "INVALID_CATEGORIES", "message": "...", "details": null } }
```

## 6. CLI

```powershell
npm run cli -- import --file=examples/pairs.json --out=data/report.json
npm run cli -- report
npm run cli -- mode --weight=linear
npm run cli -- mode --weight=quadratic --freeze --csv --out=data/contributions.csv
npm run cli -- matrix-csv --out=data/matrix.csv
npm run cli -- summary-csv --out=data/summary.csv
npm run cli -- exclusions
npm run cli -- cell --label-a=N --label-b=N --page=1 --page-size=100
npm run cli -- compare --base=1 --target=2
npm run cli -- revisions

# 不写 SQLite，仅从 JSON 直接核验计算
npm run cli -- compute-file --file=examples/pairs.json
```

使用构建产物时可运行 `node dist/cli.js ...`，并可通过 `npm link` 得到 `kappa-cli` 命令。

## 7. 复核建议

独立复核 `De` 时，不要只看对角命中：

1. 枚举 A、B 都非空的样本并建立矩阵，确认行总和与列总和都等于 `n`。
2. 对每个格计算 `row_i*col_j/n²`，乘以该模式的不一致权 `d_ij`。
3. 将全部格相加得到 `De`；用观测格频率加权求和得到 `Do`。
4. 先检查 `n` 和精确 `De` 是否为零，再计算 `1-Do/De`。

测试覆盖题设两类别夹具、-1、三类别相邻/跨级权重、全体同类、全部缺失、交换评定者、复制样本、行序变化、完整类别反转、单侧缺失、重启重建、幂等、分页与修订比较。
