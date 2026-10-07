import type { CaptionPreset, CaptionPresetCategory } from "@lyonix/domain/caption-presets";

/**
 * Look of a caption preset card / preview stage by preset group: an accent (glow, selected ring) and a backdrop that stands for the
 * video behind the caption. Presentation only - the render never reads this.
 */
export type CaptionPresetTheme = { accent: string; scene: string };

export const CAPTION_PRESET_THEMES: Readonly<Record<CaptionPresetCategory | "template", CaptionPresetTheme>> = {
  template: { accent: "#a3a3a3", scene: "linear-gradient(160deg, #3a4a5c 0%, #1b2430 55%, #0e1218 100%)" },
  clean: { accent: "#38bdf8", scene: "linear-gradient(165deg, #1f6f8b 0%, #2b4c7e 45%, #13233f 100%)" },
  news: { accent: "#818cf8", scene: "linear-gradient(160deg, #1e3a8a 0%, #111c44 55%, #050816 100%)" },
  sports: { accent: "#f59e0b", scene: "linear-gradient(160deg, #15803d 0%, #14532d 45%, #0a1f12 100%)" },
  karaoke: { accent: "#e879f9", scene: "linear-gradient(160deg, #9333ea 0%, #4c1d95 45%, #1e1035 100%)" },
  breaking: { accent: "#f87171", scene: "linear-gradient(160deg, #991b1b 0%, #4a0b0b 55%, #170404 100%)" },
};

export const captionPresetTheme = (item: CaptionPreset | null): CaptionPresetTheme => CAPTION_PRESET_THEMES[item?.category ?? "template"];

/**
 * Sample captions shown in a preset's previews - Japanese, like the videos, whatever the UI language; each preset has its own lines in
 * its own tone (the stage cycles through them, a card shows the first). Fictional, presentation only.
 */
export const CAPTION_PRESET_SAMPLES: Readonly<Record<string, readonly string[]>> = {
  template: ["今日のニュースをお届けします", "気になる話題をチェック", "続きは動画のあとで"],
  "clean-white": ["朝の散歩で見つけた小さな発見", "シンプルに、わかりやすく", "毎日の暮らしをもっと楽しく"],
  "news-bold": ["新たな経済対策を発表", "都心で記録的な大雨", "来月から新制度がスタート"],
  "sports-punch": ["今季50号ホームラン！", "劇的な逆転ゴール！", "日本代表が決勝へ！"],
  "karaoke-highlight": ["夢を信じて走り続けよう", "君と見た空を忘れない", "明日へ向かって歌おう"],
  minimal: ["静かな夜、ひとりの時間", "今日もおつかれさま", "小さな一歩から始めよう"],
  "breaking-red": ["【速報】大型台風が接近中", "【速報】新幹線が一時運転見合わせ", "【速報】まもなく記者会見"],
};

export const captionPresetSamples = (item: CaptionPreset | null): readonly string[] => CAPTION_PRESET_SAMPLES[item?.id ?? "template"] ?? CAPTION_PRESET_SAMPLES.template!;
