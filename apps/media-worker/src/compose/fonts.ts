import { BinaryNotFoundError, type ProcessRunner } from "../process.js";

/**
 * VE2E-107: font availability check. libass silently substitutes a missing family (CJK text would render as tofu or a wrong face), so a
 * render whose recipe needs a font the host lacks must fail fast with FONT_MISSING (a technical failure: the Router then falls back to a
 * provider) instead of producing a wrong-looking video that still passes QC.
 *
 * Families come from `fc-list` (system fonts) plus `fc-scan <fontsDir>` (RENDER_FONTS_DIR, which libass reads directly). Where fontconfig
 * tools are not installed (typically a Windows dev box) the check is skipped and reported as `unchecked`.
 */

export type FontCheck = { ok: true; checked: boolean } | { ok: false; missing: string[] };

const normalize = (family: string): string => family.trim().toLowerCase();

/** Splits fontconfig `family` output ("Noto Sans CJK JP,Noto Sans CJK JP Regular" per line) into lower-cased family names. */
export function parseFamilies(output: string): Set<string> {
  const families = new Set<string>();
  for (const line of output.split(/\r?\n/)) for (const part of line.split(",")) if (part.trim()) families.add(normalize(part));
  return families;
}

export async function checkFontsAvailable(runner: ProcessRunner, required: readonly string[], fontsDir: string | null): Promise<FontCheck> {
  if (required.length === 0) return { ok: true, checked: true };
  const available = new Set<string>();
  try {
    const system = await runner("fc-list", [":", "family"], { timeoutMs: 15_000 });
    if (system.exitCode !== 0) return { ok: true, checked: false };
    for (const family of parseFamilies(system.stdout)) available.add(family);
    if (fontsDir) {
      const scanned = await runner("fc-scan", ["--format", "%{family}\\n", fontsDir], { timeoutMs: 30_000 });
      if (scanned.exitCode === 0) for (const family of parseFamilies(scanned.stdout)) available.add(family);
    }
  } catch (error) {
    if (error instanceof BinaryNotFoundError) return { ok: true, checked: false };
    throw error;
  }
  const missing = required.filter((family) => !available.has(normalize(family)));
  return missing.length === 0 ? { ok: true, checked: true } : { ok: false, missing: [...missing] };
}
