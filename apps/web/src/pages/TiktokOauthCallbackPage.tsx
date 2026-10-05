import { useEffect } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Banner } from "../components/chrome";
import { api, csrfHeaders } from "../api";

export function TiktokOauthCallbackPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  useEffect(() => {
    const error = params.get("error");
    const code = params.get("code");
    const state = params.get("state");
    if (error || !code || !state) {
      navigate("/channels?error=oauth_denied", { replace: true });
      return;
    }
    void (async () => {
      try {
        const result = await api<{ channelId: string }>("/channel-oauth/tiktok/complete", {
          method: "POST",
          headers: await csrfHeaders(),
          body: JSON.stringify({ code, state }),
        });
        navigate(`/channels?connected=${encodeURIComponent(result.channelId)}`, { replace: true });
      } catch {
        navigate("/channels?error=oauth_failed", { replace: true });
      }
    })();
  }, [navigate, params]);
  return <Banner variant="info">Đang hoàn tất kết nối TikTok…</Banner>;
}
