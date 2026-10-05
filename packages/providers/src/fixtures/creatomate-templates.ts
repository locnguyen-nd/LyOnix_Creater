/**
 * VE2E-52 test fixtures: the structure of the two real pinned Creatomate templates (as returned by
 * the Creatomate MCP `get_template`, with the Voiceover `provider` still present as the raw template
 * stores it - the generator must remove it). Hand-written from the known structure, not fetched.
 */

const TTS_PROVIDER = "elevenlabs model_id=eleven_multilingual_v2 voice_id=fixture-voice";

/** Template 0c1e34f8 "News Recap - White Top Caption (JP)": root Badge + Scene-1..10 (Video 100%x44% centered, Subtitles top 6%, Voiceover dynamic). */
export function newsRecapJpTemplate(): Record<string, unknown> {
  const scenes = Array.from({ length: 10 }, (_, index) => {
    const n = index + 1;
    return {
      name: `Scene-${n}`,
      type: "composition",
      track: 1,
      duration: 8,
      fill_color: "#0b0b0b",
      elements: [
        { name: `Video-${n}`, type: "video", track: 1, x: "50%", y: "50%", width: "100%", height: "44%", fit: "cover", volume: "0%", color_overlay: "rgba(0,0,0,0.1)", dynamic: true, source: "https://example.test/placeholder.mp4" },
        {
          name: `Subtitles-${n}`,
          type: "text",
          track: 2,
          x: "50%",
          y: "6%",
          x_alignment: "50%",
          y_alignment: "0%",
          width: "88%",
          font_family: "Noto Sans JP",
          font_weight: "900",
          font_size: "6.2 vmin",
          fill_color: n % 2 === 1 ? "#ffffff" : "#ffe600",
          stroke_color: "#000000",
          stroke_width: "1.2 vmin",
          dynamic: true,
          text: "サンプル字幕",
          transcript_source: `Voiceover-${n}`,
          transcript_effect: "highlight",
        },
        { name: `Voiceover-${n}`, type: "audio", track: 3, dynamic: true, provider: TTS_PROVIDER, source: "サンプル音声テキスト" },
      ],
    };
  });
  return {
    output_format: "mp4",
    width: 1080,
    height: 1920,
    frame_rate: 30,
    fill_color: "#000000",
    duration: 80,
    elements: [
      { name: "Badge-BreakingNews", type: "text", track: 4, x: "8%", y: "3%", x_alignment: "0%", y_alignment: "0%", text: "BREAKING NEWS", font_family: "Noto Sans JP", font_weight: "900", fill_color: "#ffffff", background_color: "#d00000", duration: 80 },
      ...scenes,
    ],
  };
}

const RANK_LABELS = ["第5位", "第4位", "第3位", "第2位", "第1位"];
const TRANSITIONS = [undefined, "wipe", "circular-wipe", "flip", "slide"] as const;

/** Template 3e3e5947 "Top 5 Countdown": Scene-1..5 (Video, Shade, RankBadge 第5位..第1位, Subtitles, Voiceover) with distinct transitions + root Logo-Top5. */
export function top5CountdownTemplate(): Record<string, unknown> {
  const scenes = RANK_LABELS.map((label, index) => {
    const n = index + 1;
    const transition = TRANSITIONS[index];
    return {
      name: `Scene-${n}`,
      type: "composition",
      track: 1,
      duration: 6,
      ...(transition ? { animations: [{ type: transition, transition: true, duration: 0.6, easing: "quadratic-out" }] } : {}),
      elements: [
        { name: `Video-${n}`, type: "video", track: 1, width: "100%", height: "100%", fit: "cover", volume: "0%", dynamic: true, source: "https://example.test/placeholder.mp4" },
        { name: `Shade-${n}`, type: "shape", track: 2, path: "M 0 0 L 100 0 L 100 100 L 0 100 Z", width: "100%", height: "35%", y: "85%", fill_color: "rgba(0,0,0,0.55)" },
        { name: `RankBadge-${n}`, type: "text", track: 3, x: "10%", y: "8%", text: label, font_family: "Noto Sans JP", font_weight: "900", font_size: "12 vmin", fill_color: "#ffd400" },
        { name: `Subtitles-${n}`, type: "text", track: 4, x: "50%", y: "88%", width: "90%", font_family: "Noto Sans JP", font_weight: "800", font_size: "5.5 vmin", fill_color: "#ffffff", stroke_color: "#000000", stroke_width: "1 vmin", dynamic: true, text: "サンプル字幕" },
        { name: `Voiceover-${n}`, type: "audio", track: 5, dynamic: true, provider: TTS_PROVIDER, source: "サンプル音声テキスト" },
      ],
    };
  });
  return {
    output_format: "mp4",
    width: 1080,
    height: 1920,
    frame_rate: 30,
    fill_color: "#000000",
    elements: [...scenes, { name: "Logo-Top5", type: "text", track: 6, x: "88%", y: "4%", text: "TOP 5", font_family: "Noto Sans JP", font_weight: "900", fill_color: "#ffffff" }],
  };
}
