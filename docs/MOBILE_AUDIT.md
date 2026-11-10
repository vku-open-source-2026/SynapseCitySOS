# SynapseCitySOS Android app + widget — audit

Date: 2026-11-10 22:25 (Asia/Ho_Chi_Minh)
Scope: `mobile/` in this repository, its production integration, SSE and the
native home-screen widget. This revision switches the app and widget to a
light-first theme and re-audits the widget end to end.
Status: **PASS with documented medium/low limitations; no open critical or high
finding.**

## 1. Delivered

| Item | Location |
| --- | --- |
| React Native/Expo app | `mobile/` |
| Native Android widget | `mobile/android/app/src/main/java/sbs/synapsecity/sos/widget/` |
| Release APK (signed, public) | <https://synapsedx.sbs/v1/capabilities/public/files/synapsecity-sos-android-0.1.0-arm64-x86_64/content> |
| APK SHA-256 | `51cb3bd072c09ffce70a9e42c67165cc2a1a545d92a83853065ef0e97bf707f2` |
| Evidence screenshots | `docs/evidence/` |
| Plan | `docs/MOBILE_APP_PLAN.md` |

Package: `sbs.synapsecity.sos`, versionName `0.1.0`, versionCode `1`, minSdk 24,
target/compile SDK 37.

## 2. Design — light-first, based on the web console

The Android UI now follows the warm light palette of the production SOS web
console: `#FFF8F3` cream background, white cards, slate headings, red
`#C2412D` primary actions, orange/amber emphasis and soft shadows. The splash
screen, status bar, tab bar, maps, forms, SOS cards and native widget are light
by default. The web `/`, `/map` and public pages were used as the visual
reference; dark mode is intentionally not enabled in this revision.

## 2. Environment installed

- Node.js 24.18.1, npm 11.16.0.
- Temurin JDK 17.0.21, Android SDK platform 37, build-tools 37.0.0,
  platform-tools 37.0.1, emulator 37.2.13, Google APIs x86_64.
- AVD `SynapseCity_API_36` (Pixel 9, API 36), WHPX acceleration.
- No Android Studio required.

## 3. Build and static verification

| Check | Result |
| --- | --- |
| `npx tsc --noEmit` | pass |
| `npx vitest run` | 11/11 pass (feed health, geometry, labels, links) |
| `node scripts/verify-production.mjs` | pass: 10 hazards, 0 public events, 0 shelters, VIETMAP, City namespace 404 |
| `assembleRelease` | pass |
| GitHub Actions `mobile-build.yml` | pass: unsigned arm64-v8a + x86_64 artifact |
| Production signing/publish | pass: `zipalign` + `apksigner` + Tier-2 files → Tier-1 SynapseOCS |
| APK signature | V2, CN=SynapseSOS, local upload key |
| Boundary grep | no City API/namespace in `mobile/src`; City link is navigation only |

Release minification was disabled after the City build exposed an R8/Room crash
with WorkManager (`WorkDatabase_Impl.<init>`); keep rules were added as well.
The final SOS APK was installed and launched on the emulator with no crash.

## 4. Production verification (SSH + HTTPS)

Host: `synapsedx.sbs`, edge nginx 1.31.8.

- `http://sos.synapsecity.sbs/` → HTTPS (same 301 edge rule).
- TLS 1.3, certificate verification `OK`.
- HSTS, `nosniff`, `DENY`, `no-referrer` on the SOS API response.
- nginx `location ^~ /v1/` → `synapsecity-sos-gateway:8080`,
  `proxy_http_version 1.1` and **`proxy_buffering off`** for SSE.
- `GET /v1/sos` reports product `synapsecity-sos`, `notOwned` includes city
  assets/incidents/IoT/maintenance, auth mode `tier2`, demo disabled.
- `GET /v1/emergency/public/status` → `status=ok`, `data_available=true`,
  `hazard_feed.status=ready`, not stale.
- `GET /v1/hazards` → 10 records with geometry; `recent` also returns 10.
- `GET /v1/emergency/public` → `[]` (honest empty projection).
- `GET /emergency/resources/shelters/near` → zero shelters in 50 km around
  Đà Nẵng, correctly rendered as an empty state, not “safe”.
- `GET /v1/assets` and `/v1/incidents` on the SOS host → `404 not_found`.
- SSE stream response is proxied unbuffered; the app shows the SSE/degraded/
  poll transport state and keeps a last-good snapshot.

Screenshots:
[home](evidence/app-home.jpg), [alerts](evidence/app-alerts.jpg),
[map](evidence/app-map.jpg), [shelters](evidence/app-shelters.jpg),
[emergency](evidence/app-emergency.jpg), [hazard detail](evidence/app-hazard-detail.jpg),
[widget](evidence/widget-home.jpg), [widget stale](evidence/widget-offline.jpg).

## 5. Emulator smoke test

- Feed banner, 10 active hazards, public-event empty state and “not safe”
  disclaimer render correctly in the warm light palette.
- Alert filters/severity/type/search and hazard detail (source link, guidance,
  112 call, share) work.
- Map loads VIETMAP tiles, the national hazard markers and an explicit
  “Vị trí của bạn ngoài vùng dữ liệu Việt Nam” notice when the device is outside
  the country; nearby list honestly shows zero within 100 km.
- Shelter screen shows the 50 km empty state, emergency guidance and a
  Da Nẵng-focused map instead of a blank map when the device is outside coverage.
- Emergency screen shows 112/113/114/115, location sharing and type guidance.
- SSE transport observed as `SSE`/`DỰ PHÒNG`; the app never replaces the REST
  list with a synthetic empty snapshot.
- SOS widget bound card is light, shows feed health, “no warning within
  100 km”, active events and mini-map. **Refresh** reaches production
  (`Cập nhật 0 phút trước`); **SOS** opens the emergency screen.
- With Wi-Fi/data disabled, widget refresh changes to **Không xác định nguồn tin**
  and **Dữ liệu cũ** with the correct age; after reconnecting, refresh returns to
  the green live state.
- Periodic work is scheduled (`dumpsys jobscheduler` shows `SosWidgetWorker`).
- No `FATAL EXCEPTION`, `Error inflating RemoteViews` or React Native red box in
  the final run.

The widget initially failed to inflate because a divider used a plain
`android.view.View` (not allowed in RemoteViews). It was replaced with a
`TextView`; the bound widget then rendered correctly. A stale launcher placeholder
after `adb install -r` was resolved by re-adding the widget; provider metadata and
the bound RemoteViews were verified.

Fixed during this audit:

- **SSE could wipe the hazard list.** A transient/empty `/v1/emergency/stream`
  snapshot was written directly into the React Query cache, making the UI show
  “0 cảnh báo” while `/v1/hazards` still had 10. The stream now merges by hazard
  id and ignores empty snapshots; the REST poll remains authoritative.
- Widget snapshot now filters to 100 km, so a device outside Việt Nam no longer
  shows a 12,000 km hazard as “nearest”.
- Offline widget refresh no longer defers behind a network constraint; it runs,
  marks the snapshot stale and updates the unknown/stale UI immediately.
- Light theme applied to app, maps, splash, system bars and widget.
- SOS widget offline state now checks `!snapshot.online` in addition to feed
  status, so a network failure never leaves a green “Nguồn tin hoạt động” chip.
- Shelters map falls back to the Đà Nẵng coverage view when no shelter exists at
  an out-of-country test location.
- Raw `rain`/`cold` hazard types are localised to Vietnamese.

## 6. Findings

| # | Severity | Finding | Status / mitigation |
| --- | --- | --- | --- |
| S1 | Medium | Emulator has no usable GPS fix; app correctly falls back to Đà Nẵng and labels it. | Physical-device GPS check pending; distance/geometry unit-tested. |
| S2 | Medium | Production has no active public events or nearby shelters at test time, so positive event/shelter detail rendering was only tested with empty states. | Empty states are explicitly non-safe; APIs/shape verified; data-dependent UI remains. |
| S3 | Medium | No positive responder login test (no production credentials used). | Login UI/validation/SecureStore and 401/403 handling present; optional read-only responder query. |
| S4 | Medium | Local notification delivery was not observed end-to-end (no new high/critical hazard arrived during the test window). | Channel, permission, dedupe and widget-worker notification path exist; no server push claimed. |
| S5 | Low | Feed can contain arbitrary hazard type strings (`rain`, `cold`, …); common types are mapped to Vietnamese, unknown ones show raw type. | Add labels as the feed evolves. |
| S6 | Low | Widget refresh minimum 30 min and Doze can delay it. | Manual refresh + foreground sync + stale label. |
| S7 | Low | APK contains arm64-v8a + x86_64 (52 MB). | Use ABI splits/AAB for store distribution. |
| S8 | Low | Windows MAX_PATH can break native codegen in a long checkout. | `scripts/build-android.ps1` mirrors to `C:\r`; documented. |
| S9 | Low | Map requires network for Leaflet/tiles; radar fallback is used. | Explicit map-unavailable state; API data remains real. |
| S10 | Low | Duplicate security headers on the wire from edge + gateway (`nosniff,nosniff`). | Harmless; clean up edge config later. |
| S11 | Low | This build is light-only; there is no in-app dark theme switch. | Intentional for this revision; the web console is the light reference. |
| S12 | Low | `adb install -r` can leave the launcher showing a stale widget placeholder. | Re-add the widget or open the app once; provider metadata and bound RemoteViews verified clean. |
| S13 | Low | The public feed can momentarily return `tier2_unavailable` during Tier-2 maintenance. | The app keeps the last good list, shows feed-health state, and never turns an outage into “safe”. |

No critical or high finding. S1–S4 require physical hardware, production data or
credentials and are listed as remaining verification, not known contract bugs.
S13 is an upstream availability behaviour and is surfaced honestly.

## 7. Boundary and privacy

- No City asset/incident/IoT/maintenance API or import in the SOS mobile source.
- Public events use the redacted projection; no contact/resource fields are
  requested or rendered.
- Responder tokens are in SecureStore; the responder view is read-only.
- An outage/stale feed renders as **Không xác định** / **Dữ liệu cũ**, never
  “an toàn”.
- HTTPS-only; no analytics/ad SDK; widget cache contains public summaries and a
  coarse location only.

## 8. Final result

The stop condition “done” is met: release build and static tests pass, the
production contract and boundary checks pass, app and widget run on the emulator,
the SSH/HTTPS/SSE integration is verified, and there is no critical/high finding.
Remaining medium items are hardware/data/credential-dependent checks and are
documented above.
