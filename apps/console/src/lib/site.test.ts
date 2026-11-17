// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ANDROID_APP_VERSION, LINKS } from './site';

const here = dirname(fileURLToPath(import.meta.url));
const mobileApp = JSON.parse(
  readFileSync(resolve(here, '../../../../mobile/app.json'), 'utf8'),
) as { expo?: { version?: string } };

describe('public release links', () => {
  it('points the Android download at the current mobile release', () => {
    expect(mobileApp.expo?.version).toBeTruthy();
    expect(ANDROID_APP_VERSION).toBe(mobileApp.expo?.version);
    expect(LINKS.androidApk).toContain(`synapsecity-sos-android-${mobileApp.expo?.version}-`);
  });
});
