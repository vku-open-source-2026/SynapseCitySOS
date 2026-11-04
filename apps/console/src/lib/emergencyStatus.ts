// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/**
 * Emergency-event status presentation shared by the public map and layers.
 *
 * Terminal statuses must never be rendered as an ongoing operation: the public
 * projection already excludes them, and the client keeps the same rule so a
 * stale or cached payload cannot label a resolved event "Đang triển khai".
 */
export const TERMINAL_EMERGENCY_STATUSES = ['resolved', 'canceled', 'archived'] as const;

export type EmergencyStatusValue =
  | 'monitoring'
  | 'active'
  | 'contained'
  | 'resolved'
  | 'canceled'
  | 'archived'
  | string;

export function isTerminalEmergencyStatus(status: unknown): boolean {
  return TERMINAL_EMERGENCY_STATUSES.includes(String(status ?? '').toLowerCase() as typeof TERMINAL_EMERGENCY_STATUSES[number]);
}

export function isOngoingEmergencyStatus(status: unknown): boolean {
  return !isTerminalEmergencyStatus(status);
}

const STATUS_LABEL: Record<string, string> = {
  monitoring: 'Đang theo dõi',
  active: 'Đang triển khai',
  contained: 'Đã kiểm soát',
  resolved: 'Đã kết thúc',
  canceled: 'Đã huỷ',
  archived: 'Đã lưu trữ',
};

export function emergencyStatusLabel(status: unknown): string {
  const key = String(status ?? '').toLowerCase();
  return STATUS_LABEL[key] ?? (key || 'Không rõ trạng thái');
}

export function emergencyStatusTone(status: unknown): 'amber' | 'blue' | 'red' | 'slate' {
  switch (String(status ?? '').toLowerCase()) {
    case 'monitoring': return 'amber';
    case 'contained': return 'blue';
    case 'active': return 'red';
    default: return 'slate';
  }
}
