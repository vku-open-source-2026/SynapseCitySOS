// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { httpClient } from '../lib/httpClient';
import type { AuthUser } from '../types/auth';

export interface LoginRequest {
  username: string;
  password: string;
}

export interface RegisterRequest {
  username: string;
  email: string;
  password: string;
  full_name: string;
  phone?: string;
}

export interface AuthResponse {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  user: AuthUser;
}

export interface RefreshTokenRequest {
  refresh_token: string;
}

export interface PasswordChangeRequest {
  current_password: string;
  new_password: string;
}

function requireAuthResponse(value: unknown): AuthResponse {
  if (!value || typeof value !== 'object') {
    throw new Error('invalid_auth_response');
  }
  const response = value as Partial<AuthResponse>;
  if (
    typeof response.access_token !== 'string' ||
    typeof response.refresh_token !== 'string' ||
    !response.user ||
    typeof response.user !== 'object'
  ) {
    throw new Error('invalid_auth_response');
  }
  return response as AuthResponse;
}

export const authApi = {
  login: async (data: LoginRequest): Promise<AuthResponse> => {
    const response = await httpClient.post<AuthResponse>('/auth/login', data);
    return requireAuthResponse(response.data);
  },

  register: async (data: RegisterRequest): Promise<AuthResponse> => {
    const response = await httpClient.post<AuthResponse>('/auth/register', data);
    return requireAuthResponse(response.data);
  },

  refreshToken: async (refreshToken: string): Promise<AuthResponse> => {
    const response = await httpClient.post<AuthResponse>('/auth/refresh', {
      refresh_token: refreshToken,
    });
    return requireAuthResponse(response.data);
  },

  logout: async (): Promise<void> => {
    await httpClient.post('/auth/logout');
  },

  changePassword: async (data: PasswordChangeRequest): Promise<void> => {
    await httpClient.post('/auth/change-password', data);
  },
};
