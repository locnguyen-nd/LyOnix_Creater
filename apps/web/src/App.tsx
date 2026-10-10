import type { ReactNode } from "react";
import { Navigate, Route, Routes, useSearchParams } from "react-router-dom";
import { AppShell } from "./components/AppShell";
import { AssetsPage } from "./pages/AssetsPage";
import { ChannelDetailPage, ChannelsPage } from "./pages/ChannelsPage";
import { DeniedPage } from "./pages/DeniedPage";
import { EditorPage } from "./pages/EditorPage";
import { HomePage } from "./pages/HomePage";
import { JobNewPage } from "./pages/JobNewPage";
import { JobPage } from "./pages/JobPage";
import { JobsPage } from "./pages/JobsPage";
import { LoginPage } from "./pages/LoginPage";
import { RegisterPage } from "./pages/RegisterPage";
import { LongformPage } from "./pages/LongformPage";
import { MePage } from "./pages/MePage";
import { PeoplePage } from "./pages/PeoplePage";
import { ScriptPage } from "./pages/ScriptPage";
import { SettingsPage } from "./pages/SettingsPage";
import { StudioProPage } from "./pages/StudioProPage";
import { TemplateGalleryPage } from "./pages/TemplateGalleryPage";
import { TiktokOauthCallbackPage } from "./pages/TiktokOauthCallbackPage";
import { VideoProductionPage } from "./pages/VideoProductionPage";
import { VideoProductionsPage } from "./pages/VideoProductionsPage";
import { TrendRadarPage } from "./trend-radar/TrendRadarPage";
import { useSession } from "./session";

function RequireAuth({ children }: { children: ReactNode }) {
  const { me } = useSession();
  if (!me) return <Navigate to="/login" replace />;
  return children;
}

function RequireAdmin({ children }: { children: ReactNode }) {
  const { me } = useSession();
  if (!me) return <Navigate to="/login" replace />;
  if (me.role !== "admin") return <Navigate to="/denied" replace />;
  return children;
}

export function App() {
  const [params] = useSearchParams();
  if (params.get("code") && params.get("state")) return <TiktokOauthCallbackPage />;
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route path="/callback" element={<TiktokOauthCallbackPage />} />
      <Route path="/callback/" element={<TiktokOauthCallbackPage />} />
      <Route
        path="/denied"
        element={
          <RequireAuth>
            <AppShell />
          </RequireAuth>
        }
      >
        <Route index element={<DeniedPage />} />
      </Route>
      <Route
        path="/"
        element={
          <RequireAuth>
            <AppShell />
          </RequireAuth>
        }
      >
        <Route index element={<HomePage />} />
        <Route path="callback" element={<TiktokOauthCallbackPage />} />
        <Route path="channels" element={<ChannelsPage />} />
        <Route path="channels/:id" element={<ChannelDetailPage />} />
        <Route path="jobs" element={<JobsPage />} />
        <Route path="jobs/new" element={<JobNewPage />} />
        <Route path="jobs/:id" element={<JobPage />} />
        <Route path="jobs/:id/script" element={<ScriptPage />} />
        <Route path="jobs/:id/longform" element={<LongformPage />} />
        <Route path="jobs/:id/assets" element={<AssetsPage />} />
        <Route path="jobs/:id/editor" element={<EditorPage />} />
        <Route path="jobs/:id/studio" element={<StudioProPage />} />
        <Route path="jobs/:id/studio/templates" element={<TemplateGalleryPage />} />
        <Route path="video-productions" element={<VideoProductionsPage />} />
        <Route path="video-productions/:id" element={<VideoProductionPage />} />
        <Route path="video-productions/:id/studio" element={<StudioProPage />} />
        <Route path="trend-radar" element={<TrendRadarPage />} />
        <Route path="assets" element={<AssetsPage />} />
        <Route path="library" element={<Navigate to="/jobs" replace />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="settings/providers" element={<Navigate to="/settings?tab=providers" replace />} />
        <Route path="settings/org" element={<Navigate to="/settings" replace />} />
        <Route path="settings/users" element={<Navigate to="/people" replace />} />
        <Route path="settings/teams" element={<Navigate to="/people" replace />} />
        <Route
          path="people"
          element={
            <RequireAdmin>
              <PeoplePage />
            </RequireAdmin>
          }
        />
        <Route path="me" element={<MePage />} />
      </Route>
    </Routes>
  );
}
