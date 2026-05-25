import { resolve } from "node:path";
import { config as loadEnv } from "dotenv";

const projectRoot = resolve(import.meta.dirname, "../../..");
loadEnv({ path: resolve(projectRoot, ".env") });

export interface AppConfig {
  host: string;
  port: number;
  dataDir: string;
  filesDir: string;
  analysisDir: string;
  ocrCacheDir: string;
  provider: "deepseek" | "openai" | "fake";
  aiBaseUrl: string;
  aiApiKey: string | undefined;
  chatModel: string | undefined;
  thinkingMode: "enabled" | "disabled";
  embeddingProvider: "api" | "local";
  embeddingBaseUrl: string;
  embeddingApiKey: string | undefined;
  embeddingModel: string | undefined;
  ocrProvider: "local" | "aliyun";
  aliyunOcrEndpoint: string;
  aliyunAccessKeyId: string | undefined;
  aliyunAccessKeySecret: string | undefined;
  aliyunSecurityToken: string | undefined;
}

export function getConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const dataDir = overrides.dataDir ?? resolve(projectRoot, process.env.DATA_DIR ?? "data");
  const provider = overrides.provider ??
    (process.env.AI_PROVIDER === "fake" ? "fake" : process.env.AI_PROVIDER === "openai" ? "openai" : "deepseek");
  const aiBaseUrl = overrides.aiBaseUrl ?? process.env.AI_BASE_URL ??
    (provider === "deepseek" ? "https://api.deepseek.com" : "https://api.openai.com/v1");
  const aiApiKey = overrides.aiApiKey ?? (process.env.AI_API_KEY || process.env.DEEPSEEK_API_KEY);
  const embeddingProvider = overrides.embeddingProvider ??
    (process.env.AI_EMBEDDING_PROVIDER === "api" ? "api" : provider === "deepseek" ? "local" : "api");

  return {
    host: overrides.host ?? process.env.HOST ?? "127.0.0.1",
    port: overrides.port ?? Number(process.env.PORT ?? 4310),
    dataDir,
    filesDir: overrides.filesDir ?? resolve(dataDir, "files"),
    analysisDir: overrides.analysisDir ?? resolve(dataDir, "analysis"),
    ocrCacheDir: overrides.ocrCacheDir ?? resolve(dataDir, "ocr-cache"),
    provider,
    aiBaseUrl,
    aiApiKey,
    chatModel: overrides.chatModel ?? process.env.AI_CHAT_MODEL ??
      (provider === "deepseek" ? "deepseek-v4-flash" : undefined),
    thinkingMode: overrides.thinkingMode ??
      (process.env.AI_THINKING_MODE === "enabled" ? "enabled" : "disabled"),
    embeddingProvider,
    embeddingBaseUrl: overrides.embeddingBaseUrl ?? process.env.AI_EMBEDDING_BASE_URL ?? aiBaseUrl,
    embeddingApiKey: overrides.embeddingApiKey ?? (process.env.AI_EMBEDDING_API_KEY || aiApiKey),
    embeddingModel: overrides.embeddingModel ?? process.env.AI_EMBEDDING_MODEL,
    ocrProvider: overrides.ocrProvider ?? (process.env.OCR_PROVIDER === "aliyun" ? "aliyun" : "local"),
    aliyunOcrEndpoint: overrides.aliyunOcrEndpoint ?? process.env.ALIYUN_OCR_ENDPOINT ?? "ocr-api.cn-hangzhou.aliyuncs.com",
    aliyunAccessKeyId: overrides.aliyunAccessKeyId ?? process.env.ALIBABA_CLOUD_ACCESS_KEY_ID,
    aliyunAccessKeySecret: overrides.aliyunAccessKeySecret ?? process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET,
    aliyunSecurityToken: overrides.aliyunSecurityToken ?? process.env.ALIBABA_CLOUD_SECURITY_TOKEN,
  };
}

export function hasConfiguredOcr(config: AppConfig): boolean {
  return config.ocrProvider === "local" ||
    Boolean(config.aliyunAccessKeyId && config.aliyunAccessKeySecret);
}

export function hasConfiguredModels(config: AppConfig): boolean {
  return config.provider === "fake" ||
    Boolean(
      config.aiApiKey &&
      config.chatModel &&
      (config.embeddingProvider === "local" || (config.embeddingApiKey && config.embeddingModel)),
    );
}
