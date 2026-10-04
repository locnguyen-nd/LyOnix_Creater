import { describe, expect, it } from "vitest";
import { renderEngines, renderRouteReasons } from "@lyonix/contracts";
import { locales } from "../i18n/locales";
import { canForceEngine, engineOfProvider, FORCE_ENGINE_CHOICES, forceEngineValue, summarizeRenderEngine } from "./render-engine";
import { isInternalRenderProvider, isTemplateOnlyRenderProvider, renderAccountOptionLabel, renderProviderLabel } from "./render-provider";
import { mergeTemplateEntries } from "./template-gallery";

describe("render engine helpers (VE2E-113)", () => {
  it("maps render accounts to engines and labels them, keeping Creatomate/Orshot behaviour", () => {
    expect(engineOfProvider("lyonix")).toBe("lyonix");
    expect(engineOfProvider("orshot")).toBe("orshot");
    expect(engineOfProvider("creatomate")).toBe("creatomate");
    expect(renderProviderLabel("lyonix")).toBe("LyOnix");
    expect(renderProviderLabel("orshot")).toBe("Orshot");
    expect(renderProviderLabel("creatomate")).toBe("Creatomate");
    expect(renderAccountOptionLabel({ name: "Main", provider: "orshot" })).toBe("Main · Orshot");
    expect(renderAccountOptionLabel({ name: "LyOnix (tự render)", provider: "lyonix" })).toBe("LyOnix (tự render)");
    expect(isInternalRenderProvider("lyonix")).toBe(true);
    expect(isInternalRenderProvider("creatomate")).toBe(false);
    expect(isTemplateOnlyRenderProvider("lyonix")).toBe(false); // the internal engine renders N scenes dynamically, not fixed slots
  });

  it("only admins may force an engine; 'auto' sends nothing", () => {
    expect(canForceEngine("admin")).toBe(true);
    expect(canForceEngine("staff")).toBe(false);
    expect(canForceEngine(undefined)).toBe(false);
    expect(forceEngineValue("auto")).toBeUndefined();
    expect(forceEngineValue("lyonix")).toBe("lyonix");
    expect([...FORCE_ENGINE_CHOICES]).toEqual(["auto", ...renderEngines]);
  });

  it("summarises a job's engine, reason, fallback link, internal progress and failed QC codes", () => {
    expect(summarizeRenderEngine({ status: "completed", progress: null })).toBeNull(); // pre-VE2E-108 job
    expect(summarizeRenderEngine({ engine: "lyonix", routeReason: "default", status: "rendering", progress: 41.6, fallbackOfJobId: null })).toEqual({
      engine: "lyonix", reason: "default", isFallback: false, fallbackOfJobId: null, internalProgress: 42, qcFailedCodes: [],
    });
    expect(summarizeRenderEngine({ engine: "lyonix", status: "completed", progress: 100 })!.internalProgress).toBeNull();
    expect(summarizeRenderEngine({ engine: "creatomate", routeReason: "fallback_after_error", fallbackOfJobId: "job-1", status: "rendering", progress: 50 })).toMatchObject({ isFallback: true, fallbackOfJobId: "job-1", internalProgress: null });
    expect(summarizeRenderEngine({ engine: "lyonix", status: "failed", progress: null, qcFailedCodes: ["QC_LOUDNESS"] })!.qcFailedCodes).toEqual(["QC_LOUDNESS"]);
    expect(summarizeRenderEngine({ engine: "lyonix", status: "verifying", progress: 250 })!.internalProgress).toBe(100);
  });
});

describe("unified template gallery (VE2E-113)", () => {
  const accounts = [
    { id: "a-cm", name: "Creatomate main", provider: "creatomate" },
    { id: "a-ly", name: "LyOnix (tự render)", provider: "lyonix" },
    { id: "a-os", name: "Orshot", provider: "orshot" },
  ];
  const tpl = (id: string, name: string) => ({ externalTemplateId: id, name, previewUrl: null, tags: [] });

  it("merges every account's templates into one list, internal first, each labelled with its engine and pinned against its own account", () => {
    const merged = mergeTemplateEntries(accounts, [[tpl("c2", "Zeta"), tpl("c1", "Alpha")], [tpl("recipe:x@1", "News telop")], [tpl("o1", "Orshot one")]]);
    expect(merged.map((e) => [e.engine, e.template.name])).toEqual([["lyonix", "News telop"], ["creatomate", "Alpha"], ["creatomate", "Zeta"], ["orshot", "Orshot one"]]);
    expect(merged[0]).toMatchObject({ accountId: "a-ly", key: "a-ly:recipe:x@1" });
    expect(merged.find((e) => e.template.externalTemplateId === "o1")!.accountId).toBe("a-os");
    expect(new Set(merged.map((e) => e.key)).size).toBe(merged.length);
  });
  it("tolerates an account whose list failed to load", () => {
    expect(mergeTemplateEntries(accounts, [[], [tpl("r", "R")]])).toHaveLength(1);
  });
});

describe("render engine translations (VE2E-113)", () => {
  it("every locale has every engine name, every Router reason of the contract, and the UI strings", () => {
    for (const locale of ["vi", "en", "ja", "ko"] as const) {
      const strings = locales[locale].renderEngine;
      for (const engine of renderEngines) expect(strings.name[engine], `${locale} name ${engine}`).toBeTruthy();
      for (const reason of renderRouteReasons) expect((strings.reason as Record<string, string>)[reason], `${locale} reason ${reason}`).toBeTruthy();
      expect(strings.engineLine).toContain("{{engine}}");
      expect(strings.reasonLine).toContain("{{reason}}");
      expect(strings.fallbackOf).toContain("{{id}}");
      expect(strings.qcFailed).toContain("{{codes}}");
      expect(strings.internalProgress).toContain("{{percent}}");
      for (const key of ["forceLabel", "forceAuto", "forceHint", "galleryEngineFilter", "galleryAllEngines", "systemAccountNote"] as const) expect(strings[key], `${locale} ${key}`).toBeTruthy();
    }
  });
});
