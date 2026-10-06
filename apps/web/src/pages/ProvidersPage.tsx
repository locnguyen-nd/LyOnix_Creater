import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useConfirm, useToast } from "../components/feedback";
import { Banner, PageHeader, StatusPill } from "../components/chrome";
import { Modal } from "../components/Modal";
import { Button, Field, PasswordInput, Select, TextInput } from "../components/ui";
import { useMe } from "../session";
import { api, ApiError, csrfHeaders } from "../api";
import type { ApiProvider } from "../jobs-api";
import { isInternalRenderProvider } from "../studio/render-provider";
import { readyModelCount } from "./provider-model-summary";

type ProviderRole = "content" | "tts" | "visual" | "render";
type AddableKind = "openai" | "gemini" | "xai" | "openrouter" | "elevenlabs" | "pexels" | "youtube" | "pinterest" | "apify" | "creatomate" | "orshot";
type CatalogItem = { provider: string; role: string; implementationStatus: string; models: string[] };

/** Every provider kind the "Add account" form can create today, mapped to the role it fills in the video pipeline. Google is intentionally absent (evaluated, not implemented - VE2E-15b). YouTube and Pinterest (VE2E-15b) can both be added/verified here, but neither produces a candidate Auto can apply yet: YouTube is discovery/embed-only (see `packages/providers/src/youtube.ts`), and Pinterest has no reliable rights signal so every candidate is rights-unclear (see `packages/providers/src/pinterest.ts`) - both are manual-Studio-review sources only. */
const PROVIDER_ROLE: Record<AddableKind, ProviderRole> = {
  openai: "content",
  gemini: "content",
  xai: "content",
  openrouter: "content",
  elevenlabs: "tts",
  pexels: "visual",
  youtube: "visual",
  pinterest: "visual",
  apify: "visual",
  creatomate: "render",
  orshot: "render",
};
const ADDABLE_PROVIDERS = Object.keys(PROVIDER_ROLE) as AddableKind[];
const ROLE_ORDER: ProviderRole[] = ["content", "tts", "visual", "render"];
/** Visual/render providers have no generative "model" concept (no per-account model column use); a fixed placeholder keeps the required DB field non-empty without asking the user for one. */
const NO_MODEL_PLACEHOLDER = "n/a";

/** Brand-neutral monogram badge - no third-party logo assets are bundled, this keeps providers visually distinct without pulling trademarked images over the network. */
const PROVIDER_BADGE: Record<string, { label: string; bg: string; fg: string }> = {
  openai: { label: "AI", bg: "#10a37f", fg: "#fff" },
  gemini: { label: "Ge", bg: "#4285f4", fg: "#fff" },
  xai: { label: "X", bg: "#0f0f0f", fg: "#fff" },
  openrouter: { label: "OR", bg: "#6467f2", fg: "#fff" },
  elevenlabs: { label: "11", bg: "#6b4bff", fg: "#fff" },
  pexels: { label: "Px", bg: "#05a081", fg: "#fff" },
  youtube: { label: "Yt", bg: "#ff0000", fg: "#fff" },
  pinterest: { label: "Pi", bg: "#e60023", fg: "#fff" },
  apify: { label: "Ap", bg: "#2b5cff", fg: "#fff" },
  creatomate: { label: "Cm", bg: "#ff5a1f", fg: "#fff" },
  orshot: { label: "Os", bg: "#7c3aed", fg: "#fff" },
  vrew: { label: "Vr", bg: "#6b7280", fg: "#fff" },
};

function ProviderLogo({ provider }: { provider: string }) {
  const badge = PROVIDER_BADGE[provider] ?? { label: provider.slice(0, 2).toUpperCase(), bg: "#6b7280", fg: "#fff" };
  return (
    <span
      aria-hidden="true"
      className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold"
      style={{ backgroundColor: badge.bg, color: badge.fg }}
    >
      {badge.label}
    </span>
  );
}

export function ProvidersPage({ embedded = false }: { embedded?: boolean }) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const toast = useToast();
  const me = useMe();
  const [rows, setRows] = useState<ApiProvider[]>([]);
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [provider, setProvider] = useState<AddableKind>("openai");
  const [scope, setScope] = useState<"personal" | "organization">("personal");
  const [secret, setSecret] = useState("");
  const [embedId, setEmbedId] = useState("");
  const [editing, setEditing] = useState<ApiProvider | null>(null);
  const [editName, setEditName] = useState("");
  const [editModel, setEditModel] = useState("");
  const [editVisionModel, setEditVisionModel] = useState("");
  const [editPreferredModels, setEditPreferredModels] = useState("");
  const [replacementSecret, setReplacementSecret] = useState("");
  const [error, setError] = useState<string | null>(null);
  // V00-10: the static catalog is only a pre-connection suggestion for the "add account" form
  // (no account exists yet, so nothing has been verified). Once an account row exists,
  // `row.availableModels` is real account-scoped/generate-probed data - see `modelOptionsFor`.
  const modelsFor = (kind: string) => catalog.find((item) => item.provider === kind)?.models ?? [];
  /** V00-10: for an existing account, only show models the account itself proved usable/listed - never re-add the static catalog. */
  const modelOptionsFor = (row: ApiProvider) => (row.availableModels.length ? row.availableModels : [row.model]);
  const modelStatusLabel = (row: ApiProvider, modelId: string) => {
    const cooldown = row.modelCooldowns?.find((item) => item.modelId === modelId);
    if (cooldown) return `${t("providers.modelCooldown", { defaultValue: "Giới hạn đến" })} ${new Date(cooldown.cooldownUntil).toLocaleString()}`;
    const entry = row.modelSnapshot?.find((item) => item.modelId === modelId);
    if (!entry) return t("providers.modelUnverified");
    if (entry.status === "usable" && entry.fresh) return t("providers.modelUsable");
    if (entry.status === "usable") return t("providers.modelStale");
    return t(`providers.modelStatus.${entry.status}`, { defaultValue: entry.status });
  };
  const refresh = async () => { setRows(await api<ApiProvider[]>("/provider-accounts")); };
  const confirmVerificationCost = () => confirm({ title: t("providers.verify"), message: t("providers.verifyCostWarning"), tone: "warn", confirmLabel: t("providers.verify") });
  useEffect(() => {
    void refresh().catch((err) => setError(err instanceof ApiError ? err.message : t("common.error")));
    void api<CatalogItem[]>("/provider-catalog").then(setCatalog).catch(() => undefined);
  }, []);

  const save = async () => {
    if (!(await confirmVerificationCost())) return;
    try {
      setError(null);
      const role = PROVIDER_ROLE[provider];
      const model = provider === "orshot" ? embedId.trim() || NO_MODEL_PLACEHOLDER : modelsFor(provider)[0] ?? NO_MODEL_PLACEHOLDER;
      const created = await api<ApiProvider>("/provider-accounts", { method: "POST", headers: await csrfHeaders(), body: JSON.stringify({ name, provider, role, scope, model, secret }) });
      try {
        const verified = await api<ApiProvider>(`/provider-accounts/${created.id}/verify`, { method: "POST", headers: await csrfHeaders() });
        toast.success(`${t("providers.verifyOk")} · ${verified.availableModels.length} models`);
      } catch (err) { setError(err instanceof ApiError ? err.message : t("providers.verifyFail")); }
      await refresh();
      setSecret(""); setEmbedId(""); setOpen(false);
    } catch (err) { setError(err instanceof ApiError ? err.message : t("common.error")); }
  };

  const beginEdit = (row: ApiProvider) => {
    setEditing(row); setEditName(row.name); setEditModel(row.provider === "orshot" && row.model === NO_MODEL_PLACEHOLDER ? "" : row.model); setEditVisionModel(row.visionModel ?? ""); setEditPreferredModels((row.preferredModels ?? []).join(", ")); setReplacementSecret(""); setError(null);
  };

  const saveEdit = async () => {
    if (!editing) return;
    try {
      setError(null);
      await api<ApiProvider>(`/provider-accounts/${editing.id}`, {
        method: "PATCH",
        headers: { ...(await csrfHeaders()), "If-Match": `\"${editing.version}\"` },
        body: JSON.stringify({ name: editName, model: editing.provider === "orshot" ? editModel.trim() || NO_MODEL_PLACEHOLDER : editModel, ...(editing.role === "content" ? { visionModel: editVisionModel || null, preferredModels: editPreferredModels.split(",").map((item) => item.trim()).filter(Boolean) } : {}), ...(replacementSecret ? { secret: replacementSecret } : {}) }),
      });
      await refresh(); setEditing(null); setReplacementSecret(""); toast.success(t("providers.updated"));
    } catch (err) { setError(err instanceof ApiError ? err.message : t("common.error")); }
  };

  const remove = async (row: ApiProvider) => {
    if (!(await confirm({ title: t("providers.delete"), message: t("providers.deleteConfirm", { name: row.name }), confirmLabel: t("providers.delete") }))) return;
    try {
      setError(null);
      await api(`/provider-accounts/${row.id}`, {
        method: "DELETE",
        headers: { ...(await csrfHeaders()), "If-Match": `\"${row.version}\"` },
      });
      await refresh(); toast.success(t("providers.deleted"));
    } catch (err) { setError(err instanceof ApiError ? err.message : t("common.error")); }
  };

  const verifyRow = async (row: ApiProvider) => {
    if (!(await confirmVerificationCost())) return;
    try {
      setError(null);
      const verified = await api<ApiProvider>(`/provider-accounts/${row.id}/verify`, { method: "POST", headers: await csrfHeaders() });
      toast.success(`${t("providers.verifyOk")} · ${verified.availableModels.length} models`); await refresh();
    } catch (err) { setError(err instanceof ApiError ? err.message : t("providers.verifyFail")); await refresh(); }
  };

  const isSwitchable = (row: ApiProvider) => row.provider === "pexels" || row.provider === "apify";
  const toggleEnabled = async (row: ApiProvider, enabled: boolean) => {
    try {
      setError(null);
      const updated = await api<ApiProvider>(`/provider-accounts/${row.id}`, {
        method: "PATCH",
        headers: { ...(await csrfHeaders()), "If-Match": `"${row.version}"` },
        body: JSON.stringify({ enabled }),
      });
      setRows((current) => current.map((item) => (item.id === updated.id ? updated : item)));
    } catch (err) { setError(err instanceof ApiError ? err.message : t("common.error")); await refresh(); }
  };

  const rowsByRole = (role: ProviderRole) => rows.filter((row) => row.role === role);
  const hasModelChoice = (row: ApiProvider) => row.provider !== "pexels" && row.provider !== "youtube" && row.provider !== "pinterest" && row.provider !== "apify" && row.provider !== "creatomate" && row.provider !== "orshot";

  return (
    <>
      {embedded ? (
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-[16px] font-semibold">{t("providers.title")}</h2>
          <Button onClick={() => setOpen(true)}>{t("providers.add")}</Button>
        </div>
      ) : (
        <PageHeader title={t("providers.title")} actions={<Button onClick={() => setOpen(true)}>{t("providers.add")}</Button>} />
      )}
      {error ? <Banner variant="danger">{error}</Banner> : null}
      {ROLE_ORDER.map((role) => {
        const group = rowsByRole(role);
        if (!group.length) return null;
        return (
          <section key={role} className="mb-6">
            <h2 className="mb-2 text-[16px] font-semibold">{t(`providers.groups.${role}`)}</h2>
            <div className="grid gap-3 md:grid-cols-2">
              {group.map((row) => (
                <article key={row.id} className="border border-lyx-border p-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <ProviderLogo provider={row.provider} />
                      <h3 className="text-[16px] font-semibold">{row.name}</h3>
                    </div>
                    <div className="flex items-center gap-2">
                      {isSwitchable(row) && row.enabled === false ? <StatusPill tone="neutral">{t("providers.statusOff")}</StatusPill> : null}
                      <StatusPill tone={row.status === "verified" ? "ok" : row.status === "failed" ? "danger" : "neutral"}>{t(`providers.${row.status}`)}</StatusPill>
                    </div>
                  </div>
                  <p className="text-[12px] text-lyx-fg-muted">{row.provider} · {row.scope === "personal" ? t("providers.personal") : t("providers.organization")}</p>
                  {hasModelChoice(row) ? (
                    <div className="mt-3">
                      <Field label={t("providers.model")}>
                        <Select value={row.model} onChange={(e) => void (async () => {
                          try {
                            const updated = await api<ApiProvider>(`/provider-accounts/${row.id}`, {
                              method: "PATCH",
                              headers: { ...(await csrfHeaders()), "If-Match": `\"${row.version}\"` },
                              body: JSON.stringify({ model: e.target.value }),
                            });
                            setRows((current) => current.map((item) => item.id === updated.id ? updated : item));
                          } catch (err) { setError(err instanceof ApiError ? err.message : t("common.error")); }
                        })()}>
                          {modelOptionsFor(row).map((item) => <option key={item} value={item}>{item} · {modelStatusLabel(row, item)}</option>)}
                        </Select>
                      </Field>
                      {row.role === "content" ? <p className="mt-2 text-[12px] text-lyx-fg-muted">{t("providers.readyModelCount", { count: readyModelCount(row) })}</p> : null}
                    </div>
                  ) : null}
                  {isSwitchable(row) ? (
                    <label className="mt-3 flex items-center gap-2 text-[13px]">
                      <input type="checkbox" role="switch" data-testid={`provider-switch-${row.id}`} checked={row.enabled !== false} onChange={(e) => void toggleEnabled(row, e.target.checked)} />
                      <span>{row.enabled === false ? t("providers.sourceSwitchOff") : t("providers.sourceSwitchOn")}</span>
                    </label>
                  ) : null}
                  {isInternalRenderProvider(row.provider) ? (
                    <p className="mt-3 text-[12px] text-lyx-fg-muted" data-testid="system-account-note">{t("renderEngine.systemAccountNote")}</p>
                  ) : (
                    <div className="mt-3 flex flex-wrap gap-2">
                      <Button variant="secondary" onClick={() => void verifyRow(row)}>{t("providers.verify")}</Button>
                      <Button variant="secondary" onClick={() => beginEdit(row)}>{t("providers.edit")}</Button>
                      <Button variant="danger" onClick={() => void remove(row)}>{t("providers.delete")}</Button>
                    </div>
                  )}
                </article>
              ))}
            </div>
          </section>
        );
      })}
      {open ? (
        <Modal title={t("providers.add")} onClose={() => setOpen(false)}>
          <div className="flex flex-col gap-3">
            <Field label={t("channels.name")}><TextInput value={name} onChange={(e) => setName(e.target.value)} /></Field>
            <Field label={t("providers.kind")}>
              <Select value={provider} onChange={(e) => setProvider(e.target.value as AddableKind)}>
                {ROLE_ORDER.flatMap((role) => ADDABLE_PROVIDERS.filter((item) => PROVIDER_ROLE[item] === role)).map((item) => (
                  <option key={item} value={item}>{item} — {t(`providers.groups.${PROVIDER_ROLE[item]}`)}</option>
                ))}
              </Select>
            </Field>
            <p className="text-[12px] text-lyx-fg-muted">{t("providers.autoModelHint")}</p>
            {provider === "apify" ? <p className="text-[12px] text-lyx-fg-muted">{t("providers.apifyHint")}</p> : null}
{provider === "orshot" ? (
              <Field label={t("providers.orshotEmbedId")} hint={t("providers.orshotEmbedHint")}>
                <TextInput value={embedId} onChange={(e) => setEmbedId(e.target.value)} placeholder="abc123xyz" autoComplete="off" />
              </Field>
            ) : null}
            <Field label="scope">
              <Select value={scope} onChange={(e) => setScope(e.target.value as "personal" | "organization")}>
                <option value="personal">{t("providers.personal")}</option>
                {me.role === "admin" ? <option value="organization">{t("providers.organization")}</option> : null}
              </Select>
            </Field>
            <Field label={t("providers.secret")} hint={t("providers.secretHint")}><PasswordInput value={secret} onChange={(e) => setSecret(e.target.value)} /></Field>
            <Button onClick={() => void save()}>{t("common.save")}</Button>
          </div>
        </Modal>
      ) : null}
      {editing ? (
        <Modal title={t("providers.edit")} onClose={() => setEditing(null)}>
          <div className="flex flex-col gap-3">
            <Field label={t("channels.name")}><TextInput value={editName} onChange={(e) => setEditName(e.target.value)} /></Field>
{editing.provider === "orshot" ? (
              <Field label={t("providers.orshotEmbedId")} hint={t("providers.orshotEmbedHint")}>
                <TextInput value={editModel} onChange={(e) => setEditModel(e.target.value)} placeholder="abc123xyz" autoComplete="off" />
              </Field>
            ) : null}
            {hasModelChoice(editing) ? (
              <Field label={t("providers.model")}>
                <Select value={editModel} onChange={(e) => setEditModel(e.target.value)}>
                  {modelOptionsFor(editing).map((item) => <option key={item} value={item}>{item} · {modelStatusLabel(editing, item)}</option>)}
                </Select>
              </Field>
            ) : null}
            {editing.role === "content" ? <Field label={t("providers.visionModel", { defaultValue: "Model kiểm duyệt ảnh" })}>
              <Select value={editVisionModel} onChange={(e) => setEditVisionModel(e.target.value)}>
                <option value="">{t("providers.visionModelAuto", { defaultValue: "Tự chọn model tiết kiệm" })}</option>
                {modelOptionsFor(editing).map((item) => <option key={item} value={item}>{item} · {modelStatusLabel(editing, item)}</option>)}
              </Select>
            </Field> : null}
            {editing.role === "content" ? <Field label={t("providers.preferredModels", { defaultValue: "Model ưu tiên (theo thứ tự, cách nhau bằng dấu phẩy)" })}><TextInput value={editPreferredModels} onChange={(e) => setEditPreferredModels(e.target.value)} /></Field> : null}
            <Field label={t("providers.replaceSecret")} hint={t("providers.replaceSecretHint")}><PasswordInput value={replacementSecret} onChange={(e) => setReplacementSecret(e.target.value)} /></Field>
            <div className="flex gap-2"><Button variant="secondary" onClick={() => setEditing(null)}>{t("common.cancel")}</Button><Button onClick={() => void saveEdit()}>{t("common.save")}</Button></div>
          </div>
        </Modal>
      ) : null}
    </>
  );
}
