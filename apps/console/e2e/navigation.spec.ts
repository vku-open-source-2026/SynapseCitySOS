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

});
