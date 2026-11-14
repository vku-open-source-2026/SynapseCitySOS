// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import React from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';

import { afterActionApi } from '@/api/after-action-reports';
import { hazardsApi } from '@/api/hazards';
import { resourcesApi } from '@/api/resources';

import { orderedPhaseBoards } from './phaseBoardDefinitions';

const PHASE_SUMMARY: Record<string, string> = {
  before: 'Mức sẵn sàng nguồn lực, cảnh báo đang hoạt động và EOP nháp.',
  during: 'Sự kiện đang xử lý, hàng đợi điều phối và SITREP có validate.',
  after: 'AAR nháp/đã xuất bản, KPI thật và timeline sự kiện.',
};

const EmergencyBoardsLandingPage: React.FC = () => {
  const hazards = useQuery({ queryKey: ['landing', 'hazards'], queryFn: () => hazardsApi.list({ is_active: true, limit: 200 }), retry: 1 });
  const resources = useQuery({ queryKey: ['landing', 'resources'], queryFn: () => resourcesApi.list({ limit: 200 }), retry: 1 });
  const aars = useQuery({ queryKey: ['landing', 'aar'], queryFn: () => afterActionApi.list({ limit: 200 }), retry: 1 });

  const live = {
    hazards: hazards.isError ? null : hazards.data?.length ?? null,
    availableResources: resources.isError ? null : resources.data?.filter((resource) => resource.status === 'available').length ?? null,
    publishedAars: aars.isError ? null : aars.data?.filter((report) => report.status === 'published').length ?? null,
  };

  return (
    <div className="space-y-6 p-4 md:p-6">
      <header className="rounded-xl bg-gradient-to-r from-red-800 via-orange-700 to-amber-600 p-5 text-white shadow-lg">
        <h1 className="text-2xl font-bold md:text-3xl">Bảng điều hành theo giai đoạn</h1>
        <p className="mt-2 text-sm text-white/90 md:text-base">
          Bảng điều hành trước, trong và sau thiên tai. Mỗi bảng hiển thị “—” khi nguồn dữ liệu lỗi.
        </p>
      </header>

      <section className="grid gap-4 sm:grid-cols-3">
        <article className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-amber-800">
          <p className="text-xs font-semibold uppercase tracking-wide">Cảnh báo đang hoạt động</p>
          <p className="mt-2 text-2xl font-bold">{live.hazards ?? '—'}</p>
        </article>
        <article className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-emerald-800">
          <p className="text-xs font-semibold uppercase tracking-wide">Nguồn lực sẵn sàng</p>
          <p className="mt-2 text-2xl font-bold">{live.availableResources ?? '—'}</p>
        </article>
        <article className="rounded-xl border border-indigo-200 bg-indigo-50 p-4 text-indigo-800">
          <p className="text-xs font-semibold uppercase tracking-wide">AAR đã xuất bản</p>
          <p className="mt-2 text-2xl font-bold">{live.publishedAars ?? '—'}</p>
        </article>
      </section>

      <section className="grid gap-4 lg:grid-cols-3">
        {orderedPhaseBoards.map((board) => (
          <article key={board.phase} className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Giai đoạn {board.tabLabel}</p>
            <h2 className="mt-2 text-xl font-bold text-slate-900">{board.title}</h2>
            <p className="mt-2 text-sm text-slate-600">{board.subtitle}</p>
            <p className="mt-3 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700">
              {PHASE_SUMMARY[board.phase] ?? ''}
            </p>
            <Link
              to={board.routePath}
              className="mt-4 inline-flex rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-800 hover:bg-slate-100"
            >
              Mở bảng {board.tabLabel}
            </Link>
          </article>
        ))}
      </section>

      <section className="rounded-xl border border-sky-200 bg-sky-50 p-4 text-sm text-sky-900 shadow-sm">
        <h2 className="text-base font-semibold">Nguồn dữ liệu</h2>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          <li>Dữ liệu được tổng hợp từ sự kiện khẩn cấp, cảnh báo, nguồn lực, SITREP và báo cáo sau sự kiện.</li>
          <li>Khi một nguồn lỗi, bảng hiển thị “—” và banner suy giảm thay vì số 0 giả.</li>
        </ul>
      </section>
    </div>
  );
};

export default EmergencyBoardsLandingPage;
