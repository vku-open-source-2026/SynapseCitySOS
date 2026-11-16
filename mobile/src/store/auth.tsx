// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { sosApi } from '../api/sos';
import type { AuthResponse, AuthUser } from '../api/types';
import { clearSession, loadSession, saveSession, type Session } from '../lib/storage';

interface AuthContextValue {
  session: Session | null;
  user: AuthUser | null;
  token: string | null;
  loading: boolean;
  /** Exchange a Tier-2/DX workspace bearer for a short-lived SOS session. */
  connectTier2Token: (tier2Token: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    loadSession()
      .then((stored) => {
        if (active) setSession(stored);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const applyAuth = useCallback(async (response: AuthResponse) => {
    const next: Session = {
      accessToken: response.access_token,
      refreshToken: response.refresh_token,
      user: response.user,
    };
    setSession(next);
    await saveSession(next);
  }, []);

  const connectTier2Token = useCallback(
    async (tier2Token: string) => {
      await applyAuth(await sosApi.exchangeTier2Token(tier2Token));
    },
    [applyAuth],
  );

  const logout = useCallback(async () => {
    // The local SOS session is stateless; clearing SecureStore is sufficient.
    // The Tier-2/DX session remains owned by the workspace.
    setSession(null);
    await clearSession();
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      session,
      user: session?.user ?? null,
      token: session?.accessToken ?? null,
      loading,
      connectTier2Token,
      logout,
    }),
    [session, loading, connectTier2Token, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside AuthProvider');
  return context;
}
