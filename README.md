# Cohen 加权一致性与偶然一致分母核验后端

本服务实现**本地双评定者标注一致性分析**：输入同一批样本的两份分类标注（A、B），
建立交叉计数表，计算普通 / 线性加权 / 二次加权 Cohen kappa。
只做 API 与 CLI，TypeScript + Node.js + SQLite（`node:sqlite`，零原生依赖），
Windows 本地运行，不依赖 Docker、WSL 或任何外部在线服务。

**边界声明**：只比较两名评定者对同一对象的分类；不把任何一方当真值；
不计算分类器准确率或目标检测 AP；不拟合潜在类别模型。
核心原则：观测不一致（Do）与按各自边际得到的偶然不一致（De）使用**同一有效样本口径**。

## 快速开始

```powershell
npm install        # 安装开发依赖（typescript、@types/node）
npm run build      # 编译 TypeScript 到 dist/
npm test           # 构建并运行全部测试
npm start          # 启动 API（默认选择空闲端口；PORT=8080 可固定）
npm run demo       # 运行内置演示（二分类手算夹具 / 有序三类别 / 退化 / 缺失）
```

要求 Node.js ≥ 22.5（使用内置 `node:sqlite`）。数据保存在项目内 `data/` 目录
（可用 `KAPPA_DATA_DIR` 环境变量修改），重启后可从原始成对样本复核计数与贡献。

## 核心定义

- 类别：用户声明 2–20 个唯一类别的**有序**列表，A、B 共用；大小写敏感，不按名称重排，报告保存原序。
- 有效对：A、B 标签均非 null 的成对记录才参加计数；缺任何一方**整对排除**，
  并分别报告 `missingA` / `missingB` / `missingBoth`；缺一方的观测**不进入边际总数**。
- 计数矩阵 C：行 = A，列 = B，总和 n = 有效对数。权重模式不改变计数表及有效样本集合。
- 不一致权 d（i、j 为声明类别顺序下标）：
  - `unweighted`：对角 0，其余 1；
  - `linear`：`|i-j| / (k-1)`；
  - `quadratic`：`(|i-j| / (k-1))²`。
- 核心公式（同一 n）：
  - `Do = Σ d_ij · C_ij / n`（观测不一致）
  - `De = Σ d_ij · row_i · col_j / n²`（偶然不一致，按各自边际乘积）
  - `kappa = 1 - Do / De`
- 同时输出：原始完全相同标签比例、Do、De、A/B 各自边际、每格对 Do 与 De 的贡献。

## 偶然一致（De）是什么

即使两名评定者**各自独立**地按自己的边际分布随机打标签，也会有一定比例的"偶然一致"。
kappa 的分子扣除的正是这部分：`De` 是按 A、B 各自边际乘积得到的期望不一致，
与 `Do` 使用同一个有效样本集合（同一个 n），缺一方的记录对两者的影响完全一致。

## 缺失配对

`null` 表示该评定者未标注。只有双侧非空的记录进入计数矩阵与边际；
缺一方或双方都缺的记录被整对排除并分类计数（见 `preview` 接口）。
绝不让"只有 A 的观测"混入 A 的边际总数。

## 退化情况

- **n = 0**（全部缺失 / 无有效对）：返回 `status=no_valid_pairs`，kappa 为 null，不伪造零一致性。
- **De = 0**（有效样本边际集中于同一类别，如全体同为 x）：偶然不一致分母为零，
  kappa **未定义**，返回 `status=degenerate`、kappa=null 及原因码 `DE_ZERO`，**不强行定为 1**。
- 退化判定使用精确有理数（BigInt 分数）进行，显示用的小数不参与判定。
- **负 kappa 是合法结果**（如 `[[0,4],[4,0]]` 得 -1），不裁剪为零；
  很高或很低的系数也不自动映射为"合格 / 通过"等业务结论。

## 加权模式与类别顺序

加权模式假定类别有给定顺序：完整反转整个类别顺序，线性与二次距离不变，kappa 不变；
但随意交换中间类别可能改变结果，因此报告始终保存声明原序。
`/compare` 提供三种模式并排对照，每个指标都标注模式与口径——加权结果**不是**普通 kappa。

## API

默认端口 0（系统分配空闲端口），启动日志打印实际端口；`PORT` 环境变量可固定。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 健康检查 |
| POST | `/datasets` | 导入 `{name, categories, records:[{id,a,b}]}`，幂等；错误整体失败不留部分数据 |
| GET | `/datasets/:id` | 数据集概要 + 排除统计 |
| GET | `/datasets/:id/preview` | 预览排除原因清单 |
| GET | `/datasets/:id/matrix` | 计数矩阵（行 A 列 B） |
| GET | `/datasets/:id/kappa?mode=unweighted\|linear\|quadratic` | 按模式计算并冻结报告 |
| GET | `/datasets/:id/compare` | 三模式并排对照 |
| GET | `/datasets/:id/cell/:i/:j?page=&pageSize=` | 查询某格来源样本（分页，不改变 n） |
| POST | `/datasets/:id/revisions` | 导入修订 `{records}`，产生新版本；内容相同则幂等 |
| GET | `/datasets/:id/diff?from=&to=` | 比较两个版本的标注差异 |
| GET | `/datasets/:id/export?format=json\|csv&mode=` | 导出冻结报告 |

错误响应统一为 `{"error":{"code","message"}}`，错误码包括：
`INVALID_CATEGORIES`、`INVALID_RECORDS`、`DUPLICATE_SAMPLE_ID`、`UNKNOWN_CATEGORY`、
`TOO_MANY_SAMPLES`、`NAME_CONFLICT`、`DATASET_NOT_FOUND`、`INVALID_MODE`、`INVALID_CELL`、
`EXPORT_LIMIT`、`INVALID_JSON`、`NOT_FOUND`。

## CLI

```powershell
node dist/src/cli.js serve                        # 启动 API
node dist/src/cli.js import <name> <file.json>    # 导入（文件含 categories 与 records）
node dist/src/cli.js preview <datasetId>          # 排除原因预览
node dist/src/cli.js matrix <datasetId>           # 计数矩阵
node dist/src/cli.js kappa <datasetId> quadratic  # 按模式计算
node dist/src/cli.js compare <datasetId>          # 三模式对照
node dist/src/cli.js cell <id> 0 2 1 50           # 某格来源样本（页 1，每页 50）
node dist/src/cli.js revise <id> <file.json>      # 修订（新版本）
node dist/src/cli.js diff <id> 1 2                # 版本比较
node dist/src/cli.js export <id> linear csv       # 导出
node dist/src/cli.js demo                         # 演示
```

## 配置（环境变量）

- `PORT`：API 端口，默认 0（自动选择空闲端口）
- `KAPPA_DATA_DIR`：数据目录，默认项目内 `data/`
- `KAPPA_MAX_SAMPLES`：单次导入样本数上限，默认 100000
- `KAPPA_MAX_EXPORT`：导出有效对数上限，默认 10000

## 持久化与幂等

SQLite 保存：原始成对记录（含排除原因）、类别顺序、权重版本（`cohen-kappa/v1`）、
冻结报告。修订产生新版本记录，旧版本报告仍可复核。
同名同内容导入幂等返回已有数据集；同名不同内容返回 409 `NAME_CONFLICT`；
批量导入任何校验错误整体回滚，不留下部分正常统计。

## 测试

`npm test` 覆盖：手算夹具 `[[3,1],[1,3]]`（完全一致率 0.75、偶然一致率 0.5、kappa 0.5）
与 `[[0,4],[4,0]]`（kappa = -1）；有序三类别的相邻 vs 跨两级权重差别；全体同类（De=0）
与全部缺失（n=0）的未定义情形；交换评定者只转置计数且系数不变；复制全部样本保持系数；
完整反转类别顺序保持加权系数、交换中间类别改变结果；单侧缺失的排除与边际隔离；
独立从样本枚举配对并按边际乘积复核 De；导入幂等、修订版本、冻结报告、重启复核、分页不影响 n。

## 已知限制

- 使用 Node 内置 `node:sqlite`（Node 25 仍标记 experimental，但功能稳定；如需锁定可换 better-sqlite3）。
- 显示用小数为 IEEE 双精度；精确核对请使用导出中的整数计数自行以有理数复算（测试已演示方法）。
- 单进程服务，无认证，面向本机使用。
