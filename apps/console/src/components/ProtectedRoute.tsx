// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { Navigate, useNavigate } from '@tanstack/react-router';
import { useAuthStore } from '../stores/authStore';
import { useEffect, useState } from 'react';
import { authApi } from '../api/auth';

interface ProtectedRouteProps {
  children: React.ReactNode;
  requiredRole?: 'admin' | 'manager' | 'operator' | 'responder';
  requiredPermission?: string;
}

const ROLE_RANK: Record<string, number> = {
  citizen: 0,
  volunteer: 1,
  responder: 2,
  operator: 3,
  manager: 4,
  admin: 5,
};

/** Read the JWT expiry without verifying it; the server is the authority. */
function accessTokenExpiresAt(token: string | null): number | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    const payload = JSON.parse(atob(padded)) as { exp?: number };
    return typeof payload.exp === 'number' ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

export function ProtectedRoute({
  children,
  requiredRole,
  requiredPermission
}: ProtectedRouteProps) {
  const { isAuthenticated, user, accessToken, refreshToken, setTokens, logout } = useAuthStore();
  const [isChecking, setIsChecking] = useState(true);
  const navigate = useNavigate();

  useEffect(() => {
    let cancelled = false;

    const checkAuth = async () => {
      if (!isAuthenticated) {
        if (!cancelled) setIsChecking(false);
        return;
      }

      // Role hierarchy check: an admin may open a manager surface.
      if (requiredRole && (ROLE_RANK[user?.role ?? 'citizen'] ?? 0) < (ROLE_RANK[requiredRole] ?? 0)) {
        if (!cancelled) {
          navigate({ to: '/admin' });
          setIsChecking(false);
        }
        return;
      }

      if (requiredPermission && !user?.permissions?.includes(requiredPermission) && user?.role !== 'admin') {
        if (!cancelled) {
          navigate({ to: '/admin' });
          setIsChecking(false);
        }
        return;
      }

      // Refresh only when the access token is actually near expiry. Refreshing
      // on every mount rotated the refresh token on each navigation (issue #17).
      const expiresAt = accessTokenExpiresAt(accessToken);
      const needsRefresh = refreshToken && expiresAt !== null && expiresAt - Date.now() < 60_000;
      if (needsRefresh) {
        try {
          const response = await authApi.refreshToken(refreshToken as string);
          if (!cancelled) setTokens(response.access_token, response.refresh_token);
        } catch {
          if (!cancelled) {
            logout();
            navigate({ to: '/login' });
          }
          return;
        }
      }

      if (!cancelled) setIsChecking(false);
    };

    void checkAuth();
    return () => { cancelled = true; };
  }, [isAuthenticated, user, requiredRole, requiredPermission, accessToken, refreshToken, setTokens, logout, navigate]);

  if (isChecking) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto"></div>
          <p className="mt-4 text-gray-600">Loading...</p>
        </div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" />;
  }

  return <>{children}</>;
}
