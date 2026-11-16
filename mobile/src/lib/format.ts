// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import type { Severity } from '../api/types';

export const colors = {
  bg: '#FFF8F3',
  bgElevated: '#FFFFFF',
  card: '#FFFFFF',
  cardAlt: '#FFF1EA',
  border: '#F1D9CC',
  text: '#3F1D1A',
  textMuted: '#7A5C56',
  textDim: '#A0847D',
  red: '#C2412D',
  redDeep: '#B9382B',
  amber: '#D97706',
  orange: '#EA580C',
  green: '#059669',
  cyan: '#B9382B',
  violet: '#7C3AED',
};

export const severityMeta: Record<Severity, { label: string; color: string; bg: string }> = {
  low: { label: 'Thấp', color: '#047857', bg: '#ECFDF5' },
  medium: { label: 'Trung bình', color: '#B45309', bg: '#FFFBEB' },
  high: { label: 'Cao', color: '#C2410C', bg: '#FFF7ED' },
  critical: { label: 'Nghiêm trọng', color: '#BE123C', bg: '#FFF1F2' },
};

export function normalizeSeverity(value: unknown): Severity {
  return value === 'low' || value === 'medium' || value === 'high' || value === 'critical'
    ? value
    : 'medium';
}

export function hazardTypeLabel(value: string | undefined): string {
  const labels: Record<string, string> = {
    flood: 'Ngập lụt',
    storm: 'Bão / sóng lớn',
    landslide: 'Sạt lở',
    fire: 'Cháy',
    earthquake: 'Động đất',
    outage: 'Mất điện',
    pollution: 'Ô nhiễm',
    drought: 'Hạn hán',
    traffic: 'Giao thông',
    epidemic: 'Dịch bệnh',
    rain: 'Mưa lớn',
    cold: 'Rét hại',
    hail: 'Mưa đá',
    tornado: 'Lốc xoáy',
    thunderstorm: 'Dông sét',
    wind: 'Gió mạnh',
    heat: 'Nắng nóng',
    fog: 'Sương mù',
    other: 'Khác',
  };
  return value ? labels[value] || value.replaceAll('_', ' ') : 'Khác';
}

export function eventStatusLabel(value: string | undefined): string {
  const labels: Record<string, string> = {
    monitoring: 'Đang theo dõi',
    active: 'Đang hoạt động',
    contained: 'Đã kiểm soát',
    resolved: 'Đã kết thúc',
    canceled: 'Đã huỷ',
  };
  return value ? labels[value] || value : 'Chưa rõ';
}

export function feedStatusLabel(status: string | undefined): string {
  const labels: Record<string, string> = {
    ready: 'Nguồn tin hoạt động',
    degraded: 'Nguồn tin suy giảm',
    stale: 'Nguồn tin cũ',
    error: 'Nguồn tin lỗi',
    unconfigured: 'Chưa cấu hình nguồn tin',
    ok: 'Nguồn tin hoạt động',
  };
  return status ? labels[status] || status : 'Không xác định';
}

export function timeAgo(value: string | undefined | null): string {
  if (!value) return '—';
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return '—';
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return 'vừa xong';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} phút trước`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} giờ trước`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} ngày trước`;
  return new Date(timestamp).toLocaleDateString('vi-VN');
}

export function formatDateTime(value: string | undefined | null): string {
  if (!value) return '—';
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return '—';
  return new Date(timestamp).toLocaleString('vi-VN', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function plural(count: number, singular: string, pluralForm: string): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}
