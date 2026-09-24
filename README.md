# Football Focus

竞彩赛事、赛前预测、推荐组合及盘后复盘站点。需要 Node.js 22.13+。

## 本地运行

```bash
npm ci
npm run dev
npm test
```

本地默认地址为 `http://localhost:3000`。移动设备同一局域网访问可运行
`npm run dev:mobile`，再用 `npm run mobile:url` 查询地址。

## 数据权威来源

- **官方赛事与赔率**：来自竞彩网接口；每个玩法独立记录成功或失败。接口失败、赔率缺失、未开售时不能用演示赔率代替。
- **赛前原始快照**：`data/prediction-snapshots/` 中的只追加 JSON。已生成的快照不覆写；它们是盘后评估可审计的历史输入。
- **每日组合票快照**：`data/purchase-plan-snapshots/` 中的只追加 JSON。结算与订正另行关联，不能改写当时的推荐。
- **线上读取索引**：`data/generated-prediction-snapshot-index.json` 是从已跟踪的原始快照生成的紧凑副本，供 Site 读取；它不是新的权威来源。更新快照后运行 `npm run sync:decision-index`，并与原始快照一起提交、发布。
- **浏览器数据**：`app/browser-storage.ts` 的 IndexedDB 保存设备本地交互、缓存与旧记录迁移。它不是跨设备共享的正式复盘数据库。
- **D1/R2**：当前 Site 的绑定为空，`db/schema.ts` 只是预留入口；正式生产数据并未写入 D1/R2。迁移前不得把它们当成数据源。

定时采集及发布流程见 [release-and-scheduled-publishing.md](docs/release-and-scheduled-publishing.md)。

## 开发约束

```bash
npm run format
npm run format:check
npm run audit:data-footprint
npm run lint
```

Prettier 当前先约束三个高密度核心文件，后续可按模块逐步扩大覆盖，避免一次全库格式化掩盖逻辑变更。校准温度至少需要 30 场独立校准比赛，小样本时保持温度 1；未来测试成绩不得参与自身参数选择。

历史 JSON 仍需跟随 Git 与 Site 版本同步。现阶段直接 `gitignore` 或删除旧快照会导致线上复盘缺失；体积超过 100 MiB 或紧凑索引超过 8 MiB 时，应先设计 R2 原始文件迁移、索引分片及完整性校验，再切换权威来源。可用 `npm run audit:data-footprint` 监控，不会修改数据。
