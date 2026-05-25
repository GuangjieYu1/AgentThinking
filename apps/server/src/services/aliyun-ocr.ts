import { createHash, createHmac, randomBytes } from "node:crypto";
import type { AppConfig } from "../config.js";

const ACTION = "RecognizeGeneral";
const VERSION = "2021-07-07";
const ALGORITHM = "ACS3-HMAC-SHA256";

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex").toLowerCase();
}

function sign(headers: Record<string, string>, payload: Buffer, config: AppConfig): void {
  if (!config.aliyunAccessKeyId || !config.aliyunAccessKeySecret) {
    throw new Error("阿里云 OCR 未配置 ALIBABA_CLOUD_ACCESS_KEY_ID / ALIBABA_CLOUD_ACCESS_KEY_SECRET");
  }
  headers["x-acs-content-sha256"] = sha256(payload);
  if (config.aliyunSecurityToken) headers["x-acs-security-token"] = config.aliyunSecurityToken;
  const signedHeaders = Object.keys(headers)
    .filter((key) => key === "host" || key === "content-type" || key.startsWith("x-acs-"))
    .sort();
  const canonicalHeaders = signedHeaders.map((key) => `${key}:${headers[key]}`).join("\n") + "\n";
  const canonicalRequest = [
    "POST",
    "/",
    "",
    canonicalHeaders,
    signedHeaders.join(";"),
    headers["x-acs-content-sha256"],
  ].join("\n");
  const stringToSign = `${ALGORITHM}\n${sha256(canonicalRequest)}`;
  const signature = createHmac("sha256", config.aliyunAccessKeySecret)
    .update(stringToSign, "utf8")
    .digest("hex")
    .toLowerCase();
  headers.authorization = `${ALGORITHM} Credential=${config.aliyunAccessKeyId},SignedHeaders=${signedHeaders.join(";")},Signature=${signature}`;
}

export async function recognizeAliyunImage(image: Buffer, config: AppConfig): Promise<string> {
  const headers: Record<string, string> = {
    host: config.aliyunOcrEndpoint,
    "content-type": "application/octet-stream",
    "x-acs-action": ACTION,
    "x-acs-version": VERSION,
    "x-acs-date": new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    "x-acs-signature-nonce": randomBytes(16).toString("hex"),
  };
  sign(headers, image, config);
  const body = Uint8Array.from(image).buffer;
  const response = await fetch(`https://${config.aliyunOcrEndpoint}/`, {
    method: "POST",
    headers,
    body,
  });
  const payload = await response.json().catch(() => ({})) as {
    Code?: string;
    Message?: string;
    Data?: string | { Content?: string; content?: string };
  };
  if (!response.ok || payload.Code) {
    throw new Error(`阿里云 OCR 请求失败${payload.Code ? ` (${payload.Code})` : ""}: ${payload.Message ?? response.statusText}`);
  }
  const data = typeof payload.Data === "string"
    ? JSON.parse(payload.Data) as { content?: string; Content?: string }
    : payload.Data;
  const text = data?.content ?? data?.Content ?? "";
  if (!text.trim()) throw new Error("阿里云 OCR 未返回可识别文字");
  return text;
}
