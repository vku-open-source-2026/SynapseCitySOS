// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
// Keep in sync with mobile/app.json; site.test.ts fails the build when the
// published APK link drifts from the current mobile release.
export const ANDROID_APP_VERSION = "0.1.2";

export const LINKS = {
    androidApk: `https://synapsedx.sbs/v1/capabilities/public/files/synapsecity-sos-android-${ANDROID_APP_VERSION}-arm64-x86_64/content`,
    repo: "https://github.com/vku-open-source-2026/SynapseCitySOS",
} as const;
