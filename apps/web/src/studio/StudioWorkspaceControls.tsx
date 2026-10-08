import { Clapperboard, FileText, Mic, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen, SlidersHorizontal, SquarePen, type LucideIcon } from "lucide-react";
import type { KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { TabIndicator, useTabIndicator } from "../components/motion";

/**
 * Studio workspace controls: the two "edit" switches that show / hide the side panels, the rail a collapsed panel leaves
 * behind, and the Script / Voice / Media tool tabs. Colours come from the accent tokens (styles.css "Studio workspace").
 */
export type PanelSide = "left" | "right";
export type EditorTab = "script" | "voice" | "media";

export const PANEL_IDS: Record<PanelSide, string> = { left: "studio-editor-panel", right: "studio-inspector-panel" };

const PANEL_LOOK: Record<PanelSide, { icon: LucideIcon; accent: string; label: string; hint: string; show: string; hide: string }> = {
  left: { icon: SquarePen, accent: "lyx-accent-blue", label: "studioPro.editContentPanel", hint: "studioPro.editContentPanelHint", show: "studioPro.showMediaPanel", hide: "studioPro.hideMediaPanel" },
  right: { icon: SlidersHorizontal, accent: "lyx-accent-amber", label: "studioPro.editScenePanel", hint: "studioPro.editScenePanelHint", show: "studioPro.showInspectorPanel", hide: "studioPro.hideInspectorPanel" },
};

/** The "what clicking does" icon: a closing panel when it is open, an opening one when it is hidden. */
const stateIcon = (side: PanelSide, open: boolean): LucideIcon =>
  side === "left" ? (open ? PanelLeftClose : PanelLeftOpen) : open ? PanelRightClose : PanelRightOpen;

/** A labelled switch: what the panel is for (icon + name + contents) and, on the right, what a click does (Ẩn / Hiện). */
export function PanelToggleButton({ side, open, onToggle }: { side: PanelSide; open: boolean; onToggle: () => void }) {
  const { t } = useTranslation();
  const look = PANEL_LOOK[side];
  const Icon = look.icon;
  const StateIcon = stateIcon(side, open);
  return (
    <button
      type="button"
      className={`lyx-panel-toggle ${look.accent}`}
      aria-pressed={open}
      aria-controls={PANEL_IDS[side]}
      title={t(open ? look.hide : look.show)}
      onClick={onToggle}
      data-testid={`panel-toggle-${side}`}
    >
      <span className="lyx-panel-toggle-icon" aria-hidden="true"><Icon size={17} strokeWidth={2} /></span>
      <span className="flex min-w-0 flex-col items-start text-left leading-tight">
        <span className="truncate text-[12.5px] font-semibold">{t(look.label)}</span>
        <span className="truncate text-[10.5px] text-lyx-fg-muted">{t(look.hint)}</span>
      </span>
      <span key={open ? "open" : "closed"} className="lyx-panel-toggle-state" aria-hidden="true">
        <StateIcon size={14} strokeWidth={2} />
        {t(open ? "studioPro.panelHide" : "studioPro.panelShow")}
      </span>
    </button>
  );
}

/** What a collapsed panel leaves: a narrow column with the panel's icon and a vertical "open" label, so it is easy to find again. */
export function PanelRail({ side, onOpen }: { side: PanelSide; onOpen: () => void }) {
  const { t } = useTranslation();
  const look = PANEL_LOOK[side];
  const Icon = look.icon;
  const StateIcon = stateIcon(side, false);
  return (
    <button type="button" className={`lyx-panel-rail ${look.accent}`} title={t(look.show)} aria-label={t(look.show)} aria-controls={PANEL_IDS[side]} aria-expanded={false} onClick={onOpen}>
      <span className="lyx-panel-toggle-icon" aria-hidden="true"><Icon size={17} strokeWidth={2} /></span>
      <span className="lyx-panel-rail-label">{t(look.label)}</span>
      <StateIcon size={15} strokeWidth={2} aria-hidden="true" className="text-lyx-fg-muted" />
    </button>
  );
}

const EDITOR_TABS: { id: EditorTab; icon: LucideIcon; accent: string; label: string }[] = [
  { id: "script", icon: FileText, accent: "lyx-accent-blue", label: "studioPro.tabScript" },
  { id: "voice", icon: Mic, accent: "lyx-accent-violet", label: "studioPro.tabVoice" },
  { id: "media", icon: Clapperboard, accent: "lyx-accent-green", label: "studioPro.tabMedia" },
];

export const editorTabId = (tab: EditorTab) => `studio-tab-${tab}`;
export const editorPanelId = (tab: EditorTab) => `studio-tabpanel-${tab}`;

/** Script / Voice / Media: one big tool tab each (icon tile + name + a live count); the active one slides a tinted indicator under it. */
export function EditorTabs({ active, onChange, captions }: { active: EditorTab; onChange: (tab: EditorTab) => void; captions: Record<EditorTab, string> }) {
  const { t } = useTranslation();
  const { listRef, indicator } = useTabIndicator<HTMLDivElement>(active);
  const activeAccent = EDITOR_TABS.find((tab) => tab.id === active)?.accent ?? "";
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const index = EDITOR_TABS.findIndex((tab) => tab.id === active);
    const next = EDITOR_TABS[(index + (event.key === "ArrowRight" ? 1 : EDITOR_TABS.length - 1)) % EDITOR_TABS.length]!;
    onChange(next.id);
    listRef.current?.querySelector<HTMLButtonElement>(`#${editorTabId(next.id)}`)?.focus();
  };
  return (
    <div ref={listRef} role="tablist" aria-label={t("studioPro.editorTabsLabel")} onKeyDown={onKeyDown} className="relative grid grid-cols-3 gap-1.5 border-b border-lyx-border p-2">
      <TabIndicator {...indicator} className={`lyx-editor-tab-indicator ${activeAccent}`} />
      {EDITOR_TABS.map(({ id, icon: Icon, accent, label }) => {
        const selected = id === active;
        return (
          <button
            key={id}
            id={editorTabId(id)}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls={editorPanelId(id)}
            tabIndex={selected ? 0 : -1}
            data-active={selected ? "true" : undefined}
            onClick={() => onChange(id)}
            className={`lyx-editor-tab ${accent}`}
          >
            <span className="lyx-editor-tab-icon" aria-hidden="true"><Icon size={18} strokeWidth={2} /></span>
            <span className="text-[12.5px] font-semibold">{t(label)}</span>
            <span className="lyx-editor-tab-caption">{captions[id]}</span>
          </button>
        );
      })}
    </div>
  );
}
