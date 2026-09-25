/**
 * VE2E-07a scaffold only. Templates/media here are typed placeholders for the
 * Studio layout — not a provider registry entry, not fake/isFake data, not
 * evidence of done/production. Real content comes from VE2E-05 (Creatomate
 * templates) and VE2E-04 (Pexels/media library) once those are code_done;
 * this module is the seam that gets replaced by real API calls (TODO-wire).
 */

export type ModificationKind = "video" | "image" | "text" | "color" | "font" | "volume";

export type TemplateModification = {
  key: string; // exact Creatomate modification key, e.g. "Text-1.text"
  kind: ModificationKind;
  label: string;
};

export type RenderTemplate = {
  id: string;
  templateSnapshotId: string;
  name: string;
  aspect: "9:16" | "1:1";
  category: "sport" | "news" | "story" | "product";
  durationRangeSec: [number, number];
  modifications: TemplateModification[];
};

export const PLACEHOLDER_TEMPLATES: RenderTemplate[] = [
  {
    id: "tpl-bold-caption",
    templateSnapshotId: "snap_a91f",
    name: "Bold caption",
    aspect: "9:16",
    category: "sport",
    durationRangeSec: [15, 60],
    modifications: [
      { key: "Video-1.source", kind: "video", label: "Video-1.source" },
      { key: "Text-1.text", kind: "text", label: "Text-1.text" },
      { key: "Text-1.font_family", kind: "font", label: "Text-1.font_family" },
      { key: "Text-1.fill_color", kind: "color", label: "Text-1.fill_color" },
      { key: "Audio-1.volume", kind: "volume", label: "Audio-1.volume" },
    ],
  },
  {
    id: "tpl-highlight-zoom",
    templateSnapshotId: "snap_c220",
    name: "Highlight zoom",
    aspect: "9:16",
    category: "sport",
    durationRangeSec: [20, 45],
    modifications: [
      { key: "Video-1.source", kind: "video", label: "Video-1.source" },
      { key: "Image-1.source", kind: "image", label: "Image-1.source" },
      { key: "Text-1.text", kind: "text", label: "Text-1.text" },
      { key: "Text-1.fill_color", kind: "color", label: "Text-1.fill_color" },
    ],
  },
  {
    id: "tpl-story-minimal",
    templateSnapshotId: "snap_7e10",
    name: "Minimal storytelling",
    aspect: "9:16",
    category: "story",
    durationRangeSec: [30, 90],
    modifications: [
      { key: "Image-1.source", kind: "image", label: "Image-1.source" },
      { key: "Text-1.text", kind: "text", label: "Text-1.text" },
      { key: "Text-1.font_family", kind: "font", label: "Text-1.font_family" },
    ],
  },
  {
    id: "tpl-news-split",
    templateSnapshotId: "snap_5b3a",
    name: "News split-screen",
    aspect: "9:16",
    category: "news",
    durationRangeSec: [25, 60],
    modifications: [
      { key: "Video-1.source", kind: "video", label: "Video-1.source" },
      { key: "Video-2.source", kind: "video", label: "Video-2.source" },
      { key: "Text-1.text", kind: "text", label: "Text-1.text" },
      { key: "Text-2.text", kind: "text", label: "Text-2.text" },
      { key: "Text-1.fill_color", kind: "color", label: "Text-1.fill_color" },
      { key: "Audio-1.volume", kind: "volume", label: "Audio-1.volume" },
    ],
  },
];

export type MediaCandidate = {
  id: string;
  label: string;
  source: "pexels" | "upload" | "project";
};

export const PLACEHOLDER_MEDIA_POOL: MediaCandidate[] = [
  { id: "media-1", label: "Stadium — drone shot", source: "pexels" },
  { id: "media-2", label: "Close-up — rolling ball", source: "pexels" },
  { id: "media-3", label: "Crowd cheering", source: "pexels" },
  { id: "media-4", label: "Slow-motion long shot", source: "pexels" },
  { id: "media-5", label: "project-library-01", source: "project" },
  { id: "media-6", label: "project-library-02", source: "project" },
];
