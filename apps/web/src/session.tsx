import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { api, type ApiMe } from "./api";
import type { Me, StudioState } from "./studio/types";
import {
  loadPersistedState,
  persistState,
  SESSION_KEY,
} from "./studio/store";

type Store = {
  getState: () => StudioState;
  setState: (next: StudioState) => void;
  subscribe: (fn: () => void) => () => void;
};

function createPersistentStore(): Store {
  let state = loadPersistedState();
  const listeners = new Set<() => void>();
  return {
    getState: () => state,
    setState: (next) => {
      state = next;
      persistState(state);
      listeners.forEach((fn) => fn());
    },
    subscribe: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

const store = createPersistentStore();

function readSessionId(): string | null {
  if (typeof sessionStorage === "undefined") return null;
  return sessionStorage.getItem(SESSION_KEY);
}

type SessionValue = {
  me: Me | null;
  state: StudioState;
  loginAs: (me: Me) => void;
  login: (email: string, password: string) => Promise<Me>;
  logout: () => Promise<void>;
  updateState: (next: StudioState | ((prev: StudioState) => StudioState)) => void;
  refreshMe: () => void;
};

const SessionContext = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  const [sessionId, setSessionId] = useState<string | null>(readSessionId);

  const me = useMemo(
    () => state.users.find((u) => u.id === sessionId) ?? null,
    [state.users, sessionId],
  );

  const loginAs = useCallback((user: Me) => {
    // The API is the source of truth; make authenticated users available to the
    // client-side selectors even when they were not part of the local demo seed.
    store.setState({ ...store.getState(), users: [...store.getState().users.filter((item) => item.id !== user.id), user] });
    sessionStorage.setItem(SESSION_KEY, user.id);
    setSessionId(user.id);
  }, []);

  useEffect(() => {
    if (!readSessionId()) return;
    void api<ApiMe>("/me").then(loginAs).catch(() => {
      sessionStorage.removeItem(SESSION_KEY);
      setSessionId(null);
    });
  }, [loginAs]);

  const login = useCallback(async (email: string, password: string) => {
    const user = await api<ApiMe>("/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
    loginAs(user);
    return user;
  }, [loginAs]);

  const logout = useCallback(async () => {
    const csrf = await api<{ csrfToken: string }>("/auth/csrf");
    await api<void>("/auth/logout", { method: "POST", headers: { "x-csrf-token": csrf.csrfToken } });
    sessionStorage.removeItem(SESSION_KEY);
    setSessionId(null);
  }, []);

  const updateState = useCallback((next: StudioState | ((prev: StudioState) => StudioState)) => {
    const resolved = typeof next === "function" ? next(store.getState()) : next;
    store.setState(resolved);
  }, []);

  const refreshMe = useCallback(() => setSessionId(readSessionId()), []);

  const value = useMemo(
    () => ({ me, state, loginAs, login, logout, updateState, refreshMe }),
    [me, state, loginAs, login, logout, updateState, refreshMe],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession() {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("SessionProvider missing");
  return ctx;
}

export function useMe() {
  const { me } = useSession();
  if (!me) throw new Error("Unauthenticated");
  return me;
}
