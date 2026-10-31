# 足球分析「数据验证」页面：新增方式、逻辑与依赖
实施日期：2026-10-31；修改基于既有 Site 源码 fd521b1d159f9d55478dbe7406105ab32212a328（v177），不是另建网站。

## 1. 页面怎样加入原站
- 新路由：`/data-validation`，在 `app/page.tsx` 共用主导航中增加「数据验证」入口；旧比赛、预测、推荐、复盘路由保持不变。
- `app/data-validation/page.tsx`：客户端交互、加载/错误/空状态、刷新、逐场展开、关注项筛选、历史评估与来源说明。
- `app/data-validation/validation.css`：以 dv- 命名隔离样式，延续原站浅蓝与青色视觉；桌面四列指标、手机两列，表格可横向滚动，键盘焦点可见。
- `app/data-validation/load-validation.js`：只读请求编排，不读取浏览器历史缓存，不提供假数据，不保存快照。
- `app/data-validation.js`：独立纯函数核验层，可直接用 Node 测试，不依赖页面展示。
- `tests/data-validation.test.mjs`、`tests/data-validation-loading.test.mjs`：检查规则及故障/中断路径。
- 没有新增服务端路由、数据库表、数据迁移、付费服务、密钥或持久权限；不改变 Site 受众。发布由原 Site 的正式工作流完成。

## 2. 一次验证的数据流
1. 并行请求已有 `GET /api/sporttery` 与 `GET /api/model-audit`，使用 no-store。
2. 官方赛事成功且非空时，将该次读取的赛事、官方 ID、销售日、开赛时间、主客队、五玩法赔率、资格与读取时间传给已有 `POST /api/predictions`。此 POST 是现有只读计算入口：读取外围盘口和校准参数，不写入历史、不调用 AI。不使用 research-only 的 GET 预测结果替代正式匹配，不继承设备上的人工映射。
3. 新页面最多传前 120 场（现有 POST 的上限），逐场检查仍展示官方返回的全部赛事，超出预测请求范围的比赛保持未覆盖，不伪称已验证。
4. 三种结果分别传入纯函数。来源失败为 null；成功的空列表与失败分开；官方空列表只有 HAD、HHAD、CRS、TTG、HAFU 五个准确命名的玩法全成功，才能断言 0 场。
5. 用户点击刷新才重新联网；每 30 秒只重算已有观测的年龄。刷新期间清除上轮显示，避免旧结果冒充新结果；按钮禁用防重复点击。离开页面 AbortController 取消，序列号阻止过期请求覆盖新页面。60 秒超时保留独立成功来源，不因一个接口挂起抹掉历史审计。
6. 外围接口的已有内存缓存默认有效 5 分钟；手动刷新传 forceRefresh=true。无旧缓存/演示概率回填，官方源失败则不发正式预测请求。

## 3. 具体规则与含义
- 身份：销售日 + 官方比赛 ID 唯一；主客队、球队 ID（如提供）、开赛时间一致，且外围报告声明 verified。重复、主客互换、跨日期同编号、研究/模拟记录不能计入有效覆盖。
- 时间：明确时区优先；仅已知官方本地时间按 +08:00 解释。来源读取超过 5 分钟提示需关注；超前当前时钟 1 分钟以上为失败；没有时间为未知。这个阈值是读取新鲜度，不是盘口变化时效保证。
- 预测顺序：来源读取不晚于生成，生成必须早于开赛；仅返回版本信息不证明已经保存不可变赛前快照。
- 官方五玩法：分别检查精确选项数、有效数值及失败/缺失。某玩法失败不能用其他玩法成功代替。
- 外围赔率：从现有 modelInput / companies 核对；与官方赔率分开。当前 normalizeCompany 明确把 upstreamUpdatedAt 设为 null，因此 fetchedAt 不得解释为报价更新时间。
- 证据：阵容、伤停、天气缺失显示未验证。证据即使具备 URL 与 48 小时时间窗，也只证明元数据完整，不证明新闻内容真实。页面没有启用搜索引擎、RSS、新闻全文抓取或 AI 复核。
- 权重：appliedIntelligenceWeight 不存在时显示未知，不擅自当作 0；本页不改变概率、校准参数或情报权重。当前完整预测管线为 multi-market-poisson-v6-exact-settlement。
- 概率：胜平负各项应处于 0–100，三项之和约为 100%。格式合格不等于预测准确。
- 历史：分别展示每个指标自身 eligible 分母；原审计模型与市场 Brier 不直接宣布谁更强，因为同场同刻可比样本和分母未逐条复核。严格决策行也不自动等于独立前向测试样本。

## 4. 实际数据依赖
### 本页直接读取
- 中国体育彩票竞彩网：已有 /api/sporttery，官方赛事和五玩法。展示来源 https://www.sporttery.cn/；既有服务可能使用其移动计算器回退，本页不新增抓取方式。
- 足彩网盘口：https://plzx.zgzcw.com/ ，现有服务的赔率接口 https://plzx.zgzcw.com/odds/oyzs_ajax.action；公司 ID 2、3、22。官方接口和外围接口的责任边界不混淆。
- /api/model-audit：打包文件 `data/analysis/prediction-history-audit.json` + 已发布校准读取。外层 generatedAt 是本次响应时刻；审计真实生成日期取 audit.generatedAt。

### 原站历史，而非本页新采集
本次基线源码检查确认：
- 历史审计生成于 2026-09-12T09:56:09.288Z；其库存 13 快照、55 场已结算独立比赛、33 条严格决策行、22 条回退行。胜平负首选 eligible=33；市场可比较样本=26；AI 可比较样本=0。这些不是截至今天的全部归档成绩。
- `data/generated-prediction-snapshot-index.json` 生成于 2026-10-30T02:02:56.659Z；包含 58 个展示快照，日期覆盖 2026-09-05 至 2026-10-29；45 server + 13 migrated-browser，114 组合票快照；657 条 resultCache 记录。缓存条目数不是独立已验证比赛数。它的 formalSnapshotCount=22 是另一个字段，不能把这些不同口径加总或互相替代。
- 展示快照与 evaluationSnapshots 分开；不能把 58 个展示快照称作 58 个严格未来测试样本。该索引 resultSync 在 Oct30 仍有待补结果 34、身份冲突 33。新页面不下载这份约 20 MiB 全量索引，只连接原复盘入口并使用小型审计。
- 团队历史索引 rows 为空；前向验证索引 captures / resultEvents 为空，虽然存在 fixtureUniverse。总进球报告 Oct6 的 comparableMatches=0，且 officialUniverseKnown=false。这不表示原站没有所有历史，仅表示相关独立验证链路没有足够证据。
- .openai/hosting.json 声明 DB 与 RESEARCH_OBJECTS；绑定声明不证明无人值守采集正在运行。本次没有修改存储配置，不依赖原 README 中“未绑定 R2”的过时描述。

上述库存是实施时检查的 v177 基线，不是网页实时计数。本页动态展示以本轮 API 返回为准；全文档不将旧审计重标为今日数据。

## 5. 建议 GitHub 工具与实际依赖分开
这些均未因本次新增页面而安装、启用或获得密钥。页面提供独立可点击候选列表。
- probberechts/soccerdata：Apache-2.0；采集适配，数据站条款另行核验。
- martineastwood/penaltyblog：MIT；统计/赔率研究，不替换现有模型。
- the-odds-api/samples-nodejs、samples-python：需要 API key，历史接口涉及付费；未确认独立代码 LICENSE。
- rbren/rss-parser：MIT；只解析订阅，需配置来源并审查转载权限。
- searxng/searxng：AGPL-3.0；需要自建/部署服务和检索源规则审查。
- mozilla/readability：Apache-2.0；正文提取，不授予新闻转载权。
- hudl/open-data：自定义数据条款，离线事件研究；ML-KULeuven/socceraction：MIT，离线动作价值研究，接入前核验版本和维护状态。
开源代码许可不是数据授权，不能据此绕过站点拒绝访问、验证码或付费限制。

## 6. 测试与真实限制
- 新增纯函数 14 项 + 加载流程 5 项，共 19 项通过：包含身份冲突、赔率/概率异常、过期/未来时间、证据缺失、真实空列表、官方失败、独立历史保留、超时与取消。
- Sites 官方 build-site helper 构建成功，路由列表包含 /data-validation。最终发布包装需再次对最终文件构建。
- 现有 `npm run test:quality` 回归 58 项全部通过。
- TypeScript 全仓检查存在 18 条既有类型错误（ImportMeta.glob、Cloudflare 运行时类型、manifest、原页面 results 分支、post-match-review 等）；新增 data-validation 文件复跑无错误。独立 QA 在原始 HEAD 与同一依赖上重跑得到完全相同的 18 条错误（输出差异为空）。不得写成全仓 typecheck 通过。
- 依赖安装首次因默认 npm 缓存目录不可写失败；使用 /tmp 可写缓存、同一个官方安装 helper 已成功，未改变依赖版本。
- 管理环境预览在 Cloudflare 插件 networkInterfaces 处出现 uv_interface_addresses 平台错误，浏览器布局/交互 QA 未完成；未通过改源码绕过环境限制。
- 2026-10-31 16:34 UTC，同站官方 API 实测 HTTP503 / OFFICIAL_ACCESS_BLOCKED，五玩法上游 HTTP567。页面设计为展示失败、保留历史，不是已恢复实时数据；刷新不能解除上游访问限制。
- 本页只能验证已返回字段的完整性、一致性和时序，不能证明新闻事实、官方授权、真实报价最后变动时间、独立模型增益或投资收益。
