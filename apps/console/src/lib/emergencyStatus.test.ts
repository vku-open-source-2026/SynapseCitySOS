// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { describe, expect, it } from 'vitest';
import {
  emergencyStatusLabel,
  emergencyStatusTone,
  isOngoingEmergencyStatus,
  isTerminalEmergencyStatus,
} from './emergencyStatus';

describe('emergency status presentation', () => {
  it('treats resolved, canceled and archived as terminal', () => {
    for (const status of ['resolved', 'canceled', 'archived', 'RESOLVED']) {
      expect(isTerminalEmergencyStatus(status)).toBe(true);
      expect(isOngoingEmergencyStatus(status)).toBe(false);
    }
  });

  it('keeps monitoring, active and contained as ongoing', () => {
    for (const status of ['monitoring', 'active', 'contained']) {
      expect(isTerminalEmergencyStatus(status)).toBe(false);
      expect(isOngoingEmergencyStatus(status)).toBe(true);
    }
  });

  it('never labels a terminal event as an ongoing deployment', () => {
    expect(emergencyStatusLabel('active')).toBe('Đang triển khai');
    expect(emergencyStatusLabel('resolved')).not.toContain('triển khai');
    expect(emergencyStatusLabel('canceled')).not.toContain('triển khai');
    expect(emergencyStatusLabel('archived')).not.toContain('triển khai');
    expect(emergencyStatusLabel(undefined)).toBe('Không rõ trạng thái');
  });

  it('maps statuses to badge tones', () => {
    expect(emergencyStatusTone('monitoring')).toBe('amber');
    expect(emergencyStatusTone('contained')).toBe('blue');
    expect(emergencyStatusTone('active')).toBe('red');
    expect(emergencyStatusTone('resolved')).toBe('slate');
  });
});
