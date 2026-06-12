# 修复 Benchmark 等模块忽略数据库 API Key 配置

## 根因

`benchmark-runner.ts:275` 调用 `getConfig()` 创建全新 config 对象，只从 `process.env` 读取，完全忽略 `global_settings` 表中用户通过前端保存的 API Key。`index.ts` 中的 DB fallback 仅作用于主进程 config，benchmark 独立创建新 config 看不到。

## 改动点

### 1. `apps/server/src/services/benchmark-runner.ts`

#### 1a. `verifyConfiguredModel()` 错误信息修正（约 266 行）

```
旧: "Configured benchmark requested, but the model provider is not configured from .env."
新: "当前未配置模型，请在设置中填写 API Key 后再运行 benchmark。"
```

#### 1b. `runBenchmarkSuite()` 增加 DB fallback（约 275 行）

在 `const config = getConfig()` 之后插入 DB 加载逻辑：

```ts
const config = getConfig();
// ↓ 新增: 从 global_settings 表加载用户保存的配置
if (input.db) {
  if (!config.aiApiKey) {
    const dbApiKey = input.db.getGlobalSetting("deepseekApiKey");
    if (dbApiKey) config.aiApiKey = dbApiKey;
  }
  if (!config.aiBaseUrl || config.aiBaseUrl === "https://api.deepseek.com") {
    const dbBaseUrl = input.db.getGlobalSetting("aiBaseUrl");
    if (dbBaseUrl) config.aiBaseUrl = dbBaseUrl;
  }
  if (!config.chatModel) {
    const dbChatModel = input.db.getGlobalSetting("aiChatModel");
    if (dbChatModel) config.chatModel = dbChatModel;
  }
}
const model = input.provider === "fake" ? new EvalModelProvider() : createModelProvider(config);
```

### 2. `apps/server/src/services/models.ts`

三处错误信息去掉 `.env` / `DEEPSEEK_API_KEY` / `AI_API_KEY` 等硬编码字眼：

| 行号 | 旧信息 | 新信息 |
|------|--------|--------|
| ~2384 | `"未配置 DEEPSEEK_API_KEY"` / `"未配置 AI_API_KEY"` | `"未配置模型 API Key，请在设置中填写"` |
| ~3790 | `"未配置 DEEPSEEK_API_KEY"` / `"未配置 AI_API_KEY"` | `"未配置模型 API Key，请在设置中填写"` |
| ~3842 | `"请在 .env 中填写 DEEPSEEK_API_KEY…"` / `"请在 .env 中配置 API 密钥…"` | `"请在设置中填写 API Key；本地 embedding 已启用。"` / `"请在设置中配置 API 密钥以及聊天和 embedding 模型。"` |
