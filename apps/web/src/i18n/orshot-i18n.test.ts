import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { locales } from "./locales";

const LOCALES = ["vi", "en", "ja", "ko"] as const;
const panelSource = readFileSync(new URL("../studio/OrshotStudioPanel.tsx", import.meta.url), "utf8");
const usedKeys = [...new Set([...panelSource.matchAll(/t\(\s*[`"']studioPro\.(orshot[A-Za-z_${}.]*)[`"']/g)].map((m) => m[1]!))];
const KINDS = ["video", "image", "text", "audio"];
const STATUSES = ["ok", "missing", "unused"];
const expandKey = (key: string) => (key.includes("${row.kind}") ? KINDS.map((k) => key.replace("${row.kind}", k)) : key.includes("${row.status}") ? STATUSES.map((k) => key.replace("${row.status}", k)) : [key]);
const keys = usedKeys.flatMap(expandKey);

describe("Orshot Studio panel i18n", () => {
  it("references at least the core keys (guards the regex above)", () => {
    expect(keys.length).toBeGreaterThan(30);
  });
  it("has every key used by OrshotStudioPanel in vi/en/ja/ko", () => {
    for (const locale of LOCALES) {
      const pro = locales[locale].studioPro as Record<string, string>;
      for (const key of keys) expect(pro[key], `${locale}.studioPro.${key}`).toBeTruthy();
    }
  });
  it("keeps interpolation placeholders consistent across locales", () => {
    for (const key of ["orshotCostOver", "orshotElapsed", "orshotActualCost"]) {
      const placeholders = LOCALES.map((l) => ((locales[l].studioPro as unknown as Record<string, string>)[key]!.match(/{{\w+}}/g) ?? []).sort().join());
      expect(new Set(placeholders).size, key).toBe(1);
    }
  });
  it("ja/ko are translated, not the English fallback", () => {
    const en = locales.en.studioPro as Record<string, string>;
    for (const locale of ["ja", "ko"] as const) {
      const pro = locales[locale].studioPro as Record<string, string>;
      for (const key of ["orshotTabRender", "orshotCostTitle", "orshotRender", "orshotCostNote"]) expect(pro[key]).not.toBe(en[key]);
    }
  });
  it("has the provider Embed ID labels in all locales", () => {
    for (const locale of LOCALES) {
      const providers = locales[locale].providers as unknown as Record<string, string>;
      expect(providers.orshotEmbedId, locale).toBeTruthy();
      expect(providers.orshotEmbedHint, locale).toBeTruthy();
    }
  });
});
