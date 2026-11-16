# SOS HITL approvals and mutual aid

## HITL (#24)

Dispatch assignment and EOP publication use the Tier-2 `approvals` capability:

- `POST /v1/emergency/dispatch/:id/approval`
- `POST /v1/emergency/eop/:id/approval`
- `GET /v1/emergency/hitl/approvals` (pending + `escalated` after SLA)
- `POST /v1/emergency/hitl/approvals/:id/decide`
- `POST /v1/emergency/hitl/handoff` (shift handoff package)

Approver roles are derived server-side from `SOS_DISPATCH_APPROVER_ROLES` /
`SOS_EOP_APPROVER_ROLES` (defaults `incident-commander,duty-manager`), never
from client input. With `SOS_HITL_REQUIRED=true`, dispatch assignment and EOP
approval require an approved id and reject self-approval. EOP records
`approved_by`, `approved_role`, `approved_at` and the review note.

SOS owns readiness/compatibility/safety rules; Tier-2 owns roles, SLA, quorum,
decisions and audit. No City API call is made.

## Mutual aid (#23)

- `POST/GET /v1/emergency/mutual-aid/requests`
- `POST /v1/emergency/mutual-aid/requests/:id/accept|decline|handoff`
- `GET /v1/emergency/public/mutual-aid/:id` (public projection)

Accepts are partial/full, check lender capacity, and use optimistic versions so
two concurrent accepts cannot oversubscribe a unit. The public projection omits
contact, requesting agency and precise coordinates. Partner agencies integrate
through this public SOS boundary only.
