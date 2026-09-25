import { useCallback, useEffect, useState } from "react";
import type { Role } from "@lyonix/contracts";
import { useTranslation } from "react-i18next";
import { Banner, EmptyState, PageHeader, StatusPill } from "../components/chrome";
import { DataTable } from "../components/DataTable";
import { Modal } from "../components/Modal";
import { Button, Field, PasswordInput, Select, TextInput } from "../components/ui";
import { api, ApiError, csrfHeaders } from "../api";
import type { PublicChannel } from "../channel-api";
import { useMe } from "../session";

type OrgUserRow = {
  id: string;
  email: string;
  displayName: string;
  role: Role;
  disabled: boolean;
  approved: boolean;
  teamIds: string[];
  directChannelIds?: string[];
  channelIds: string[];
};

type TeamRow = { id: string; name: string; memberIds: string[]; channelIds: string[] };

const selectedValues = (event: React.ChangeEvent<HTMLSelectElement>) =>
  Array.from(event.target.selectedOptions).map((option) => option.value);

export function PeoplePage() {
  const { t } = useTranslation();
  const me = useMe();
  const [users, setUsers] = useState<OrgUserRow[]>([]);
  const [teams, setTeams] = useState<TeamRow[]>([]);
  const [managedChannels, setManagedChannels] = useState<PublicChannel[]>([]);
  const [channelsLoaded, setChannelsLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [userOpen, setUserOpen] = useState(false);
  const [teamOpen, setTeamOpen] = useState(false);
  const [editUserId, setEditUserId] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [role, setRole] = useState<Role>("staff");
  const [teamIds, setTeamIds] = useState<string[]>([]);
  const [userChannels, setUserChannels] = useState<string[]>([]);
  const [disabled, setDisabled] = useState(false);
  const [password, setPassword] = useState("lyonix-staff");
  const [editTeamId, setEditTeamId] = useState<string | null>(null);
  const [teamName, setTeamName] = useState("");
  const [teamChannels, setTeamChannels] = useState<string[]>([]);
  const [teamMembers, setTeamMembers] = useState<string[]>([]);

  const refresh = useCallback(async () => {
    const [nextUsers, nextTeams, nextChannels] = await Promise.all([
      api<OrgUserRow[]>("/organization/users"),
      api<TeamRow[]>("/organization/teams"),
      api<PublicChannel[]>("/channels"),
    ]);
    setUsers(nextUsers);
    setTeams(nextTeams);
    setManagedChannels(nextChannels);
    setChannelsLoaded(true);
  }, []);

  useEffect(() => {
    void refresh().catch((cause) => setError(cause instanceof ApiError ? cause.message : t("common.error")));
  }, [refresh, t]);

  const channelNames = (ids: string[]) => ids.map((id) => managedChannels.find((channel) => channel.id === id)?.name ?? id).join(", ") || "—";
  const memberNames = (ids: string[]) => ids.map((id) => users.find((user) => user.id === id)?.displayName ?? id).join(", ") || "—";
  const teamNames = (ids: string[]) => ids.map((id) => teams.find((team) => team.id === id)?.name ?? id).join(", ") || "—";
  const openUser = (user?: OrgUserRow) => {
    setError(null);
    setEditUserId(user?.id ?? null);
    setEmail(user?.email ?? "");
    setDisplayName(user?.displayName ?? "");
    setRole(user?.role ?? "staff");
    setTeamIds(user?.teamIds ?? []);
    setUserChannels(user?.directChannelIds ?? []);
    setDisabled(user?.disabled ?? false);
    setPassword("lyonix-staff");
    setUserOpen(true);
  };
  const openTeam = (team?: TeamRow) => {
    setError(null);
    setEditTeamId(team?.id ?? null);
    setTeamName(team?.name ?? "");
    setTeamChannels(team?.channelIds ?? []);
    setTeamMembers(team?.memberIds ?? []);
    setTeamOpen(true);
  };
  const saveUser = async () => {
    const headers = await csrfHeaders();
    if (editUserId) {
      await api(`/organization/users/${editUserId}`, { method: "PUT", headers, body: JSON.stringify({ displayName, role, disabled, teamIds, channelIds: userChannels }) });
    } else {
      await api("/organization/users", { method: "POST", headers, body: JSON.stringify({ email, displayName, role, disabled, password, teamIds, channelIds: userChannels }) });
    }
    setUserOpen(false);
    await refresh();
  };
  const saveTeam = async () => {
    const headers = await csrfHeaders();
    if (editTeamId) {
      await api(`/organization/teams/${editTeamId}`, { method: "PUT", headers, body: JSON.stringify({ name: teamName, memberIds: teamMembers, channelIds: teamChannels }) });
    } else {
      await api("/organization/teams", { method: "POST", headers, body: JSON.stringify({ name: teamName, memberIds: teamMembers, channelIds: teamChannels }) });
    }
    setTeamOpen(false);
    await refresh();
  };
  const run = (operation: () => Promise<void>) => {
    void operation().catch((cause) => setError(cause instanceof ApiError ? cause.message : t("common.error")));
  };

  if (me.role !== "admin") {
    return <><PageHeader title={t("org.people")} /><Banner variant="danger">Chỉ Admin được quản lý nhóm, người dùng và phân bổ kênh.</Banner></>;
  }

  return (
    <>
      <PageHeader title={t("org.people")} actions={<><Button onClick={() => openUser()}>{t("org.addUser")}</Button><Button variant="secondary" onClick={() => openTeam()}>{t("org.addTeam")}</Button></>} />
      {error ? <Banner variant="danger">{error}</Banner> : null}

      <h2 className="mb-2 text-[16px] font-semibold">{t("org.users")}</h2>
      <DataTable rows={users} rowKey={(row) => row.id} empty={<EmptyState title={t("common.empty")} />} columns={[
        { key: "name", header: t("org.displayName"), render: (row) => row.displayName },
        { key: "email", header: "Email", render: (row) => row.email },
        { key: "role", header: "Role", render: (row) => row.role },
        { key: "team", header: t("org.teams"), render: (row) => teamNames(row.teamIds) },
        { key: "channels", header: t("org.channels"), render: (row) => channelNames(row.channelIds) },
        { key: "status", header: "", render: (row) => <StatusPill tone={row.disabled ? "danger" : row.approved ? "ok" : "warn"}>{row.disabled ? t("org.disabled") : row.approved ? t("org.active") : t("org.pendingApproval")}</StatusPill> },
        { key: "actions", header: "", className: "text-right", render: (row) => <span className="flex justify-end gap-2" onClick={(event) => event.stopPropagation()}>{!row.approved ? <Button onClick={() => run(async () => { await api(`/organization/users/${row.id}/approve`, { method: "POST", headers: await csrfHeaders() }); await refresh(); })}>{t("org.approve")}</Button> : null}<Button variant="secondary" onClick={() => openUser(row)}>Sửa</Button><Button variant="danger" disabled={row.id === me.id} onClick={() => { if (window.confirm(`Xóa ${row.displayName}?`)) run(async () => { await api(`/organization/users/${row.id}`, { method: "DELETE", headers: await csrfHeaders() }); await refresh(); }); }}>{t("org.delete")}</Button></span> },
      ]} />

      <h2 className="mb-2 mt-8 text-[16px] font-semibold">{t("org.teams")}</h2>
      <DataTable rows={teams} rowKey={(row) => row.id} empty={<EmptyState title={t("common.empty")} />} columns={[
        { key: "name", header: t("channels.name"), render: (row) => row.name },
        { key: "channels", header: t("org.channels"), render: (row) => channelNames(row.channelIds) },
        { key: "members", header: t("org.members"), render: (row) => memberNames(row.memberIds) },
        { key: "actions", header: "", className: "text-right", render: (row) => <span className="flex justify-end gap-2" onClick={(event) => event.stopPropagation()}><Button variant="secondary" onClick={() => openTeam(row)}>Sửa</Button><Button variant="danger" disabled={teams.length <= 1} onClick={() => { if (window.confirm(`Xóa nhóm ${row.name}? Thành viên vẫn giữ các nhóm còn lại.`)) run(async () => { await api(`/organization/teams/${row.id}`, { method: "DELETE", headers: await csrfHeaders() }); await refresh(); }); }}>{t("org.delete")}</Button></span> },
      ]} />

      {userOpen ? <Modal title={editUserId ? "Sửa người dùng" : t("org.addUser")} onClose={() => setUserOpen(false)} width={640}><div className="flex flex-col gap-3"><Field label="Email"><TextInput value={email} onChange={(event) => setEmail(event.target.value)} disabled={Boolean(editUserId)} /></Field><Field label={t("org.displayName")}><TextInput value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></Field><div className="grid grid-cols-2 gap-3"><Field label="Role"><Select value={role} onChange={(event) => setRole(event.target.value as Role)}><option value="admin">admin</option><option value="staff">staff</option></Select></Field><Field label="Trạng thái"><Select value={disabled ? "disabled" : "active"} onChange={(event) => setDisabled(event.target.value === "disabled")}><option value="active">Hoạt động</option><option value="disabled">Đã vô hiệu</option></Select></Field></div><Field label={t("org.teams")} hint={t("org.multiTeamHint")}><select multiple className="min-h-24 rounded-[4px] border border-lyx-border bg-lyx-muted p-2" value={teamIds} onChange={(event) => setTeamIds(selectedValues(event))}>{teams.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}</select></Field><Field label={t("org.channels")} hint={t("org.multiChannelHint")}><select multiple disabled={!channelsLoaded} className="min-h-24 rounded-[4px] border border-lyx-border bg-lyx-muted p-2 disabled:opacity-50" value={userChannels} onChange={(event) => setUserChannels(selectedValues(event))}>{managedChannels.map((channel) => <option key={channel.id} value={channel.id}>{channel.name}</option>)}</select></Field>{!editUserId ? <Field label={t("login.password")}><PasswordInput value={password} onChange={(event) => setPassword(event.target.value)} /></Field> : null}<div className="flex justify-end gap-2"><Button variant="secondary" onClick={() => setUserOpen(false)}>{t("common.cancel")}</Button><Button disabled={!channelsLoaded} onClick={() => run(saveUser)}>{t("common.save")}</Button></div></div></Modal> : null}

      {teamOpen ? <Modal title={editTeamId ? "Sửa nhóm" : t("org.addTeam")} onClose={() => setTeamOpen(false)} width={640}><div className="flex flex-col gap-3"><Field label={t("channels.name")}><TextInput value={teamName} onChange={(event) => setTeamName(event.target.value)} /></Field><Field label={t("org.channels")} hint={t("org.multiChannelHint")}><select multiple disabled={!channelsLoaded} className="min-h-24 rounded-[4px] border border-lyx-border bg-lyx-muted p-2 disabled:opacity-50" value={teamChannels} onChange={(event) => setTeamChannels(selectedValues(event))}>{managedChannels.map((channel) => <option key={channel.id} value={channel.id}>{channel.name}</option>)}</select></Field><Field label={t("org.members")} hint={t("org.multiTeamHint")}><select multiple className="min-h-24 rounded-[4px] border border-lyx-border bg-lyx-muted p-2" value={teamMembers} onChange={(event) => setTeamMembers(selectedValues(event))}>{users.map((user) => <option key={user.id} value={user.id}>{user.displayName} · {user.email}</option>)}</select></Field><div className="flex justify-end gap-2"><Button variant="secondary" onClick={() => setTeamOpen(false)}>{t("common.cancel")}</Button><Button disabled={!channelsLoaded} onClick={() => run(saveTeam)}>{t("common.save")}</Button></div></div></Modal> : null}
    </>
  );
}
