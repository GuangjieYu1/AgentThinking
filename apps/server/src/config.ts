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
  authRequired: boolean;
  registrationKeys: string[];
  sessionDays: number;
  secureCookies: boolean;
  indexProfile: "v1" | "v2" | "dual";
  enableContextUnits: boolean;
  enableV2PulsePack: boolean;
  enableContextUnitGraphExtraction: boolean;
  showDebugRetrieval: boolean;
  debugApiAllowUnauthLocal: boolean;
  debugMaxTextLength: number;
  runRealModelTests: boolean;
  modelContextStrategy: "long-context" | "retrieval-compact";
  modelMaxInputTokens: number;
  modelPreferredContextTokens: number;
  compactExcerptTokens: number;
  aoriModelContextTokens: number;
  aoriGlobalReadMaxInputTokens: number;
  aoriMinTruncatedContextTokens: number;
  aoriEvidenceBindingMinContextTokens: number;
  aoriAllowSmallContextOnlyForQuoteLookup: boolean;
  aoriAnswerMode: "traversal" | "legacy" | "strict_evidence_table";
  recordIndexingRationale: boolean;
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
    authRequired: overrides.authRequired ??
      (process.env.AUTH_REQUIRED === "true" || Boolean(process.env.REGISTRATION_KEYS?.trim())),
    registrationKeys: overrides.registrationKeys ??
      (process.env.REGISTRATION_KEYS ?? "").split(",").map((key) => key.trim()).filter(Boolean),
    sessionDays: overrides.sessionDays ?? Number(process.env.AUTH_SESSION_DAYS ?? 30),
    secureCookies: overrides.secureCookies ?? process.env.AUTH_COOKIE_SECURE === "true",
    indexProfile: overrides.indexProfile ??
      (process.env.INDEX_PROFILE === "v2" ? "v2" : process.env.INDEX_PROFILE === "dual" ? "dual" : "v1"),
    enableContextUnits: overrides.enableContextUnits ?? process.env.ENABLE_CONTEXT_UNITS === "true",
    enableV2PulsePack: overrides.enableV2PulsePack ?? process.env.ENABLE_V2_PULSE_PACK === "true",
    enableContextUnitGraphExtraction: overrides.enableContextUnitGraphExtraction ??
      process.env.ENABLE_CONTEXT_UNIT_GRAPH_EXTRACTION === "true",
    showDebugRetrieval: overrides.showDebugRetrieval ?? process.env.SHOW_DEBUG_RETRIEVAL === "true",
    debugApiAllowUnauthLocal: overrides.debugApiAllowUnauthLocal ??
      process.env.DEBUG_API_ALLOW_UNAUTH_LOCAL === "true",
    debugMaxTextLength: overrides.debugMaxTextLength ?? Number(process.env.DEBUG_MAX_TEXT_LENGTH ?? 4000),
    runRealModelTests: overrides.runRealModelTests ?? process.env.RUN_REAL_MODEL_TESTS === "true",
    modelContextStrategy: overrides.modelContextStrategy ??
      (process.env.MODEL_CONTEXT_STRATEGY === "long-context" ? "long-context" : "retrieval-compact"),
    modelMaxInputTokens: overrides.modelMaxInputTokens ?? Number(process.env.MODEL_MAX_INPUT_TOKENS ?? 8192),
    modelPreferredContextTokens: overrides.modelPreferredContextTokens ??
      Number(process.env.MODEL_PREFERRED_CONTEXT_TOKENS ?? 6000),
    compactExcerptTokens: overrides.compactExcerptTokens ?? Number(process.env.COMPACT_EXCERPT_TOKENS ?? 12000),
    aoriModelContextTokens: overrides.aoriModelContextTokens ??
      Number(process.env.AORI_MODEL_CONTEXT_TOKENS ?? 1_000_000),
    aoriGlobalReadMaxInputTokens: overrides.aoriGlobalReadMaxInputTokens ??
      Number(process.env.AORI_GLOBAL_READ_MAX_INPUT_TOKENS ?? 800_000),
    aoriMinTruncatedContextTokens: overrides.aoriMinTruncatedContextTokens ??
      Number(process.env.AORI_MIN_TRUNCATED_CONTEXT_TOKENS ?? 10_000),
    aoriEvidenceBindingMinContextTokens: overrides.aoriEvidenceBindingMinContextTokens ??
      Number(process.env.AORI_EVIDENCE_BINDING_MIN_CONTEXT_TOKENS ?? 10_000),
    aoriAllowSmallContextOnlyForQuoteLookup: overrides.aoriAllowSmallContextOnlyForQuoteLookup ??
      process.env.AORI_ALLOW_SMALL_CONTEXT_ONLY_FOR_QUOTE_LOOKUP !== "false",
    aoriAnswerMode: overrides.aoriAnswerMode ??
      (process.env.AORI_ANSWER_MODE === "legacy"
        ? "legacy"
        : process.env.AORI_ANSWER_MODE === "strict_evidence_table"
          ? "strict_evidence_table"
          : "traversal"),
    recordIndexingRationale: overrides.recordIndexingRationale ??
      (process.env.RECORD_INDEXING_RATIONALE === "true" || process.env.AORI_RECORD_INDEXING_RATIONALE === "true"),
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
