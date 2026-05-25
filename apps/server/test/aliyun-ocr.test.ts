import { afterEach, describe, expect, it, vi } from "vitest";
import { getConfig } from "../src/config.js";
import { recognizeAliyunImage } from "../src/services/aliyun-ocr.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Alibaba Cloud OCR", () => {
  it("signs and sends a binary RecognizeGeneral request", async () => {
    const request = vi.fn(async (_url: string, options: RequestInit) => {
      const headers = options.headers as Record<string, string>;
      expect(headers["x-acs-action"]).toBe("RecognizeGeneral");
      expect(headers["x-acs-version"]).toBe("2021-07-07");
      expect(headers.authorization).toContain("ACS3-HMAC-SHA256 Credential=test-id");
      expect(Buffer.from(options.body as ArrayBuffer)).toEqual(Buffer.from("png-image"));
      return new Response(JSON.stringify({ Data: JSON.stringify({ content: "阿里云识别文字" }) }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", request);
    const config = getConfig({
      provider: "fake",
      ocrProvider: "aliyun",
      aliyunAccessKeyId: "test-id",
      aliyunAccessKeySecret: "test-secret",
    });

    await expect(recognizeAliyunImage(Buffer.from("png-image"), config)).resolves.toBe("阿里云识别文字");
    expect(request).toHaveBeenCalledWith(
      "https://ocr-api.cn-hangzhou.aliyuncs.com/",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("requires RAM credentials before transmitting images", async () => {
    const config = getConfig({ provider: "fake", ocrProvider: "aliyun" });
    await expect(recognizeAliyunImage(Buffer.from("page"), config)).rejects.toThrow(/ALIBABA_CLOUD_ACCESS_KEY_ID/);
  });
});
