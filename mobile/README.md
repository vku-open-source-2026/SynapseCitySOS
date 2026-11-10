# SynapseSOS Android app

Native Android client and home-screen widget for **SynapseCitySOS**
(`https://sos.synapsecity.sbs`). Expo SDK 58 / React Native 0.88, direct
production API at `https://sos.synapsecity.sbs/v1`. The UI is **light-first**
(`#FFF8F3`/white/red), following the production SOS web console palette; the
home-screen widget uses the same warm light visual language.

## What it does

- **Feed health banner** from `/v1/emergency/public/status`; an outage or stale
  feed is shown as **Không xác định**, never as "safe".
- **Nearby hazards** within 100 km using GPS, severity, type and distance.
- **Public hazard map** with hazard geometry, public emergency events and
  shelters, using the production SOS map config (VIETMAP tiles). A native radar
  fallback is used when tiles fail.
- **Hazard feed** with severity/type filters, search and detail pages, including
  the official source link and response guidance.
- **Public emergency events** and a clear guidance screen with 112/113/114/115
  calling and location sharing.
- **Nearby shelters** (`/v1/emergency/resources/shelters/near`) with honest empty
  states and call/directions actions.
- **Foreground hazard SSE** (`/v1/emergency/stream/hazards`) with polling
  fallback and last-good snapshot retention.
- **Local notifications** when a new hazard crosses the chosen severity
  threshold; the widget worker can also notify for a new high/critical hazard.
- **Optional responder login** (email) and a read-only summary of emergency
  events the account may read.
- **Home-screen widget** (4×3): latest hazard, severity/distance, active event
  count, mini map, SOS and refresh actions, explicit stale/unknown labels.

The app never calls SynapseCity APIs, never renders city assets/incidents/IoT
and never imports City code. The City link is public navigation only.

## Build

Prerequisites: Node.js 20+, JDK 17, Android SDK platform 37, build-tools 37.0.0,
platform-tools, emulator or device.

```bash
npm ci
npm run typecheck
npm test
node scripts/verify-production.mjs
npx expo start --dev-client
npx expo run:android
```

Release APK:

```bash
npm run build:android
```

Current release artefact (public, served from Tier-1 SynapseOCS through
Tier-2; CI builds unsigned and the production release job signs it):

```text
https://synapsedx.sbs/v1/capabilities/public/files/synapsecity-sos-android-0.1.0-arm64-x86_64/content
SHA-256 51cb3bd072c09ffce70a9e42c67165cc2a1a545d92a83853065ef0e97bf707f2
```

On Windows the generated CMake paths can exceed `MAX_PATH`. The included
`scripts/build-android.ps1` mirrors the project to `C:\r`, links a short
`node_modules` store (`C:\o\node_modules`) and copies the APK to `mobile/dist/`.

### Signing

`android/keystore.properties` and `android/app/release.keystore` are git-ignored.
A clean checkout falls back to the debug key; add an upload key for store
distribution.

## Widget

Native Kotlin `AppWidgetProvider` + `RemoteViews` + `WorkManager` under
`android/app/src/main/java/.../widget/`. The JS app writes the snapshot through
`WidgetBridge`.

- Tap card / map → nearest hazard detail
- **SOS** → emergency response screen
- **Làm mới** → immediate production refresh
- 30-minute periodic refresh + app foreground sync
- Feed outage/stale >30 min → **Không xác định nguồn tin** or **Dữ liệu cũ**;
  it never claims an all-clear.

## Production contract

`node scripts/verify-production.mjs` checks:

- product identity and SOS-only boundary;
- feed status shape and staleness fields;
- hazard list/recent geometry;
- public emergency projection with no contact/resource PII;
- shelter near endpoint and map config;
- SOS gateway returns `404 not_found` for City namespaces.

## Verification

```bash
npm run typecheck
npm test
npm run verify
npm run build:android
```

Evidence and limitations are in [`../docs/MOBILE_AUDIT.md`](../docs/MOBILE_AUDIT.md).

## Privacy / safety

- HTTPS only; no analytics, ads or tracking SDK.
- No token, GPS or personal data in logs.
- Emergency calls use the system dialer. The app never claims a call or rescue
  request was delivered.
- The app is informational; always follow official instructions. Call 112 when
  life is at risk.

## Licence

Apache-2.0. Copyright 2026 VKU.VIC. See `LICENSE` and `NOTICE` in the repository
root.
