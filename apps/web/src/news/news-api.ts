import type { NewsFeedFilter, NewsFeedResponse } from "@lyonix/contracts";
import { api } from "../api";

/** VE2E-96: headlines of the enabled news sources (cached server-side; no AI / paid provider call). */
export const getNewsFeed = (filter: NewsFeedFilter, query: string, signal?: AbortSignal): Promise<NewsFeedResponse> => {
  const params = new URLSearchParams({ filter });
  if (query.trim()) params.set("q", query.trim());
  return api<NewsFeedResponse>(`/news?${params.toString()}`, signal ? { signal } : {});
};
