import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { VoiceCloneResultResponse } from "@lyonix/contracts";
import { FileAudio, Upload, X } from "lucide-react";
import { ApiError } from "../api";
import { Modal } from "../components/Modal";
import { Button } from "../components/ui";
import { createVoiceClone } from "../studio/timeline-api";
import { VOICE_CLONE_LIMITS, buildConsent, checkSamples, formatBytes, toSampleInputs } from "./voice-clone";

/**
 * "Clone giọng": the user picks 1-5 audio samples, names the voice, confirms they have the right to clone it, and sends. The new
 * voice is created on the form's voice account (so it lands in the same list) and handed back through `onCloned`.
 */
export function VoiceCloneDialog({ accountId, onClose, onCloned }: {
  accountId: string;
  onClose: () => void;
  onCloned: (result: VoiceCloneResultResponse) => void;
}) {
  const { t, i18n } = useTranslation();
  const [name, setName] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const problem = checkSamples(files);
  const problemText = problem ? t(`voiceClone.problem.${problem}`, { max: VOICE_CLONE_LIMITS.maxFiles, file: VOICE_CLONE_LIMITS.maxFileBytes / 1024 / 1024, total: VOICE_CLONE_LIMITS.maxTotalBytes / 1024 / 1024 }) : null;
  const ready = name.trim().length > 0 && files.length > 0 && !problem && agreed && !busy;

  const addFiles = (picked: FileList | null) => {
    if (!picked?.length) return;
    setError(null);
    setFiles((current) => {
      const known = new Set(current.map((file) => `${file.name}|${file.size}`));
      return [...current, ...[...picked].filter((file) => !known.has(`${file.name}|${file.size}`))];
    });
    if (inputRef.current) inputRef.current.value = "";
  };

  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      const result = await createVoiceClone(accountId, {
        name: name.trim(),
        consent: buildConsent(t("voiceClone.consentText")),
        files: await toSampleInputs(files),
      });
      onCloned(result);
    } catch (caught) {
      const code = caught instanceof ApiError ? caught.code : "";
      setError(code && i18n.exists(`voiceClone.error.${code}`) ? t(`voiceClone.error.${code}`) : caught instanceof ApiError ? caught.message : t("voiceClone.error.generic"));
      setBusy(false);
    }
  };

  return (
    <Modal title={t("voiceClone.title")} onClose={busy ? () => undefined : onClose} width={640}>
      <div className="flex flex-col gap-3" data-testid="voice-clone-dialog">
        <p className="text-[12.5px] leading-5 text-lyx-fg-muted">{t("voiceClone.intro")}</p>

        <label className="flex flex-col gap-1">
          <span className="text-[13px] font-medium">{t("voiceClone.nameLabel")}</span>
          <input
            type="text"
            value={name}
            maxLength={VOICE_CLONE_LIMITS.maxNameLength}
            onChange={(event) => setName(event.target.value)}
            placeholder={t("voiceClone.namePlaceholder")}
            disabled={busy}
            className="h-9 rounded-[var(--lyx-radius)] border border-lyx-border bg-lyx-muted px-3 text-[13px] placeholder:text-lyx-fg-subtle"
            data-testid="voice-clone-name"
          />
        </label>

        <div className="flex flex-col gap-1.5">
          <span className="text-[13px] font-medium">{t("voiceClone.samplesLabel")}</span>
          <input ref={inputRef} type="file" accept="audio/*,.mp3,.wav,.m4a,.aac,.ogg,.opus,.flac,.webm" multiple className="sr-only" tabIndex={-1} onChange={(event) => addFiles(event.target.files)} data-testid="voice-clone-file-input" />
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            disabled={busy}
            className="flex min-h-[72px] items-center justify-center gap-2 rounded-lg border border-dashed border-lyx-border px-3 text-[12.5px] text-lyx-fg-muted hover:border-lyx-strong hover:text-lyx-fg disabled:opacity-60"
            data-testid="voice-clone-pick"
          >
            <Upload size={16} aria-hidden />
            {t("voiceClone.pick")}
          </button>
          <p className="text-[11.5px] leading-4 text-lyx-fg-muted">{t("voiceClone.samplesHint", { max: VOICE_CLONE_LIMITS.maxFiles, file: VOICE_CLONE_LIMITS.maxFileBytes / 1024 / 1024 })}</p>
          {files.length ? (
            <ul className="grid gap-1" data-testid="voice-clone-files">
              {files.map((file) => (
                <li key={`${file.name}|${file.size}`} className="flex items-center gap-2 rounded border border-lyx-border bg-lyx-bg px-2 py-1.5 text-[12.5px]">
                  <FileAudio size={14} className="shrink-0 text-lyx-fg-muted" aria-hidden />
                  <span className="min-w-0 flex-1 truncate" title={file.name}>{file.name}</span>
                  <span className="shrink-0 text-lyx-fg-muted">{formatBytes(file.size)}</span>
                  <button type="button" disabled={busy} onClick={() => setFiles((current) => current.filter((item) => item !== file))} aria-label={t("voiceClone.remove", { name: file.name })} className="shrink-0 text-lyx-fg-muted hover:text-lyx-fg disabled:opacity-50">
                    <X size={14} aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {problemText ? <p className="text-[12px] text-lyx-danger" role="alert" data-testid="voice-clone-problem">{problemText}</p> : null}
        </div>

        <label className="flex items-start gap-2 rounded-lg border border-lyx-border bg-lyx-bg p-2.5 text-[12.5px] leading-5">
          <input type="checkbox" checked={agreed} onChange={(event) => setAgreed(event.target.checked)} disabled={busy} className="mt-1" data-testid="voice-clone-consent" />
          <span>{t("voiceClone.consentText")}</span>
        </label>

        {error ? <p className="text-[12.5px] text-lyx-danger" role="alert" data-testid="voice-clone-error">{error}</p> : null}

        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={busy}>{t("voiceClone.cancel")}</Button>
          <Button variant="primary" onClick={() => void submit()} disabled={!ready} loading={busy} data-testid="voice-clone-submit">
            {busy ? t("voiceClone.sending") : t("voiceClone.submit")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
