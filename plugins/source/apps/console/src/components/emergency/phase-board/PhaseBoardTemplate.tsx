// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import React from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { isAxiosError } from 'axios';

import { afterActionApi } from '@/api/after-action-reports';
import { dispatchApi } from '@/api/dispatch';
import { emergencyApi } from '@/api/emergency';
import { eopApi } from '@/api/eop';
import { hazardsApi } from '@/api/hazards';
import { resourcesApi } from '@/api/resources';
import { sitrepApi } from '@/api/sitrep';
import { orderedPhaseBoards } from '@/pages/emergency/phases/phaseBoardDefinitions';
import type { PhaseBoardDefinition } from '@/types/emergency-phase-board';
import type { AfterActionReport } from '@/types/after-action-report';
import type { ResourceType, ResourceUnit } from '@/types/resource-unit';

interface PhaseBoardTemplateProps {
  board: PhaseBoardDefinition;
}

const RESOURCE_TYPE_LABEL: Record<ResourceType, string> = {
  personnel: 'Đội ứng cứu',
  vehicle: 'Phương tiện',
  medical_supply: 'Vật tư y tế',
  rescue_equipment: 'Thiết bị cứu hộ',
  shelter: 'Nơi trú ẩn',
};

function formatDateTime(value?: string | null): string {
  if (!value) return '--';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '--' : date.toLocaleString('vi-VN');
}

function errorMessage(error: unknown): string {
  if (isAxiosError<{ message?: string; error?: string; details?: Array<{ field: string; message: string }> }>(error)) {
    const details = error.response?.data?.details;
    if (Array.isArray(details) && details.length > 0) {
      return details.map((detail) => `${detail.field}: ${detail.message}`).join('; ');
    }
    return error.response?.data?.message || error.response?.data?.error || error.message;
  }
  return error instanceof Error ? error.message : 'Yêu cầu thất bại';
}

const KpiCard: React.FC<{ label: string; value: React.ReactNode; tone: string; unavailable?: boolean }> = ({ label, value, tone, unavailable }) => (
  <article className={`rounded-xl border p-4 shadow-sm ${tone}`}>
    <p className="text-xs font-semibold uppercase tracking-wide">{label}</p>
    <p className="mt-2 text-2xl font-bold">{unavailable ? '—' : value}</p>
  </article>
);

const PhaseBoardTemplate: React.FC<PhaseBoardTemplateProps> = ({ board }) => {
  const queryClient = useQueryClient();
  const [busy, setBusy] = React.useState(false);
  const [feedback, setFeedback] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const eventsQuery = useQuery({ queryKey: ['phase', 'events'], queryFn: () => emergencyApi.list({ limit: 200 }), retry: 1 });
  const hazardsQuery = useQuery({ queryKey: ['phase', 'hazards'], queryFn: () => hazardsApi.list({ is_active: true, limit: 200 }), retry: 1 });
  const eopQuery = useQuery({ queryKey: ['phase', 'eop'], queryFn: () => eopApi.list({ limit: 200 }), retry: 1 });
  const dispatchQuery = useQuery({ queryKey: ['phase', 'dispatch'], queryFn: () => dispatchApi.list({ limit: 200 }), retry: 1 });
  const resourcesQuery = useQuery({ queryKey: ['phase', 'resources'], queryFn: () => resourcesApi.list({ limit: 200 }), retry: 1 });
  const sitrepQuery = useQuery({ queryKey: ['phase', 'sitrep'], queryFn: () => sitrepApi.list({ limit: 200 }), retry: 1 });
  const aarQuery = useQuery({ queryKey: ['phase', 'aar'], queryFn: () => afterActionApi.list({ limit: 200 }), retry: 1 });

  const events = eventsQuery.data ?? [];
  const hazards = hazardsQuery.data ?? [];
  const eops = eopQuery.data ?? [];
  const orders = dispatchQuery.data ?? [];
  const resources = resourcesQuery.data ?? [];
  const sitreps = sitrepQuery.data ?? [];
  const aars = aarQuery.data ?? [];

  const hasError = [eventsQuery, hazardsQuery, eopQuery, dispatchQuery, resourcesQuery, sitrepQuery, aarQuery].some((query) => query.isError);
  const activeEvents = events.filter((event) => event.status === 'active');
  const resolvedEvents = events.filter((event) => ['resolved', 'canceled'].includes(event.status));
  const criticalHazards = hazards.filter((hazard) => hazard.severity === 'critical');
  const openOrders = orders.filter((order) => !['completed', 'canceled'].includes(order.status));
  const pendingOrders = orders.filter((order) => order.status === 'pending');
  const availableResources = resources.filter((resource) => resource.status === 'available');
  const blockedResources = resources.filter((resource) => ['offline', 'maintenance'].includes(resource.status));
  const draftAars = aars.filter((report) => report.status === 'draft');
  const publishedAars = aars.filter((report) => report.status === 'published');

  const invalidateAll = () => {
    for (const key of ['events', 'hazards', 'eop', 'dispatch', 'resources', 'sitrep', 'aar']) {
      void queryClient.invalidateQueries({ queryKey: ['phase', key] });
    }
  };

  const run = async (action: () => Promise<string>) => {
    setBusy(true);
    setError(null);
    setFeedback(null);
    try {
      setFeedback(await action());
      invalidateAll();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6 p-4 md:p-6">
      <header className="rounded-xl bg-gradient-to-r from-slate-900 via-slate-700 to-slate-600 p-5 text-white shadow-lg">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold md:text-3xl">{board.title}</h1>
            <p className="mt-2 text-sm text-white/90 md:text-base">{board.subtitle}</p>
          </div>
          <span className="rounded-md border border-white/40 bg-white/10 px-3 py-1.5 text-xs font-semibold uppercase tracking-wide">
            Bảng trực SOS
          </span>
        </div>
      </header>

      <nav className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
        <div className="flex flex-wrap items-center gap-2">
          <Link to="/admin/emergency-center" className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-100">
            Danh sách bảng
          </Link>
          {orderedPhaseBoards.map((phaseBoard) => (
            <Link
              key={phaseBoard.phase}
              to={phaseBoard.routePath}
              className="rounded-md border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-100"
              activeProps={{ className: 'rounded-md border border-blue-300 bg-blue-50 px-3 py-1.5 text-sm font-medium text-blue-700' }}
              activeOptions={{ exact: true }}
            >
              {phaseBoard.tabLabel}
            </Link>
          ))}
        </div>
      </nav>

      {hasError ? (
        <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          Một số chỉ số không khả dụng vì nguồn SOS đang lỗi. Các ô hiển thị “—” thay vì số 0 giả.
        </div>
      ) : null}
      {error ? <div className="rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div> : null}
      {feedback ? <div className="rounded-lg border border-emerald-300 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{feedback}</div> : null}

      {board.phase === 'before' ? (
        <>
          <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
            <KpiCard label="Nguồn lực sẵn sàng" value={availableResources.length} tone="border-emerald-200 bg-emerald-50 text-emerald-700" unavailable={resourcesQuery.isError} />
            <KpiCard label="Nguồn lực bị chặn" value={blockedResources.length} tone="border-rose-200 bg-rose-50 text-rose-700" unavailable={resourcesQuery.isError} />
            <KpiCard label="Cảnh báo đang hoạt động" value={hazards.length} tone="border-amber-200 bg-amber-50 text-amber-700" unavailable={hazardsQuery.isError} />
            <KpiCard label="EOP nháp" value={eops.filter((plan) => plan.status === 'draft').length} tone="border-sky-200 bg-sky-50 text-sky-700" unavailable={eopQuery.isError} />
            <KpiCard label="Sự kiện theo dõi" value={events.filter((event) => event.status === 'monitoring').length} tone="border-slate-200 bg-slate-50 text-slate-700" unavailable={eventsQuery.isError} />
          </section>

          <section className="grid gap-6 xl:grid-cols-[1.2fr_1fr]">
            <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
              <h2 className="text-lg font-semibold text-slate-900">Sẵn sàng nguồn lực</h2>
              <p className="mt-1 text-sm text-slate-600">Đơn vị cứu hộ, phương tiện, vật tư, thiết bị và nơi trú ẩn.</p>
              <div className="mt-4 overflow-x-auto">
                <table className="min-w-full text-left text-sm text-slate-700">
                  <thead className="border-y border-slate-200 bg-slate-50 text-xs text-slate-600">
                    <tr>
                      <th className="px-3 py-2 font-medium">Tên</th>
                      <th className="px-3 py-2 font-medium">Loại</th>
                      <th className="px-3 py-2 font-medium">Khu vực</th>
                      <th className="px-3 py-2 font-medium">Trạng thái</th>
                    </tr>
                  </thead>
                  <tbody>
                    {resources.slice(0, 15).map((resource) => (
                      <tr key={resource.id} className="border-b border-slate-100 last:border-b-0">
                        <td className="px-3 py-2 font-medium text-slate-900">{resource.name}</td>
                        <td className="px-3 py-2">{RESOURCE_TYPE_LABEL[resource.resource_type] ?? resource.resource_type}</td>
                        <td className="px-3 py-2">{resource.district || '--'}</td>
                        <td className="px-3 py-2">{resource.status}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {resources.length === 0 ? <p className="mt-3 text-sm text-slate-500">Chưa có nguồn lực. Tạo đơn vị đầu tiên bên cạnh.</p> : null}
              </div>
            </div>

            <form
              className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm"
              onSubmit={(event) => {
                event.preventDefault();
                const formElement = event.currentTarget;
                const form = new FormData(formElement);
                void run(async () => {
                  const created = await resourcesApi.create({
                    resource_code: String(form.get('resource_code') || `RU-${Date.now()}`),
                    name: String(form.get('name') || ''),
                    resource_type: String(form.get('resource_type') || 'personnel') as ResourceType,
                    status: String(form.get('status') || 'available') as ResourceUnit['status'],
                    district: String(form.get('district') || '') || undefined,
                    capacity: Number(form.get('capacity') || 0) || undefined,
                    skills: String(form.get('skills') || '').split(',').map((skill) => skill.trim()).filter(Boolean),
                  });
                  formElement.reset();
                  return `Đã tạo nguồn lực ${created.name}.`;
                });
              }}
            >
              <h2 className="text-lg font-semibold text-slate-900">Thêm nguồn lực</h2>
              <div className="mt-3 space-y-3 text-sm">
                <label className="block">
                  <span className="text-xs font-medium text-slate-600">Tên</span>
                  <input name="name" required className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5" />
                </label>
                <label className="block">
                  <span className="text-xs font-medium text-slate-600">Mã</span>
                  <input name="resource_code" placeholder="RU-001" className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5" />
                </label>
                <div className="grid grid-cols-2 gap-2">
                  <label className="block">
                    <span className="text-xs font-medium text-slate-600">Loại</span>
                    <select name="resource_type" className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5">
                      {Object.entries(RESOURCE_TYPE_LABEL).map(([value, label]) => (
                        <option key={value} value={value}>{label}</option>
                      ))}
                    </select>
                  </label>
                  <label className="block">
                    <span className="text-xs font-medium text-slate-600">Trạng thái</span>
                    <select name="status" className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5">
                      {['available', 'standby', 'deployed', 'offline', 'maintenance'].map((status) => (
                        <option key={status} value={status}>{status}</option>
                      ))}
                    </select>
                  </label>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <label className="block">
                    <span className="text-xs font-medium text-slate-600">Quận/huyện</span>
                    <input name="district" className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5" />
                  </label>
                  <label className="block">
                    <span className="text-xs font-medium text-slate-600">Sức chứa</span>
                    <input name="capacity" type="number" min={0} className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5" />
                  </label>
                </div>
                <label className="block">
                  <span className="text-xs font-medium text-slate-600">Kỹ năng (phân tách bằng dấu phẩy)</span>
                  <input name="skills" className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5" />
                </label>
                <button type="submit" disabled={busy} className="w-full rounded-md bg-slate-900 px-3 py-2 text-sm font-semibold text-white disabled:opacity-60">
                  {busy ? 'Đang tạo...' : 'Tạo nguồn lực'}
                </button>
              </div>
            </form>
          </section>
        </>
      ) : null}

      {board.phase === 'during' ? (
        <>
          <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
            <KpiCard label="Sự kiện đang xử lý" value={activeEvents.length} tone="border-red-200 bg-red-50 text-red-700" unavailable={eventsQuery.isError} />
            <KpiCard label="Cảnh báo nghiêm trọng" value={criticalHazards.length} tone="border-rose-200 bg-rose-50 text-rose-700" unavailable={hazardsQuery.isError} />
            <KpiCard label="Điều phối đang mở" value={openOrders.length} tone="border-blue-200 bg-blue-50 text-blue-700" unavailable={dispatchQuery.isError} />
            <KpiCard label="Chờ phân công" value={pendingOrders.length} tone="border-amber-200 bg-amber-50 text-amber-700" unavailable={dispatchQuery.isError} />
            <KpiCard label="SITREP đã xuất bản" value={sitreps.filter((sitrep) => sitrep.status === 'published').length} tone="border-emerald-200 bg-emerald-50 text-emerald-700" unavailable={sitrepQuery.isError} />
          </section>

          <section className="grid gap-6 xl:grid-cols-[1.1fr_1fr]">
            <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
              <h2 className="text-lg font-semibold text-slate-900">Hàng đợi điều phối</h2>
              <div className="mt-3 space-y-2 text-sm">
                {openOrders.slice(0, 12).map((order) => (
                  <article key={order.id} className="rounded-md border border-slate-200 p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="font-medium text-slate-900">{order.task_title}</p>
                      <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700">{order.status}</span>
                    </div>
                    <p className="mt-1 text-xs text-slate-500">
                      {order.priority} • ETA {order.eta_minutes ?? '--'} phút •{' '}
                      <Link to="/admin/emergency-center/operations/$eventId" params={{ eventId: order.emergency_event_id }} className="text-blue-600">
                        mở sự kiện
                      </Link>
                    </p>
                  </article>
                ))}
                {openOrders.length === 0 ? <p className="text-slate-500">Không có lệnh điều phối đang mở.</p> : null}
              </div>
            </div>

            <div className="space-y-4">
              <form
                className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm"
                onSubmit={(event) => {
                  event.preventDefault();
                  const form = new FormData(event.currentTarget);
                  const start = String(form.get('period_start') || '');
                  const end = String(form.get('period_end') || '');
                  void run(async () => {
                    const sitrep = await sitrepApi.create({
                      emergency_event_id: String(form.get('event_id') || ''),
                      title: String(form.get('title') || ''),
                      reporting_period_start: new Date(start).toISOString(),
                      reporting_period_end: new Date(end).toISOString(),
                      snapshot: { summary: String(form.get('summary') || '') },
                      numbers: {
                        casualties: Number(form.get('casualties') || 0),
                        affected_people: Number(form.get('affected_people') || 0),
                        evacuated_people: Number(form.get('evacuated_people') || 0),
                      },
                    });
                    return `Đã tạo SITREP ${sitrep.id} cho sự kiện.`;
                  });
                }}
              >
                <h2 className="text-lg font-semibold text-slate-900">Soạn SITREP</h2>
                <div className="mt-3 space-y-3 text-sm">
                  <label className="block">
                    <span className="text-xs font-medium text-slate-600">Sự kiện</span>
                    <select name="event_id" required className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5">
                      <option value="">Chọn sự kiện</option>
                      {activeEvents.map((event) => (
                        <option key={event.id} value={event.id}>{event.event_code || event.id} — {event.title}</option>
                      ))}
                    </select>
                  </label>
                  <label className="block">
                    <span className="text-xs font-medium text-slate-600">Tiêu đề</span>
                    <input name="title" required className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5" />
                  </label>
                  <div className="grid grid-cols-2 gap-2">
                    <label className="block">
                      <span className="text-xs font-medium text-slate-600">Bắt đầu kỳ</span>
                      <input name="period_start" type="datetime-local" required className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5" />
                    </label>
                    <label className="block">
                      <span className="text-xs font-medium text-slate-600">Kết thúc kỳ</span>
                      <input name="period_end" type="datetime-local" required className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5" />
                    </label>
                  </div>
                  <label className="block">
                    <span className="text-xs font-medium text-slate-600">Tóm tắt hiện trường</span>
                    <textarea name="summary" rows={2} className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5" />
                  </label>
                  <div className="grid grid-cols-3 gap-2">
                    <label className="block">
                      <span className="text-xs font-medium text-slate-600">Thương vong</span>
                      <input name="casualties" type="number" min={0} defaultValue={0} className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5" />
                    </label>
                    <label className="block">
                      <span className="text-xs font-medium text-slate-600">Bị ảnh hưởng</span>
                      <input name="affected_people" type="number" min={0} defaultValue={0} className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5" />
                    </label>
                    <label className="block">
                      <span className="text-xs font-medium text-slate-600">Sơ tán</span>
                      <input name="evacuated_people" type="number" min={0} defaultValue={0} className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5" />
                    </label>
                  </div>
                  <button type="submit" disabled={busy} className="w-full rounded-md bg-slate-900 px-3 py-2 text-sm font-semibold text-white disabled:opacity-60">
                    {busy ? 'Đang lưu...' : 'Tạo SITREP nháp'}
                  </button>
                </div>
              </form>

              <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
                <h2 className="text-lg font-semibold text-slate-900">SITREP gần đây</h2>
                <div className="mt-3 space-y-2 text-sm">
                  {sitreps.slice(0, 8).map((sitrep) => (
                    <article key={sitrep.id} className="rounded-md border border-slate-200 p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="font-medium text-slate-900">{sitrep.title}</p>
                        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700">{sitrep.status}</span>
                      </div>
                      <p className="mt-1 text-xs text-slate-500">
                        {sitrep.emergency_event_id} • {formatDateTime(sitrep.reporting_period_start)} → {formatDateTime(sitrep.reporting_period_end)}
                      </p>
                      {sitrep.status !== 'published' ? (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void run(async () => {
                            await sitrepApi.update(sitrep.id, { status: 'review_pending' });
                            await sitrepApi.publish(sitrep.id);
                            return 'Đã review và publish SITREP.';
                          })}
                          className="mt-2 rounded-md border border-emerald-300 bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700"
                        >
                          Xuất bản
                        </button>
                      ) : null}
                    </article>
                  ))}
                  {sitreps.length === 0 ? <p className="text-slate-500">Chưa có SITREP.</p> : null}
                </div>
              </div>
            </div>
          </section>
        </>
      ) : null}

      {board.phase === 'after' ? (
        <>
          <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
            <KpiCard label="Sự kiện đã kết thúc" value={resolvedEvents.length} tone="border-emerald-200 bg-emerald-50 text-emerald-700" unavailable={eventsQuery.isError} />
            <KpiCard label="AAR nháp" value={draftAars.length} tone="border-amber-200 bg-amber-50 text-amber-700" unavailable={aarQuery.isError} />
            <KpiCard label="AAR đã xuất bản" value={publishedAars.length} tone="border-indigo-200 bg-indigo-50 text-indigo-700" unavailable={aarQuery.isError} />
            <KpiCard
              label="KPI trung bình"
              value={aars.length === 0 ? '—' : (aars.reduce((sum, report) => sum + Number(report.kpi?.overall_score ?? 0), 0) / aars.length).toFixed(2)}
              tone="border-sky-200 bg-sky-50 text-sky-700"
              unavailable={aarQuery.isError}
            />
            <KpiCard label="SITREP đã publish" value={sitreps.filter((sitrep) => sitrep.status === 'published').length} tone="border-slate-200 bg-slate-50 text-slate-700" unavailable={sitrepQuery.isError} />
          </section>

          <section className="grid gap-6 xl:grid-cols-[1.2fr_1fr]">
            <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
              <h2 className="text-lg font-semibold text-slate-900">Báo cáo sau sự kiện</h2>
              <p className="mt-1 text-sm text-slate-600">KPI tính từ event + dispatch + SITREP + resource, không phải số 0 mặc định.</p>
              <div className="mt-3 space-y-3 text-sm">
                {aars.slice(0, 8).map((report: AfterActionReport) => (
                  <details key={report.id} className="rounded-md border border-slate-200 p-3">
                    <summary className="cursor-pointer font-medium text-slate-900">
                      {report.report_code} · {Number(report.kpi?.overall_score ?? 0).toFixed(2)} · {report.status}
                    </summary>
                    <div className="mt-3 grid gap-2 sm:grid-cols-2">
                      <p>Phản ứng: {Number(report.kpi?.response_time_minutes ?? 0)} phút (SLA {Number(report.kpi?.response_sla_minutes ?? 0)})</p>
                      <p>Hoàn thành điều phối: {Number(report.kpi?.dispatch_completion_rate ?? 0).toFixed(1)}%</p>
                      <p>Độ phủ SITREP: {Number(report.kpi?.sitrep_coverage_rate ?? 0).toFixed(1)}%</p>
                      <p>Hiệu quả nguồn lực: {Number(report.kpi?.resource_efficiency_score ?? 0).toFixed(1)}%</p>
                    </div>
                    <p className="mt-2 text-xs text-slate-600">{report.summary}</p>
                    <ol className="mt-2 list-decimal space-y-1 pl-5 text-xs text-slate-600">
                      {(report.timeline ?? []).slice(0, 8).map((entry, index) => (
                        <li key={`${entry.timestamp}-${index}`}>{entry.action} · {entry.source} · {formatDateTime(entry.timestamp)}</li>
                      ))}
                    </ol>
                    {report.status !== 'published' ? (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void run(async () => {
                          await afterActionApi.publish(report.id);
                          return 'Đã publish AAR.';
                        })}
                        className="mt-3 rounded-md border border-indigo-300 bg-indigo-50 px-2.5 py-1 text-xs font-medium text-indigo-700"
                      >
                        Xuất bản AAR
                      </button>
                    ) : null}
                  </details>
                ))}
                {aars.length === 0 ? <p className="text-slate-500">Chưa có AAR. Resolve một sự kiện để tạo bản nháp.</p> : null}
              </div>
            </div>

            <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
              <h2 className="text-lg font-semibold text-slate-900">Sự kiện đã kết thúc</h2>
              <div className="mt-3 space-y-2 text-sm">
                {resolvedEvents.slice(0, 10).map((event) => {
                  const report = aars.find((item) => item.emergency_event_id === event.id);
                  return (
                    <article key={event.id} className="rounded-md border border-slate-200 p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="font-medium text-slate-900">{event.title}</p>
                        <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700">{event.status}</span>
                      </div>
                      <p className="mt-1 text-xs text-slate-500">{formatDateTime(event.ended_at)}</p>
                      {report ? (
                        <p className="mt-1 text-xs text-slate-600">AAR: {report.report_code} ({report.status})</p>
                      ) : (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void run(async () => {
                            await afterActionApi.generate({ emergency_event_id: event.id, force_regenerate: false });
                            return 'Đã tạo AAR nháp.';
                          })}
                          className="mt-2 rounded-md border border-emerald-300 bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700"
                        >
                          Tạo AAR
                        </button>
                      )}
                    </article>
                  );
                })}
                {resolvedEvents.length === 0 ? <p className="text-slate-500">Chưa có sự kiện kết thúc.</p> : null}
              </div>
            </div>
          </section>
        </>
      ) : null}
    </div>
  );
};

export default PhaseBoardTemplate;
