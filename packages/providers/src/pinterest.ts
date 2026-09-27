/**
 * VE2E-15b: Pinterest evaluation outcome, not an implementation.
 *
 * Pinterest's own developer docs require an approved app and a current access token before any
 * API call is permitted (https://developers.pinterest.com/docs/getting-started/make-an-api-call/,
 * cited in VE2E-PROVIDER-UX.md §7, checked by Plan 2026-09-25). This Code session has neither an
 * approved Pinterest app/token to test against, nor live web-doc access to re-verify Pinterest's
 * current discovery/search endpoint path and response shape at implementation time.
 *
 * Per this task's explicit instruction, guessing an endpoint path/response shape here would be
 * worse than not implementing it: a wrong guess can look like a working integration while
 * actually being silently broken, or call an unintended endpoint. This file documents the
 * blocked status instead - surfaced through `GET /provider-catalog` as
 * `implementationStatus: "blocked"`, the same convention already used for the cancelled `vrew`
 * render provider - rather than shipping unverified network code.
 *
 * Unblocking this requires, in order: (1) an approved Pinterest developer app + verified access
 * token for the account that will own this integration, (2) a fresh read of Pinterest's current
 * API reference for the specific pin/board search endpoint to be used, confirmed against the
 * live docs at implementation time (not from training-data memory), (3) the same
 * `MediaCandidate` mapping pattern already used by `pexels.ts`/`youtube.ts` in this package
 * (access method, rights status, attribution, external id).
 */

export type PinterestAdapterStatus = {
  provider: "pinterest";
  implementationStatus: "blocked";
  reason: string;
};

export const PINTEREST_BLOCKED_REASON =
  "Pinterest API access requires an approved developer app and a verified current access token/discovery endpoint (developers.pinterest.com); neither is available in this sandbox, and the endpoint shape could not be re-verified against live docs at implementation time. Not implemented rather than guessed - see VE2E-PROVIDER-UX.md §6/§7.";

export function pinterestAdapterStatus(): PinterestAdapterStatus {
  return { provider: "pinterest", implementationStatus: "blocked", reason: PINTEREST_BLOCKED_REASON };
}
