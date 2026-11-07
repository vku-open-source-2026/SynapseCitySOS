// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { createFileRoute } from '@tanstack/react-router';

import EmergencyCommandCenter from '@/pages/emergency/EmergencyCommandCenter';

export const Route = createFileRoute('/admin/emergency-center/new')({
  component: EmergencyCommandCenter,
});
