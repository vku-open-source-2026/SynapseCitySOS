// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { AuthUser } from '../types/auth';

interface AuthState {
  user: AuthUser | null;
  accessToken: string | null;
  refreshToken: string | null;
  isAuthenticated: boolean;
  login: (accessToken: string, refreshToken: string, user: AuthUser) => void;
  logout: () => void;
  setUser: (user: AuthUser) => void;
  setTokens: (accessToken: string, refreshToken: string) => void;
}

/**
 * Session tokens are kept in sessionStorage, not localStorage: they expire with
 * the tab, are not shared across tabs and are not left on disk. The auth shell
 * still cannot stop XSS; CSP at the edge (apps/console/nginx.conf) is the
 * complementary control. Production identity must move to httpOnly cookies at
 * the Tier-1 IAM gateway.
 */
const memoryStorage = new Map<string, string>();
const fallbackStorage = {
  getItem: (name: string) => memoryStorage.get(name) ?? null,
  setItem: (name: string, value: string) => { memoryStorage.set(name, value); },
  removeItem: (name: string) => { memoryStorage.delete(name); },
};
const sessionStore = () => (typeof window === 'undefined' ? fallbackStorage : window.sessionStorage);

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      user: null,
      accessToken: null,
      refreshToken: null,
      isAuthenticated: false,
      login: (accessToken: string, refreshToken: string, user: AuthUser) => {
        set({ accessToken, refreshToken, user, isAuthenticated: true });
      },
      logout: () => {
        set({ accessToken: null, refreshToken: null, user: null, isAuthenticated: false });
      },
      setUser: (user: AuthUser) => {
        set({ user });
      },
      setTokens: (accessToken: string, refreshToken: string) => {
        set({ accessToken, refreshToken });
      },
    }),
    {
      name: 'auth-storage',
      storage: createJSONStorage(sessionStore),
      partialize: (state) => ({
        accessToken: state.accessToken,
        refreshToken: state.refreshToken,
        user: state.user,
        isAuthenticated: state.isAuthenticated,
      }),
    }
  )
);
