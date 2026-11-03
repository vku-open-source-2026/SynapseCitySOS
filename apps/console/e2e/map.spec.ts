// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { describe, test, expect, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { navigateTo } from './helpers';

describe('Public Hazard Map Page', () => {
  beforeEach(async () => {
    await navigateTo('/map');
    await waitFor(() => {
      expect(document.querySelector('.leaflet-container')).toBeTruthy();
    }, { timeout: 10000 });
  });

  test('should render the Leaflet map with a non-zero container', async () => {
    const container = document.querySelector('.leaflet-container') as HTMLElement | null;
    expect(container).toBeTruthy();

    await waitFor(() => {
      expect(container?.clientHeight ?? 0).toBeGreaterThan(0);
    }, { timeout: 5000 });
  });

  test('should brand the page as SynapseCity SOS', async () => {
    const brand = screen.queryAllByText(/SynapseCity SOS/i);
    expect(brand.length).toBeGreaterThan(0);
    expect(screen.queryByText(/Cảnh báo thiên tai khu vực của bạn/i)).toBeTruthy();
  });

  test('should display hazard and emergency sections', async () => {
    expect(screen.queryByText(/Chiến dịch cứu hộ đang diễn ra/i)).toBeTruthy();
    expect(screen.queryAllByText(/Cảnh báo thiên tai/i).length).toBeGreaterThan(0);
  });

  test('should show SOS help actions instead of citizen incident reporting', async () => {
    const callButton = screen.queryByRole('link', { name: /Gọi 114/i });
    const helpButton = screen.queryByRole('button', { name: /Hướng dẫn an toàn/i });
    const shelterButton = screen.queryByRole('button', { name: /Nơi trú ẩn gần/i });

    expect(callButton).toBeTruthy();
    expect(helpButton).toBeTruthy();
    expect(shelterButton).toBeTruthy();

    // Citizen incident reporting belongs to SynapseCity.
    expect(screen.queryByRole('button', { name: /^Báo sự cố$/i })).toBeNull();
  });

  test('should open the safety guidance modal', async () => {
    const helpButton = screen.queryByRole('button', { name: /Hướng dẫn an toàn/i });
    expect(helpButton).toBeTruthy();

    if (helpButton) {
      await userEvent.click(helpButton);
      await waitFor(() => {
        expect(screen.queryByText(/Khi tính mạng bị đe dọa/i)).toBeTruthy();
      }, { timeout: 3000 });
    }
  });

  test('should expose severity filters', async () => {
    expect(screen.queryByRole('button', { name: /Tất cả/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Nghiêm trọng/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Gần tôi/i })).toBeTruthy();
  });
});
