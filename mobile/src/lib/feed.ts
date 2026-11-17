// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import type { FeedStatus } from '../api/types';

export function feedHealth(status: FeedStatus | undefined): {
  state: 'ok' | 'degraded' | 'unknown';
  label: string;
} {
  if (!status) return { state: 'unknown', label: 'Không xác định nguồn tin' };
  if (status.data_available === false) return { state: 'unknown', label: 'Không xác định nguồn tin' };
  if (status.status !== 'ok') return { state: 'degraded', label: 'Nguồn tin suy giảm' };
  const feed = status.hazard_feed;
  if (
    !feed ||
    feed.stale ||
    feed.status === 'error' ||
    feed.status === 'stale' ||
    feed.status === 'degraded' ||
    feed.status === 'unconfigured' ||
    feed.ingest_stale === true ||
    feed.ingest?.stale === true ||
    feed.ingest?.status === 'failed' ||
    feed.ingest?.status === 'error' ||
    feed.ingest?.status === 'unconfigured'
  ) {
    // A stale/unconfigured VNDMS ingest is degraded, never "unknown safe".
    return { state: 'degraded', label: 'Nguồn tin suy giảm' };
  }
  return { state: 'ok', label: 'Nguồn tin hoạt động' };
}
