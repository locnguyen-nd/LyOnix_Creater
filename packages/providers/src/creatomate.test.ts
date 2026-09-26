import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderError } from "./index.js";
import {
  deriveTemplateModifications,
  getCreatomateRender,
  getCreatomateTemplate,
  listCreatomateTemplates,
  normalizeCreatomateStatus,
  probeCreatomateAccount,
  submitCreatomateRender,
} from "./creatomate.js";

afterEach(() => { vi.unstubAllGlobals(); });

describe("probeCreatomateAccount", () => {
  it("calls the cheap templates listing endpoint and returns verifiedAt", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify([]), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await probeCreatomateAccount("key");
    expect(result.verifiedAt).toBeTruthy();
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(call[0])).toContain("/templates?limit=1");
  });

  it("maps 401 to PROVIDER_AUTH_INVALID (no fallback)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ message: "Unauthorized" }), { status: 401 })));
    await expect(probeCreatomateAccount("bad")).rejects.toMatchObject({ code: "PROVIDER_AUTH_INVALID" } satisfies Partial<ProviderError>);
  });

  it("maps 429 to PROVIDER_RATE_LIMITED", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ message: "rate limited" }), { status: 429, headers: { "retry-after": "3" } })));
    await expect(probeCreatomateAccount("key")).rejects.toMatchObject({ code: "PROVIDER_RATE_LIMITED" } satisfies Partial<ProviderError>);
  });

  it("maps network failure to PROVIDER_TIMEOUT", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));
    await expect(probeCreatomateAccount("key")).rejects.toMatchObject({ code: "PROVIDER_TIMEOUT" } satisfies Partial<ProviderError>);
  });
});

describe("listCreatomateTemplates / getCreatomateTemplate", () => {
  it("lists templates", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([{ id: "tpl_1", name: "Bold caption", preview_image_url: "https://cdn.creatomate.com/tpl_1.jpg", tags: ["sport"] }]), { status: 200 })));
    const result = await listCreatomateTemplates("key");
    expect(result).toEqual([{ externalTemplateId: "tpl_1", name: "Bold caption", previewUrl: "https://cdn.creatomate.com/tpl_1.jpg", tags: ["sport"] }]);
  });

  it("fetches a single template detail with its source tree", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ id: "tpl_1", name: "Bold caption", source: { elements: [] } }), { status: 200 })));
    const result = await getCreatomateTemplate("key", "tpl_1");
    expect(result.externalTemplateId).toBe("tpl_1");
    expect(result.source).toEqual({ elements: [] });
  });

  it("maps 404 to PROVIDER_CAPABILITY_UNAVAILABLE", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ message: "not found" }), { status: 404 })));
    await expect(getCreatomateTemplate("key", "missing")).rejects.toMatchObject({ code: "PROVIDER_CAPABILITY_UNAVAILABLE" } satisfies Partial<ProviderError>);
  });
});

describe("deriveTemplateModifications", () => {
  it("derives text/video/image modification keys from a named element tree", () => {
    const source = {
      elements: [
        { name: "Video-1", type: "video" },
        { name: "Text-1", type: "text" },
        { name: "Image-1", type: "image" },
        { name: "Audio-1", type: "audio" },
        { name: "Unnamed", type: "shape" },
        { type: "text" }, // no name -> ignored
      ],
    };
    const slots = deriveTemplateModifications(source);
    const keys = slots.map((s) => s.key).sort();
    expect(keys).toEqual([
      "Audio-1.source",
      "Audio-1.volume",
      "Image-1.source",
      "Text-1.fill_color",
      "Text-1.font_family",
      "Text-1.text",
      "Video-1.source",
      "Video-1.volume",
    ]);
    expect(slots.find((s) => s.key === "Text-1.text")).toMatchObject({ kind: "text", required: true });
    expect(slots.find((s) => s.key === "Video-1.source")).toMatchObject({ kind: "video", required: true });
    expect(slots.find((s) => s.key === "Audio-1.source")).toMatchObject({ kind: "audio", required: false });
  });

  it("walks nested composition/track structures", () => {
    const source = { elements: [{ type: "composition", elements: [{ name: "Nested-Text", type: "text" }] }] };
    const slots = deriveTemplateModifications(source);
    expect(slots.map((s) => s.key)).toContain("Nested-Text.text");
  });

  it("returns an empty list for a template with no named/typed elements", () => {
    expect(deriveTemplateModifications({ elements: [] })).toEqual([]);
    expect(deriveTemplateModifications(null)).toEqual([]);
  });
});

describe("submitCreatomateRender / getCreatomateRender", () => {
  it("submits and returns the single render result from Creatomate's array response", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify([{ id: "rnd_1", status: "planned" }]), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await submitCreatomateRender("key", { templateId: "tpl_1", modifications: { "Text-1.text": "hello" }, webhookUrl: "https://lyonix.local/hooks/abc" });
    expect(result).toEqual({ externalJobId: "rnd_1", status: "planned", url: null, progress: null, errorMessage: null, renderDurationMs: null, snapshotUrl: null });
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(call[0])).toContain("/renders");
    expect(JSON.parse(String(call[1].body))).toMatchObject({ template_id: "tpl_1", webhook_url: "https://lyonix.local/hooks/abc" });
  });

  it("throws PROVIDER_SCHEMA_INVALID when Creatomate returns no render id", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([]), { status: 200 })));
    await expect(submitCreatomateRender("key", { templateId: "tpl_1", modifications: {}, webhookUrl: "https://x" })).rejects.toMatchObject({ code: "PROVIDER_SCHEMA_INVALID" });
  });

  it("maps a validation failure to PROVIDER_SCHEMA_INVALID", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ message: "Invalid modification key" }), { status: 400 })));
    await expect(submitCreatomateRender("key", { templateId: "tpl_1", modifications: {}, webhookUrl: "https://x" })).rejects.toMatchObject({ code: "PROVIDER_SCHEMA_INVALID" });
  });

  it("gets render status by id", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ id: "rnd_1", status: "succeeded", url: "https://cdn.creatomate.com/rnd_1.mp4", render_duration: 4.2, snapshot_url: "https://cdn.creatomate.com/rnd_1.jpg" }), { status: 200 })));
    const result = await getCreatomateRender("key", "rnd_1");
    expect(result).toEqual({ externalJobId: "rnd_1", status: "succeeded", url: "https://cdn.creatomate.com/rnd_1.mp4", progress: null, errorMessage: null, renderDurationMs: 4200, snapshotUrl: "https://cdn.creatomate.com/rnd_1.jpg" });
  });
});

describe("normalizeCreatomateStatus", () => {
  it("maps every known Creatomate status to the normalized lifecycle", () => {
    expect(normalizeCreatomateStatus("planned")).toBe("queued");
    expect(normalizeCreatomateStatus("waiting")).toBe("queued");
    expect(normalizeCreatomateStatus("transcribing")).toBe("rendering");
    expect(normalizeCreatomateStatus("rendering")).toBe("rendering");
    expect(normalizeCreatomateStatus("succeeded")).toBe("completed");
    expect(normalizeCreatomateStatus("failed")).toBe("failed");
  });
});
