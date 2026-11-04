# SynapseCitySOS console

React 19 + TypeScript console for emergency operations. It is served at
`https://sos.synapsecity.sbs` and talks to the SOS gateway under `/v1`.

This console is part of SynapseCitySOS only. It does not implement city
infrastructure operations; those pages and APIs belong to the sibling
SynapseCity product. See [`../../PRODUCT_BOUNDARY.md`](../../PRODUCT_BOUNDARY.md);
the workspace `FEATURE_BOUNDARY.md` holds the authoritative split.

## Product scope

Owned console areas:

- emergency operations dashboard and command centre;
- before/during/after phase boards;
- rescue operation view per emergency event;
- hazard feeds and the public hazard/emergency map;
- emergency events and public emergency projection;
- EOP plans;
- dispatch orders and responder assignment;
- emergency resource units;
- SITREP and AAR;
- live hazard SSE;
- self-service profile settings.

Not owned and never added here: city assets, city incidents, IoT, maintenance,
technician portal, infrastructure alerts, budgets, operational reports, city
users, geofences, data ingest, public asset map and public incident reporting.
SOS responders are resource units, not City user records.

## Tech stack

- React 19.2, TypeScript 5.9, Vite 7.2
- TanStack Router 1.139 (file-based, type-safe routes)
- TanStack Query 5.90 for server state
- Zustand 5.0 for auth and app state
- Axios 1.13 through `src/lib/httpClient.ts`
- Tailwind CSS 4.1, shadcn/ui primitives, Lucide and Font Awesome icons
- Leaflet 1.9 for the SOS hazard map only

## Routes

```text
/                              SOS landing
/about                         SOS product
/docs                          SOS API docs
/map                           public hazard/emergency map
/login /register               auth shell
/admin                         emergency operations dashboard
/admin/emergency-center        command centre
/admin/emergency-center/before during after
/admin/emergency-center/operations/$eventId
/admin/settings                self-service profile
```

`src/routeTree.gen.ts` is generated from `src/routes/` and must contain only
these owned routes. There is no `/disaster` route; the public hazard map is
`/map`.

## Project structure

```text
src/
├── api/                   API modules and barrel exports
├── components/            shared components (ui/, map, header)
├── hooks/                 custom hooks
├── lib/                   httpClient, queryClient, tile config, utils
├── pages/                 page components (including pages/emergency)
├── routes/                TanStack Router route files
├── stores/                authStore, appStore
├── types/                 SOS domain types
└── routeTree.gen.ts       generated route tree (do not edit)
```

## Getting started

Prerequisites: Node.js 20.19+ or 22.12+ and npm.

```bash
npm ci
npm run dev          # development server
npm run build        # production build
npm run preview      # preview the production build
npm run lint
npm test
```

Environment:

```env
VITE_BASE_API_URL=/v1
VITE_LEADERBOARD_URL=/v1
VITE_TURNSTILE_SITE_KEY=
```

Use the same-origin `/v1` path in production. Do not point the console at a
private service, localhost dependency or the City origin.

## API calls

Always use the configured client:

```ts
import { httpClient } from '@/lib/httpClient';

const events = await httpClient.get('/emergency');
const hazards = await httpClient.get('/hazards/recent');
await httpClient.post('/emergency', {
  title: 'Flood warning',
  severity: 'high',
  status: 'monitoring',
});
```

With TanStack Query:

```ts
const { data, isLoading } = useQuery({
  queryKey: ['emergency-events'],
  queryFn: () => httpClient.get('/emergency').then((response) => response.data),
});
```

The base URL is `/v1`, so paths in calls omit the `/v1` prefix.

Live hazard updates use the SOS SSE endpoint:

```ts
const stream = new EventSource('/v1/emergency/stream/hazards');
stream.onmessage = (message) => {
  // update hazard layers / command-centre state
};
```

## Map

Leaflet and MapLibre render hazard layers and emergency events. Tiles,
autocomplete, geocoding and reverse geocoding go through the SOS backend
(`/v1/map` and `/v1/geo`); the VIETMAP key stays server-side. This is an SOS
instance; do not reuse the City map, geocoding client or database.

## Documentation

- [SOS product boundary](../../PRODUCT_BOUNDARY.md)
- [Tech stack migration](./MIGRATION.md)
- [Quick start](./QUICK_START.md)
- [TanStack Router](https://tanstack.com/router)
- [TanStack Query](https://tanstack.com/query)
- [Zustand](https://docs.pmnd.rs/zustand)
- [shadcn/ui](https://ui.shadcn.com)

## License

Apache-2.0. See the repository `LICENSE`, `NOTICE` and `THIRD-PARTY.md`.
