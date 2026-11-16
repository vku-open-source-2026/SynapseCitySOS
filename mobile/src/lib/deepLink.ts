// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC

export type AppRouteName =
  | 'home'
  | 'map'
  | 'alerts'
  | 'shelters'
  | 'emergency'
  | 'account'
  | 'settings'
  | 'hazard'
  | 'event'
  | 'widget-help';

export interface AppRoute {
  name: AppRouteName;
  params?: Record<string, string>;
}

export function parseDeepLink(url: string | null | undefined): AppRoute | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    const path = `${parsed.hostname}${parsed.pathname}`.replace(/^\/+|\/+$/g, '');
    const [first, second] = path.split('/');
    switch (first) {
      case 'hazard':
        return second ? { name: 'hazard', params: { id: decodeURIComponent(second) } } : { name: 'alerts' };
      case 'event':
        return second ? { name: 'event', params: { id: decodeURIComponent(second) } } : { name: 'emergency' };
      case 'sos':
        return { name: 'emergency' };
      case 'map':
        return { name: 'map' };
      case 'alerts':
        return { name: 'alerts' };
      case 'shelters':
        return { name: 'shelters' };
      case 'settings':
        return { name: 'settings' };
      case 'widget':
        return { name: 'widget-help' };
      default:
        return null;
    }
  } catch {
    return null;
  }
}
