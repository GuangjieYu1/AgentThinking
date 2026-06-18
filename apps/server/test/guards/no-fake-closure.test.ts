import { readFile } from "node:fs/promises";
import { glob } from "node:fs/promises";
import { describe, expect, it } from "vitest";

async function productionFiles(): Promise<string[]> {
  const files: string[] = [];
  for await (const file of glob("apps/server/src/**/*.ts")) files.push(file);
  for await (const file of glob("packages/**/*.ts")) files.push(file);
  return files;
}

describe("guard: no fake closure", () => {
  it("does not mark closure from non-empty records, rows, or items", async () => {
    const offenders: string[] = [];
    const fakeClosurePatterns = [
      /\b(?:records|rows|items)\.length\s*>\s*0[\s\S]{0,120}\b(?:closed\s*[:=]\s*true|closureStatus\s*[:=]\s*["']closed["'])/,
      /\b(?:closed\s*[:=]\s*true|closureStatus\s*[:=]\s*["']closed["'])[\s\S]{0,120}\b(?:records|rows|items)\.length\s*>\s*0/,
    ];

    for (const file of await productionFiles()) {
      const text = await readFile(file, "utf8");
      for (const pattern of fakeClosurePatterns) {
        if (pattern.test(text)) offenders.push(file);
      }
    }

    expect([...new Set(offenders)]).toEqual([]);
  });
});
