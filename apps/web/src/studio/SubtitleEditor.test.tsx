import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import i18n from "i18next";
import { describe, expect, it, vi } from "vitest";
import type { AudioVersionResponse, SubtitleVersionResponse } from "@lyonix/contracts";

vi.mock("./subtitle-api", () => ({ saveSubtitleVersion: vi.fn(), resetSubtitleVersion: vi.fn(), listSubtitleVersions: vi.fn() }));

const { SubtitleEditor } = await import("./SubtitleEditor");
const { locales } = await import("../i18n/locales");

const instance = i18n.createInstance();
await instance.init({ lng: "en", resources: { en: { translation: locales.en } }, interpolation: { escapeValue: false } });

const subtitle = (overrides: Partial<SubtitleVersionResponse> = {}): SubtitleVersionResponse => ({
  id: "sub-2",
  audioVersionId: "audio-1",
  version: 2,
  status: "current",
  source: "elevenlabs_alignment",
  segments: [{ text: "Messi is a football player.", startMs: 0, endMs: 1800 }, { text: "He plays for Inter Miami now.", startMs: 1800, endMs: 3600 }],
  staleReason: null,
  createdAt: "2026-10-05T00:00:00.000Z",
  ...overrides,
});

const audio = (overrides: Partial<AudioVersionResponse> = {}): AudioVersionResponse =>
  ({ id: "audio-1", status: "current", durationMs: 3600, mediaAssetVersionId: "voice-1", subtitleVersion: subtitle(), ...overrides }) as AudioVersionResponse;

const html = (props: Partial<Parameters<typeof SubtitleEditor>[0]> = {}) =>
  renderToStaticMarkup(
    <I18nextProvider i18n={instance}>
      <SubtitleEditor audio={audio()} pinnedSubtitleVersionId="sub-2" audioUrl="https://media.test/voice.mp3" onSaved={() => undefined} onUseLatest={() => undefined} {...props} />
    </I18nextProvider>,
  );

describe("SubtitleEditor (V03-03, first paint)", () => {
  it("lists every cue with its timing and the edit actions", () => {
    const out = html();
    expect(out).toContain('data-testid="subtitle-editor"');
    expect(out.match(/data-testid="subtitle-cue"/g)).toHaveLength(2);
    expect(out).toContain("1.80");
    expect(out).toContain("He plays for Inter Miami now.");
    expect(out).toContain("Automatic · v2");
    expect(out).toContain("Merge with next line");
    expect(out).toContain("Restore automatic");
    expect(out).not.toContain("older subtitle version");
  });

  it("labels an edited version and offers to re-bind when the timeline pins an older one", () => {
    const out = html({ audio: audio({ subtitleVersion: subtitle({ source: "manual_edit", version: 3, id: "sub-3" }) }), pinnedSubtitleVersionId: "sub-1" });
    expect(out).toContain("Edited · v3");
    expect(out).toContain("The timeline uses an older subtitle version.");
    expect(out).toContain("Use v3");
    expect(out).toContain("estimated per-word timing");
  });

  it("is read-only for an outdated voice and says why", () => {
    const out = html({ audio: audio({ status: "stale" }) });
    expect(out).toContain("This voice is outdated");
    expect(out).toMatch(/<textarea[^>]*disabled=""/);
  });

  it("says so when the voice has no subtitles", () => {
    expect(html({ audio: audio({ subtitleVersion: null }) })).toContain("This voice has no subtitles yet.");
  });
});
