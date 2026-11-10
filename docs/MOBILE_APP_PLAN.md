# SynapseCitySOS Android app + home-screen widget — implementation plan

Status: completed 2026-11-10 (see `docs/MOBILE_AUDIT.md` for documented hardware/data limitations)
Owner: VKU.VIC
Scope: `mobile/` in this repository. The web console and its API contracts remain
authoritative.

## 1. Stop conditions

Work stops only when one of these is true:

1. **Done**: every item in §11 (Definition of Done) is checked, both debug and
   release APKs build, the app has been exercised against production on an
   Android emulator, the home-screen widget has been exercised, and the audit in
   `docs/MOBILE_AUDIT.md` has no open critical/high finding.
2. **Hard deadline**: 07:30 Asia/Ho_Chi_Minh on 2026-11-10. If the deadline is
   reached, stop, write an honest hand-off in `docs/MOBILE_AUDIT.md`, and list
   exactly what remains.

No other reason is a stop condition. A failing build, a missing tool, an API
mismatch or an emulator problem is a task to solve, not a reason to stop.

## 2. Product boundary (non-negotiable)

SynapseCitySOS owns emergency operations. The mobile app may use only:

```text
GET  /v1/sos
GET  /v1/hazards, /v1/hazards/recent, /v1/hazards/geo/near
GET  /v1/hazards/ingest/status
GET  /v1/emergency/public, /v1/emergency/public/status
GET  /v1/emergency/resources/shelters/near
GET  /v1/emergency/stream/hazards (SSE; foreground only)
*    /v1/auth, /v1/emergency, /v1/emergency/eop|dispatch|resources|sitrep|
     after-action only after an authenticated SOS session
```

The app must never call `synapsecity.sbs` APIs, import City code, render city
assets, city incidents, IoT, maintenance, budgets, reports, city users or
geofences. A link to `https://synapsecity.sbs` is public navigation only.

## 3. What already exists

- Production web console: `https://sos.synapsecity.sbs`.
- Production API: `https://sos.synapsecity.sbs/v1` behind the SOS gateway/nginx.
- Public hazard feed with recent items, hazard geo search and the NCHMF/VNDMS
  ingestion status.
- Public emergency projection/status; empty is a valid state but must never be
  shown as "safe".
- Nearby shelters endpoint (may return zero shelters).
- SSE hazard stream for foreground live updates.
- SOS auth is email-based (Tier-2 identity).

## 4. Mobile architecture

- **Runtime**: Expo SDK 58 / React Native 0.88, TypeScript, Android first.
- **Visuals**: light-first default (`#FFF8F3`/white/red), based on the
  production SOS web console; light splash, system bars and native widget.
- **Location**: `expo-location` (foreground + last known).
- **Map**: bundled WebView + Leaflet/OSM, with a native SVG radar fallback.
  Hazard polygons/points and event geometry come only from the SOS API.
- **Live updates**: foreground SSE through `react-native-sse`/fetch stream with
  last-good-snapshot retention; background uses a widget worker poll.
- **Storage**: `expo-secure-store` for tokens; AsyncStorage for preferences and
  the widget snapshot.
- **Data**: typed API client against `/v1`; React Query cache; no mocks in
  production builds.
- **Navigation**: a lightweight typed router owned by the app (React
  Navigation was intentionally not added: it pulls extra native codegen into an
  already path-constrained Windows build). It supports tab roots, a detail
  stack, Android back handling and deep links.
- **Notifications**: local notification when a new hazard at/above the chosen
  severity is observed. Widget worker can notify for critical hazards. No server
  push is invented; the production notification channel is unavailable.
- **Widget**: native Android `AppWidgetProvider` + `RemoteViews` +
  `WorkManager`, sharing the same HTTPS API and JSON cache.

```text
mobile/
  app.json
  App.tsx
  src/
    api/            typed production client + endpoint tests
    components/     UI, map, radar, severity chips
    hooks/          location, hazard stream, notifications, widget sync
    screens/        Home, Map, Alerts, Shelters, Emergency, Account, Settings
    navigation/
    lib/            formatting, geo, severity, widget bridge
  android/          generated Expo project + native widget sources
```

## 5. Feature matrix

| Capability | In app | In widget |
| --- | --- | --- |
| Feed/ingest status | yes | status dot |
| Nearby hazards (GPS, radius) | list + map | mini-map + top hazard |
| Recent hazard feed / detail | yes | top 2 |
| Public emergency events/detail | yes | active count |
| Emergency instructions | yes | no |
| Nearby shelters | list + map + call | nearest shelter |
| SOS quick actions (112/113/114/115) | yes | SOS button |
| Notifications (local, severity threshold) | yes | critical hazard |
| Optional responder login (read-only summary) | yes | no |
| Settings / refresh / about | yes | refresh action |
| City public navigation | link only | no |
| Offline/feed outage | "không xác định", never "safe" | "stale" label |

## 6. Production wiring

- Base URL is compiled to `https://sos.synapsecity.sbs` (overridable only by an
  explicit `EXPO_PUBLIC_API_BASE_URL` build env for local testing).
- Startup checks `GET /v1/sos`, validates product/tier and refuses to label the
  app "online" when the check fails.
- `GET /v1/emergency/public/status` is the feed health source. An empty event
  list is "no active events", never "safe".
- SSE is foreground only; reconnect with backoff; keep the last good snapshot
  and mark it stale.
- Auth tokens never leave SecureStore in logs. No token in URLs.
- Production nginx is inspected over SSH (`synapsedx.sbs`) to confirm:
  HTTPS redirect/HSTS, `/v1/` proxy target, SSE buffering settings, public route
  exposure, response headers. Findings go in `docs/MOBILE_AUDIT.md`.

## 7. Widget specification (Locket-style)

Visual: 4x4 (resizable 4x2–4x4) rounded card, deep navy/red accent, large hazard
or emergency headline, severity chip, mini-map bitmap with user position and
hazard/event/shelter markers, and a "SOS" action.

Interactions:

- tap card → open Home;
- tap hazard row → hazard detail;
- **SOS** → open emergency actions in app;
- **Refresh** → WorkManager fetch hazards + public events, update cache;
- stale (>30 min) or offline → show "Dữ liệu cũ" + timestamp; feed outage shows
  "Không xác định", never a green "safe" state.

Updates: every 30 min via WorkManager, on app foreground sync, on boot, and on
manual refresh. Location comes from the app's last foreground fix; when absent,
the widget says it is using the default city centre.

## 8. Security, privacy, accessibility

- HTTPS only; cleartext traffic disabled.
- No secrets, tokens, GPS or PII in logs/analytics.
- Emergency calls use `tel:` intents; the app never claims a call succeeded.
- Widget cache stores only public hazard/event summaries + coarse location.
- Runtime permissions requested with rationale; denial leaves the app usable.
- Content descriptions, 48dp touch targets, dynamic font scaling where
  practical, Vietnamese-first copy with English fallback.
- Never render a feed outage as "safe"; use explicit unknown/stale states.

## 9. Build environment

- JDK 17 (Temurin), Android SDK command-line tools, platform 36, build-tools 36,
  platform-tools, emulator, Google APIs x86_64 system image.
- AVD `SynapseSOS_API_36`; boot with WHPX when available, otherwise software GPU
  and document the limitation.
- Debug + release APK (`assembleDebug`, `assembleRelease` with a local upload
  keystore that is git-ignored). APK paths and SHA-256 recorded in the audit.

## 10. Verification plan

1. Unit: geo distance/bearing, geometry extraction (Point/Line/Polygon),
   severity ranking, feed-health mapping, SSE line parser, stale-state logic.
2. Contract: a Node script hits production endpoints and asserts the exact
   fields the app consumes; fails on shape drift.
3. Build: TypeScript check, Android lint, unit tests, debug APK, release APK.
4. Emulator: install, launch, grant location, set Da Nang coordinates, verify
   nearby hazards, map layers, shelters empty state, emergency detail, offline
   banner, widget bind/update screenshot, notification permission flow.
5. Production audit: nginx config, headers, TLS, SSE buffering, API status
   codes, no City data in SOS app; screenshot/evidence list.

## 11. Definition of Done

- [x] `docs/MOBILE_APP_PLAN.md` and `docs/MOBILE_AUDIT.md` present in the repo.
- [x] `mobile/` builds from a clean checkout with documented commands.
- [x] No cross-product API/import; boundary grep is clean.
- [x] Home, Map, Alerts, Shelters, Emergency, Account, Settings implemented.
- [x] Nearby hazards use real GPS when available and production data; emulator fallback is labelled (see audit).
- [x] Public events, feed health and shelters use real production data.
- [x] Widget displays hazards/events + mini-map and refreshes against production.
- [x] Feed outage/empty/stale states are honest; never "safe" on outage.
- [x] TypeScript, unit tests, contract test and release APK pass.
- [x] Emulator smoke test with screenshots and `uiautomator` evidence.
- [x] Audit has no open critical/high item; medium items are documented.
- [x] APK checksum and install instructions in `mobile/README.md`.

## 12. Risks

| Risk | Mitigation |
| --- | --- |
| Emulator acceleration unavailable | Try WHPX; fall back to software GPU; still build and document. |
| OSM tiles blocked/offline | Radar fallback + explicit map-unavailable state. |
| Empty public event/shelter data | Design empty states that say "no active record", not "safe". |
| SSE buffering/proxy | Inspect nginx; foreground fallback polling every 60 s. |
| Widget background limits | WorkManager 30 min + manual refresh + app foreground sync. |
| Android 13+ notification permission | Request at the right moment; graceful denial. |
| API shape drift | Contract test; tolerant parsers with explicit error states. |
| Time | Public hazard/event/shelter path first, responder auth second, polish last. |
