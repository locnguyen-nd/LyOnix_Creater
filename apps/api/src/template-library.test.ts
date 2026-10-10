import { describe, expect, it, vi } from "vitest";
import { RELEASED_RECIPES, recipeCatalogEntry, resolveRecipeParams } from "@lyonix/render-recipes";
import { routeRender, DEFAULT_ROUTER_CONFIG } from "@lyonix/domain";
import { buildComposePlan } from "./compose-plan.js";
import { CreatomateTemplatesService } from "./creatomate-templates.service.js";
import { LYONIX_PROVIDER, RenderEngineStoreService, recipeExternalId } from "./render-engine-store.service.js";
import { checkTemplateRenderable, type ReadinessDeps } from "./template-readiness.js";
import type { SceneBindingForMapping } from "./timeline-render-mapping.js";

/**
 * The default template library (V04-01) end to end with local fixtures only - no provider, no render, no credit:
 * which of the 8 templates can be used, why the others cannot, and that a usable one produces a valid render request.
 */

const LYONIX_ACCOUNT = "lyonix-acct";
const ids = RELEASED_RECIPES.map((recipe) => recipeExternalId(recipe));
const WHITE_TOP = "recipe:news-recap-white-top-caption-jp@1";

/** Snapshot rows like the local dev database on 2026-10-10: only white-top-caption was switched on (100 %), no fallback anywhere. */
const devSnapshots = () =>
  RELEASED_RECIPES.map((recipe, index) => ({
    id: `snap-${index}`,
    providerAccountId: LYONIX_ACCOUNT,
    externalTemplateId: recipeExternalId(recipe),
    engine: LYONIX_PROVIDER,
    rolloutPercent: recipeExternalId(recipe) === WHITE_TOP ? 100 : 0,
    fallbackSnapshotIds: [] as string[],
    capturedAt: new Date("2026-10-06"),
  }));

const listService = (snapshots: ReturnType<typeof devSnapshots>) => {
  const prisma: any = {
    providerAccount: { findFirst: vi.fn(async ({ where }: any) => (where.id === LYONIX_ACCOUNT ? { provider: LYONIX_PROVIDER } : null)) },
    templateSnapshot: { findMany: vi.fn(async ({ where }: any) => snapshots.filter((row) => (!where.providerAccountId || row.providerAccountId === where.providerAccountId) && (!where.id?.in || where.id.in.includes(row.id)))) },
  };
  return new CreatomateTemplatesService(prisma, new RenderEngineStoreService(prisma));
};

const deps = (options: { engineConsumers?: number; usableAccounts?: string[]; rows?: Array<{ id: string; engine: string; providerAccountId: string }> } = {}): ReadinessDeps => ({
  prisma: { templateSnapshot: { findMany: vi.fn(async ({ where }: any) => (options.rows ?? []).filter((row) => where.id.in.includes(row.id))) } } as any,
  usableAccount: vi.fn(async (id: string) => ({ ok: (options.usableAccounts ?? []).includes(id) })),
  renderQueueStatus: vi.fn(async () => ({ consumers: options.engineConsumers ?? 1 })),
});

describe("template library: the 8 default templates and which ones can render", () => {
  it("lists exactly the 8 released recipes (2+ per group, all LyOnix Render); with the dev configuration only white-top-caption is ready", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const outcome = await listService(devSnapshots()).listTemplates(LYONIX_ACCOUNT);
    vi.unstubAllGlobals();
    if (!outcome.ok) throw new Error(outcome.message);
    expect(outcome.data.map((row) => row.externalTemplateId)).toEqual(ids);
    expect(ids).toHaveLength(8);
    const groups = RELEASED_RECIPES.map((recipe) => recipeCatalogEntry(recipe.id)?.category);
    for (const group of ["news", "sports", "faceless", "breaking_news"]) expect(groups.filter((value) => value === group).length).toBeGreaterThanOrEqual(2);
    const ready = outcome.data.filter((row) => row.internalRender?.ready).map((row) => row.externalTemplateId);
    expect(ready).toEqual([WHITE_TOP]);
    const urgent = outcome.data.find((row) => row.externalTemplateId === "recipe:breaking-news-urgent-headline-jp@1");
    expect(urgent).toMatchObject({ name: "Breaking news - urgent headline (JP)", internalRender: { ready: false, reason: "rollout_off", rolloutPercent: 0, hasFallback: false } });
    expect(fetchSpy).not.toHaveBeenCalled(); // listing internal templates never calls a provider
  });

  it.each(RELEASED_RECIPES.map((recipe) => [recipe.id, recipeExternalId(recipe)]))("%s: rollout 0 % / partial without fallback / wrong account are refused with the reason; 100 % renders on LyOnix", async (_id, externalId) => {
    const snapshot = { id: `snap-${externalId}`, engine: "lyonix", providerAccountId: LYONIX_ACCOUNT, rolloutPercent: 0, fallbackSnapshotIds: [] as string[] };
    expect(await checkTemplateRenderable(deps(), { snapshot, providerAccountId: LYONIX_ACCOUNT, checkEngine: true })).toMatchObject({ ok: false, reason: "rollout_off", message: expect.stringContaining("rollout 0 %") });
    expect(await checkTemplateRenderable(deps(), { snapshot: { ...snapshot, rolloutPercent: 40 }, providerAccountId: LYONIX_ACCOUNT, checkEngine: true })).toMatchObject({ ok: false, reason: "no_fallback" });
    expect(await checkTemplateRenderable(deps(), { snapshot: { ...snapshot, rolloutPercent: 100 }, providerAccountId: "creatomate-acct", checkEngine: true })).toMatchObject({ ok: false, reason: "incompatible_account" });
    expect(await checkTemplateRenderable(deps({ engineConsumers: 0 }), { snapshot: { ...snapshot, rolloutPercent: 100 }, providerAccountId: LYONIX_ACCOUNT, checkEngine: true })).toMatchObject({ ok: false, reason: "engine_unavailable" });
    expect(await checkTemplateRenderable(deps(), { snapshot: { ...snapshot, rolloutPercent: 100 }, providerAccountId: LYONIX_ACCOUNT, checkEngine: true })).toEqual({ ok: true, engine: "lyonix", hasFallback: false });
    // the Router agrees: 100 % -> the internal engine; engine down without fallback -> fails clearly, never a provider
    const template = { snapshotId: snapshot.id, engine: "lyonix" as const, providerOnly: false, rolloutPercent: 100, fallbackSnapshots: [] };
    const base = { jobKey: "job-1", forcedEngine: null, template, spend: { todayUsd: 0, monthUsd: 0 }, fallbackCostUsd: 0.5, afterError: null };
    expect(routeRender({ ...base, local: { healthy: true, estimatedWaitMs: 0 } }, DEFAULT_ROUTER_CONFIG)).toMatchObject({ kind: "route", engine: "lyonix", reason: "default" });
    expect(routeRender({ ...base, local: { healthy: false, estimatedWaitMs: 0 } }, DEFAULT_ROUTER_CONFIG)).toMatchObject({ kind: "fail", code: "NO_FALLBACK_TEMPLATE" });
  });

  it("a Creatomate template is never reported as LyOnix: a Creatomate snapshot is checked against its own account, not the rollout", async () => {
    const snapshot = { id: "cm-1", engine: "creatomate", providerAccountId: "cm-acct", rolloutPercent: 0, fallbackSnapshotIds: [] };
    expect(await checkTemplateRenderable(deps({ usableAccounts: ["cm-acct"] }), { snapshot, providerAccountId: "cm-acct", checkEngine: true })).toEqual({ ok: true, engine: "creatomate", hasFallback: false });
    expect(await checkTemplateRenderable(deps(), { snapshot, providerAccountId: "cm-acct", checkEngine: true })).toMatchObject({ ok: false, reason: "account_unusable" });
    expect(await checkTemplateRenderable(deps({ usableAccounts: ["cm-acct"] }), { snapshot, providerAccountId: LYONIX_ACCOUNT, checkEngine: true })).toMatchObject({ ok: false, reason: "incompatible_account" });
  });
});

describe("template library: a usable template produces a valid render request (asset mapping), for every recipe", () => {
  const scene = (index: number, overrides: Partial<SceneBindingForMapping> = {}): SceneBindingForMapping => ({
    sceneId: `scene_${index + 1}`,
    orderIndex: index,
    mediaAssetVersionId: `m${index + 1}`,
    audioVersionId: `a${index + 1}`,
    subtitleVersionId: null,
    screenTextOverride: null,
    annotation: null,
    excluded: false,
    mediaKind: index === 1 ? "video" : "image",
    ...(index === 1 ? { sourceStartMs: 1000, sourceDurationMs: 2500 } : {}),
    audioMediaAssetVersionId: `v${index + 1}`,
    audioDurationMs: 2400,
    audioNarration: "速報です。",
    ...overrides,
  });
  const assets = new Map<string, { relativePath: string; checksumSha256: string | null }>(
    [1, 2, 3].flatMap((n): Array<[string, { relativePath: string; checksumSha256: string | null }]> => [
      [`m${n}`, { relativePath: `projects/p/m${n}.${n === 2 ? "mp4" : "jpg"}`, checksumSha256: null }],
      [`v${n}`, { relativePath: `projects/p/v${n}.mp3`, checksumSha256: null }],
    ]),
  );
  const build = (recipe: (typeof RELEASED_RECIPES)[number], scenes: SceneBindingForMapping[], optionValues: Record<string, string> = {}) =>
    buildComposePlan({ scenes, assets, preparedMediaIds: new Set(), captions: new Map(), optionValues, recipe, templateSnapshotId: `snap-${recipe.id}` });

  it.each(RELEASED_RECIPES.map((recipe) => [recipe.id, recipe] as const))("%s: 3 scenes (image, video range, image) -> 1080x1920 60 fps plan on LyOnix, every scene mapped to its media + voice", (_id, recipe) => {
    const headline = recipe.slots.some((slot) => slot.key === "headline") ? { headline: "佐々木朗希、復帰登板" } : {};
    const built = build(recipe, [scene(0), scene(1), scene(2)], headline);
    if (!built.ok) throw new Error(built.message);
    expect(built.renderPlan.template).toMatchObject({ engine: "lyonix", recipeId: recipe.id, recipeVersion: recipe.version, templateSnapshotId: `snap-${recipe.id}` });
    expect(built.plan.canvas).toEqual({ width: 1080, height: 1920 });
    expect(built.plan.fps).toBe(60);
    expect(built.skippedSceneIds).toEqual([]);
    expect(built.plan.scenes.map((row) => [row.sceneId, row.media.relativePath, row.media.kind, row.voice.relativePath])).toEqual([
      ["scene_1", "projects/p/m1.jpg", "image", "projects/p/v1.mp3"],
      ["scene_2", "projects/p/m2.mp4", "video", "projects/p/v2.mp3"],
      ["scene_3", "projects/p/m3.jpg", "image", "projects/p/v3.mp3"],
    ]);
    expect(built.plan.scenes[1]!.media).toMatchObject({ sourceStartMs: 1000, sourceDurationMs: 2500 });
    // every slot resolves: the headline sent by Auto, the others from the recipe defaults (no slot is required)
    expect(recipe.slots.every((slot) => !slot.required)).toBe(true);
    expect(built.recipeParams).toEqual(resolveRecipeParams(recipe, { ...headline }));
  });

  it("a scene without media would be dropped silently by the engine - which is why Auto checks every scene before the render", () => {
    const built = build(RELEASED_RECIPES[0]!, [scene(0), scene(1, { mediaAssetVersionId: null, mediaKind: null }), scene(2)]);
    expect(built.ok && built.skippedSceneIds).toEqual(["scene_2"]);
  });
});
