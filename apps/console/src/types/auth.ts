// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/**
 * Auth-shell user model for SynapseCity SOS.
 *
 * This is intentionally limited to the identity fields the emergency console
 * needs to render a session. City operator/technician administration lives in
 * the SynapseCity product, not here.
 */
export type AuthUserRole = 'admin' | 'manager' | 'operator' | 'responder' | 'volunteer' | 'citizen';

export type AuthUserStatus = 'active' | 'inactive' | 'suspended';

export interface AuthUser {
  id: string;
  username: string;
  email: string;
  full_name: string;
  phone?: string;
  role: AuthUserRole;
  status?: AuthUserStatus;
  permissions?: string[];
  department?: string;
  avatar_url?: string;
  language?: string;
  last_login?: string;
  created_at?: string;
  updated_at?: string;
}

export interface ProfileUpdateRequest {
  email?: string;
  full_name?: string;
  phone?: string;
}
