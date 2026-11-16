// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { createFileRoute } from '@tanstack/react-router';
import SosDashboard from '@/pages/SosDashboard';

export const Route = createFileRoute('/admin/')({
  component: SosDashboard,
});
