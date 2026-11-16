// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { describe, expect, it } from 'vitest';
import {
  WORKSPACE_URL,
  isMovedWorkspacePath,
  isPublicProductPath,
  workspaceRedirectHref,
} from './workspace';

describe('isMovedWorkspacePath', () => {
  it.each([
    '/login',
    '/login/',
    '/register',
    '/admin',
    '/admin/',
    '/admin/emergency-center',
    '/admin/emergency-center/during',
    '/admin/emergency-center/operations/evt-1',
    '/technician',
    '/workspace',
    '/workspace/builder',
  ])('redirects %s', (path) => {
    expect(isMovedWorkspacePath(path)).toBe(true);
  });

  it.each([
    '/',
    '/map',
    '/about',
    '/docs',
    '/administrator',
    '/login-help',
    '/adminx/emergency-center',
  ])('keeps public path %s', (path) => {
    expect(isMovedWorkspacePath(path)).toBe(false);
  });
});

describe('workspaceRedirectHref', () => {
  it('keeps every public page on this origin', () => {
    expect(workspaceRedirectHref('/')).toBeNull();
    expect(workspaceRedirectHref('/map')).toBeNull();
    expect(workspaceRedirectHref('/map?event=evt-1')).toBeNull();
    expect(workspaceRedirectHref('/about')).toBeNull();
    expect(workspaceRedirectHref('/docs')).toBeNull();
  });

  it('sends every retired path to one fixed DX URL', () => {
    expect(workspaceRedirectHref('/login')).toBe(WORKSPACE_URL);
    expect(workspaceRedirectHref('/admin/emergency-center')).toBe(WORKSPACE_URL);
    expect(workspaceRedirectHref('/admin/emergency-center/before')).toBe(WORKSPACE_URL);
    expect(workspaceRedirectHref('/workspace')).toBe(WORKSPACE_URL);
    expect(WORKSPACE_URL).toBe('https://synapsedx.sbs/workspace');
  });

  it('never copies query values, credentials or return targets', () => {
    const href = workspaceRedirectHref('/login?redirect=%2Fmap&refresh_token=super-secret');
    expect(href).toBe(WORKSPACE_URL);
    expect(href).not.toContain('?');
    expect(href).not.toContain('super-secret');
    expect(workspaceRedirectHref('/admin/emergency-center?next=%2Fmap')).toBe(WORKSPACE_URL);
  });
});

describe('isPublicProductPath', () => {
  it('covers the public surface only', () => {
    expect(isPublicProductPath('/')).toBe(true);
    expect(isPublicProductPath('/map')).toBe(true);
    expect(isPublicProductPath('/admin/emergency-center')).toBe(false);
  });
});
