import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderError } from "./index.js";
import { deriveOrshotModifications, getOrshotRender, getOrshotTemplate, listOrshotTemplates, probeOrshotAccount, submitOrshotRender } from "./orshot.js";

afterEach(() => { vi.unstubAllGlobals(); });

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const lastCall = (mock: ReturnType<typeof vi.fn>) => mock.mock.calls.at(-1) as unknown as [string, RequestInit];

describe("orshot adapter", () => {
  it("probes with the cheap template listing and bearer auth", async () => {
    const fetchMock = vi.fn(async () => json({ data: [], pagination: {} }));
    vi.stubGlobal("fetch", fetchMock);
    expect((await probeOrshotAccount("k")).verifiedAt).toBeTruthy();
    const [url, init] = lastCall(fetchMock);
    expect(url).toContain("/studio/templates/all?limit=1");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer k");
  });

  it("lists templates across pages", async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url.includes("page=1")
        ? json({ data: [{ id: 1, name: "A", thumbnail_url: "https://t/a.png" }], pagination: { totalPages: 2 } })
        : json({ data: [{ id: 2, name: "B" }], pagination: { totalPages: 2 } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const rows = await listOrshotTemplates("k");
    expect(rows.map((r) => r.externalTemplateId)).toEqual(["1", "2"]);
    expect(rows[0]!.previewUrl).toBe("https://t/a.png");
  });

  it("derives slots from template modifications and skips unknown types", async () => {
    const detail = {
      id: 7, name: "T", canvas_width: 1080, canvas_height: 1920,
      modifications: [
        { id: "title", type: "text" },
        { id: "bg", type: "videoUrl", element_name: "Background" },
        { id: "logo", type: "imageUrl" },
        { id: "voice", type: "audioUrl" },
        { id: "accent", type: "backgroundColor" },
        { id: "weird", type: "gradientStops" },
        { id: "title", type: "text" },
      ],
    };
    vi.stubGlobal("fetch", vi.fn(async () => json(detail)));
    const tpl = await getOrshotTemplate("k", "7");
    expect(tpl.source).toMatchObject({ width: 1080, height: 1920 });
    const slots = deriveOrshotModifications(tpl.source);
    expect(slots.map((s) => [s.key, s.kind, s.required])).toEqual([
      ["title", "text", true], ["bg", "video", true], ["logo", "image", true], ["voice", "audio", false], ["accent", "color", false],
    ]);
  });

  it("submits an async url render and maps the queued job", async () => {
    const fetchMock = vi.fn(async () => json({ id: 1204, status: "queued", finished: false }, 202));
    vi.stubGlobal("fetch", fetchMock);
    const out = await submitOrshotRender("k", { templateId: "12345", modifications: { title: "x" }, webhookUrl: "https://hook" });
    const [url, init] = lastCall(fetchMock);
    expect(url).toMatch(/\/studio\/render$/);
    expect(JSON.parse(String(init.body))).toEqual({ templateId: 12345, modifications: { title: "x" }, response: { mode: "async", type: "url", format: "mp4" }, webhook_url: "https://hook" });
    expect(out).toMatchObject({ externalJobId: "1204", status: "waiting", url: null });
  });

  it("forwards format, size preset and videoOptions (duration/fps) to Orshot", async () => {
    const fetchMock = vi.fn(async () => json({ id: 9, status: "queued" }, 202));
    vi.stubGlobal("fetch", fetchMock);
    await submitOrshotRender("k", { templateId: "5", modifications: {}, webhookUrl: "https://hook", outputFormat: "webm", size: "tiktok-video", videoOptions: { duration: 13, fps: 60 } });
    const body = JSON.parse(String(lastCall(fetchMock)[1].body));
    expect(body.response).toEqual({ mode: "async", type: "url", format: "webm", size: "tiktok-video" });
    expect(body.videoOptions).toEqual({ duration: 13, fps: 60 });
  });

  it("omits size and videoOptions when not provided or empty", async () => {
    const fetchMock = vi.fn(async () => json({ id: 9, status: "queued" }, 202));
    vi.stubGlobal("fetch", fetchMock);
    await submitOrshotRender("k", { templateId: "5", modifications: {}, webhookUrl: "https://hook", videoOptions: {} });
    const body = JSON.parse(String(lastCall(fetchMock)[1].body));
    expect(body.response).not.toHaveProperty("size");
    expect(body).not.toHaveProperty("videoOptions");
  });

  it("maps succeeded (string or object result) and failed jobs", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ id: 1, status: "succeeded", result: { data: "https://cdn/x.mp4", format: "mp4" }, started_at: "2026-01-01T00:00:00Z", completed_at: "2026-01-01T00:01:00Z" })));
    expect(await getOrshotRender("k", "1")).toMatchObject({ status: "succeeded", url: "https://cdn/x.mp4", renderDurationMs: 60_000 });
    vi.stubGlobal("fetch", vi.fn(async () => json({ id: 1, status: "succeeded", result: { data: { content: "https://cdn/y.mp4" } } })));
    expect((await getOrshotRender("k", "1")).url).toBe("https://cdn/y.mp4");
    vi.stubGlobal("fetch", vi.fn(async () => json({ id: 1, status: "failed", error: "too long", error_code: "video-duration-exceeds-plan" })));
    const failed = await getOrshotRender("k", "1");
    expect(failed.status).toBe("failed");
    expect(failed.errorMessage).toContain("video-duration-exceeds-plan");
  });

  it("normalizes HTTP errors into ProviderError codes", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: "bad key" }, 401)));
    await expect(probeOrshotAccount("k")).rejects.toMatchObject({ code: "PROVIDER_AUTH_INVALID" });
    vi.stubGlobal("fetch", vi.fn(async () => json({}, 429)));
    await expect(probeOrshotAccount("k")).rejects.toBeInstanceOf(ProviderError);
    vi.stubGlobal("fetch", vi.fn(async () => json({}, 402)));
    await expect(probeOrshotAccount("k")).rejects.toMatchObject({ code: "PROVIDER_QUOTA_EXHAUSTED" });
  });

  it("a 403 about the plan is not an invalid key", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: "Video generation is available on supported plans" }, 403)));
    await expect(probeOrshotAccount("k")).rejects.toMatchObject({ code: "PROVIDER_QUOTA_EXHAUSTED" });
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: "forbidden" }, 403)));
    await expect(probeOrshotAccount("k")).rejects.toMatchObject({ code: "PROVIDER_AUTH_INVALID" });
  });
});

describe("orshot includePages (script shorter than the template)", () => {
  it("sends response.includePages so only the used pages render, and omits it otherwise", async () => {
    const fetchMock = vi.fn(async () => json({ id: "r1", status: "pending" }, 202));
    vi.stubGlobal("fetch", fetchMock);
    await submitOrshotRender("k", { templateId: "5", modifications: {}, webhookUrl: "https://hook", includePages: [1, 2, 3, 4, 5, 6, 7, 8, 9] });
    expect(JSON.parse(lastCall(fetchMock)[1].body as string).response.includePages).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    await submitOrshotRender("k", { templateId: "5", modifications: {}, webhookUrl: "https://hook" });
    expect(JSON.parse(lastCall(fetchMock)[1].body as string).response).not.toHaveProperty("includePages");
  });
});
