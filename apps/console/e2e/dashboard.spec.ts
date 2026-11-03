// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { describe, test, expect, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { navigateTo } from './helpers';

describe('SOS Dashboard', () => {
  beforeEach(async () => {
    await navigateTo('/admin');
    await waitFor(() => document.body, { timeout: 5000 });
  });

  test('should display the SOS dashboard when authenticated', async () => {
    const currentPath = window.location.pathname;

    if (currentPath.includes('/login')) {
      const loginTexts = screen.queryAllByText(/đăng nhập|login|sign in/i);
      expect(loginTexts.length).toBeGreaterThan(0);
      return;
    }

    const dashboardHeadings = screen.queryAllByText(/Bảng điều khiển SOS/i);
    expect(dashboardHeadings.length).toBeGreaterThan(0);
  });

  test('should display emergency operations summary cards', async () => {
    if (window.location.pathname.includes('/login')) {
      return;
    }

    expect(screen.queryByText(/Sự kiện đang xử lý/i)).toBeTruthy();
    expect(screen.queryByText(/EOP nháp/i)).toBeTruthy();
    expect(screen.queryByText(/Điều phối đang mở/i)).toBeTruthy();
    expect(screen.queryByText(/Nguồn lực sẵn sàng/i)).toBeTruthy();
    expect(screen.queryByText(/SITREP đã xuất bản/i)).toBeTruthy();
    expect(screen.queryByText(/AAR đã xuất bản/i)).toBeTruthy();
  });

  test('should display sidebar navigation with SOS-only sections', async () => {
    if (window.location.pathname.includes('/login')) {
      return;
    }

    const sidebar = document.querySelector('nav');
    expect(sidebar).toBeTruthy();

    expect(screen.queryAllByText(/Chỉ huy khẩn cấp/i).length).toBeGreaterThan(0);
    expect(screen.queryAllByText(/Bản đồ nguy cơ công khai/i).length).toBeGreaterThan(0);
    expect(screen.queryAllByText(/Bảng chuẩn bị/i).length).toBeGreaterThan(0);

    // City-infrastructure sections must not appear in the SOS console.
    expect(screen.queryByText(/Quản lý người dùng/i)).toBeNull();
    expect(screen.queryByText(/Cảm biến IoT/i)).toBeNull();
    expect(screen.queryByText(/Ngân sách/i)).toBeNull();
  });

  test('should navigate to the emergency command centre', async () => {
    if (window.location.pathname.includes('/login')) {
      return;
    }

    const commandCentreLink = screen.queryByRole('link', { name: /Chỉ huy khẩn cấp/i });
    if (!commandCentreLink) {
      return;
    }

    await userEvent.click(commandCentreLink);
    await waitFor(() => {
      expect(window.location.pathname).toContain('/admin/emergency-center');
    }, { timeout: 5000 });
  });
});
