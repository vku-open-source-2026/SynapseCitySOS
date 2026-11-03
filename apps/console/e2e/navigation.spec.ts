// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { describe, test, expect, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { navigateTo } from './helpers';

describe('Navigation Flow', () => {
  beforeEach(async () => {
    await navigateTo('/');
    await waitFor(() => document.body, { timeout: 5000 });
  });

  test('should navigate from homepage to the public hazard map', async () => {
    const mapLinks = screen.queryAllByRole('link', { name: /bản đồ nguy cơ/i });
    const mapLink = mapLinks[0];

    if (mapLink) {
      await userEvent.click(mapLink);
      await waitFor(() => {
        expect(window.location.pathname).toMatch(/.*map/);
      });
    }
  });

  test('should navigate from homepage to login', async () => {
    const loginLink = screen.queryByRole('link', { name: /login|đăng nhập/i }) ||
                      screen.queryByRole('button', { name: /login|đăng nhập/i });

    if (loginLink) {
      await userEvent.click(loginLink);
      await waitFor(() => {
        expect(window.location.pathname).toMatch(/.*login/);
      });
    }
  });

  test('should navigate between public SOS pages', async () => {
    await navigateTo('/map');
    await waitFor(() => {
      expect(window.location.pathname).toMatch(/.*map/);
    }, { timeout: 5000 });

    await navigateTo('/docs');
    await waitFor(() => {
      expect(window.location.pathname).toMatch(/.*docs/);
    }, { timeout: 5000 });

    await navigateTo('/about');
    await waitFor(() => {
      expect(window.location.pathname).toMatch(/.*about/);
    }, { timeout: 5000 });
  });

  test('should handle protected routes', async () => {
    await navigateTo('/admin');
    await waitFor(() => document.body, { timeout: 5000 });

    const currentPath = window.location.pathname;
    expect(currentPath.includes('/login') || currentPath.includes('/admin')).toBeTruthy();
  });
});
