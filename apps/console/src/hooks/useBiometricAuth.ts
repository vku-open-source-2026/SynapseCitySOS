// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/**
 * Biometric login is disabled.
 *
 * The previous implementation cached the access/refresh tokens and the whole
 * user object in localStorage and "authenticated" by replaying them after a
 * local WebAuthn assertion that no server ever verified. That is a token-replay
 * shortcut, not authentication (issue #17). Server-side WebAuthn verification
 * belongs to the Tier-1 IAM gateway; until it exists the feature is removed
 * rather than faked.
 *
 * The hook keeps its public shape so the login page can keep rendering without
 * branching on a missing hook, but it always reports unavailable.
 */
import { useEffect, useState } from 'react';

const LEGACY_KEYS = ['biometric_enabled', 'biometric_credential_id', 'biometric_user_data'];

interface BiometricState {
  isAvailable: boolean;
  isEnabled: boolean;
  isLoading: boolean;
  error: string | null;
}

export function useBiometricAuth() {
  const [state, setState] = useState<BiometricState>({
    isAvailable: false,
    isEnabled: false,
    isLoading: false,
    error: null,
  });

  useEffect(() => {
    // Remove any token cache left by an older build.
    try {
      for (const key of LEGACY_KEYS) localStorage.removeItem(key);
    } catch {
      // Storage may be disabled; nothing to clean up.
    }
  }, []);

  return {
    ...state,
    registerBiometric: async (): Promise<boolean> => false,
    authenticateWithBiometric: async (): Promise<boolean> => false,
    disableBiometric: (): void => {
      try {
        for (const key of LEGACY_KEYS) localStorage.removeItem(key);
      } catch {
        // ignore
      }
      setState((previous) => ({ ...previous, isEnabled: false }));
    },
    updateStoredTokens: (): void => {
      // Deliberately a no-op: no tokens are cached for biometric replay.
    },
  };
}
