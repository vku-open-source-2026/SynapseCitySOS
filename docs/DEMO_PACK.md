# SynapseCitySOS OLP 2026 DX-Lab demo pack

A reproducible 15-minute emergency-operations story that shows H-P-D-I, the
Tier-2 HITL contract and the strict SOS-only boundary.

## Prerequisites

1. SynapseOne and SynapseDX are healthy at their public HTTPS URLs.
2. SOS is running (`docker compose up -d` or `npm run start:service`).
3. An incident-commander/duty-manager session token is available as
   `SOS_DEMO_TOKEN` (or pass it in the environment). Never commit the token.

## One-command seed

```bash
SOS_DEMO_TOKEN=... npm run demo:seed
```

The script is idempotent: it reuses the stable demo ids and updates existing
records. Reset with:

```bash
SOS_DEMO_TOKEN=... npm run demo:reset
```

## 15-minute script

| Minute | Lane | Action | Visible result |
| --- | --- | --- | --- |
| 0–2 | Context | Open `/v1/sos` | SOS feature list; City features are marked not owned |
| 2–4 | Hazard ingest | `POST /v1/hazards/ingest` or open the public hazard map | Hazard appears on the public map within the TTL |
| 4–6 | H (Human) | Create/refresh emergency event `SOS-DEMO-EVENT` | Incident command record and public status |
| 6–8 | P (Process) | `POST /v1/emergency/dispatch/SOS-DEMO-DISPATCH/approval` | Tier-2 approval id, pending, due in 15 minutes |
| 8–10 | HITL gate | Approve as a different duty manager, then `POST .../approve` with `approval_id` | Assignment succeeds; self-approval is refused; roles/time/note recorded |
| 10–12 | P (Process) | `POST /v1/emergency/eop/SOS-DEMO-EOP/approval` then approve and publish | EOP records approver, role, time and note |
| 12–14 | D (Data) | Publish a SITREP and open the public status | SITREP version/delta visible; public projection has no PII |
| 14–15 | AAR | `POST /v1/emergency/after-action/generate` | AAR with SLA breaches and handoff notes |

## Mutual-aid exercise (optional +5 minutes)

1. `POST /v1/emergency/mutual-aid/requests` with a resource type, quantity and
   contact.
2. Accept partially as a partner agency; verify `filled_quantity` and resource
   availability both change.
3. Retry the same accept with a stale `expected_version`; expect `409`.
4. Open `/v1/emergency/public/mutual-aid/:id`; confirm contact, agency and
   precise coordinates are absent.
5. Run `POST /v1/emergency/hitl/handoff` for shift handoff; pending/escalated
   approvals are packaged for the incoming duty manager.

## Evidence checklist

- [ ] Dispatch without `approval_id` returns `428 approval_required` when
      `SOS_HITL_REQUIRED=true`.
- [ ] Self-approval returns `403 self_approval_forbidden`.
- [ ] Rejected approval cannot assign a dispatch/EOP.
- [ ] Overdue approvals show `escalated: true`.
- [ ] EOP publication has `approved_by`, `approved_role`, `approved_at` and note.
- [ ] Public mutual-aid projection has no phone/email/agency/coordinates.
- [ ] `GET /v1/sos` never lists City-owned features as SOS features.
- [ ] Production uses `SYNAPSEDX_BASE_URL=https://synapsedx.sbs` (public HTTPS).

## Screenshots

Capture and link: public hazard map, dispatch approval lane, EOP approval,
SITREP public status, mutual-aid public projection, AAR summary.
