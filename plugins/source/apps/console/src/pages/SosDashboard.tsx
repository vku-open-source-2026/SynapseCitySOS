// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import React from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
    Activity,
    AlertTriangle,
    ClipboardList,
    FileCheck2,
    Map as MapIcon,
    Radio,
    RefreshCw,
    Siren,
    Truck,
} from "lucide-react";

import { afterActionApi } from "@/api/after-action-reports";
import { dispatchApi } from "@/api/dispatch";
import { emergencyApi } from "@/api/emergency";
import { eopApi } from "@/api/eop";
import { hazardsApi } from "@/api/hazards";
import { resourcesApi } from "@/api/resources";
import { sitrepApi } from "@/api/sitrep";

const SEVERITY_CLASS: Record<string, string> = {
    low: "bg-emerald-100 text-emerald-700",
    medium: "bg-amber-100 text-amber-700",
    high: "bg-orange-100 text-orange-700",
    critical: "bg-red-100 text-red-700",
};

const STATUS_CLASS: Record<string, string> = {
    monitoring: "bg-slate-100 text-slate-700",
    active: "bg-red-100 text-red-700",
    contained: "bg-blue-100 text-blue-700",
    resolved: "bg-emerald-100 text-emerald-700",
    canceled: "bg-zinc-100 text-zinc-700",
};

const RESOURCE_STATUS_LABEL: Record<string, string> = {
    available: "Sẵn sàng",
    standby: "Chờ điều động",
    deployed: "Đã triển khai",
    offline: "Ngoại tuyến",
    maintenance: "Đang bảo dưỡng",
};

function formatDateTime(value?: string): string {
    if (!value) {
        return "--";
    }
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "--" : date.toLocaleString("vi-VN");
}

const SosDashboard: React.FC = () => {
    const eventsQuery = useQuery({
        queryKey: ["dashboard", "emergency-events"],
        queryFn: () => emergencyApi.list({ limit: 200 }),
        refetchInterval: 45_000,
        retry: 1,
    });

    const hazardsQuery = useQuery({
        queryKey: ["dashboard", "hazards"],
        queryFn: () => hazardsApi.list({ is_active: true, limit: 200 }),
        refetchInterval: 60_000,
        retry: 1,
    });

    const eopQuery = useQuery({
        queryKey: ["dashboard", "eop"],
        queryFn: () => eopApi.list({ limit: 200 }),
        retry: 1,
    });

    const dispatchQuery = useQuery({
        queryKey: ["dashboard", "dispatch"],
        queryFn: () => dispatchApi.list({ limit: 200 }),
        retry: 1,
    });

    const resourcesQuery = useQuery({
        queryKey: ["dashboard", "resources"],
        queryFn: () => resourcesApi.list({ limit: 200 }),
        retry: 1,
    });

    const sitrepQuery = useQuery({
        queryKey: ["dashboard", "sitrep"],
        queryFn: () => sitrepApi.list({ limit: 200 }),
        retry: 1,
    });

    const afterActionQuery = useQuery({
        queryKey: ["dashboard", "after-action"],
        queryFn: () => afterActionApi.list({ limit: 200 }),
        retry: 1,
    });

    const events = eventsQuery.data ?? [];
    const hazards = hazardsQuery.data ?? [];
    const eopPlans = eopQuery.data ?? [];
    const dispatchOrders = dispatchQuery.data ?? [];
    const resources = resourcesQuery.data ?? [];
    const sitreps = sitrepQuery.data ?? [];
    const afterActionReports = afterActionQuery.data ?? [];

    const activeEvents = events.filter((event) => event.status === "active");
    const criticalHazards = hazards.filter((hazard) => hazard.severity === "critical");
    const draftEops = eopPlans.filter((plan) => plan.status === "draft");
    const openDispatch = dispatchOrders.filter(
        (order) => !["completed", "canceled"].includes(order.status)
    );
    const availableResources = resources.filter(
        (resource) => resource.status === "available"
    );
    const publishedSitreps = sitreps.filter((item) => item.status === "published");
    const publishedAars = afterActionReports.filter(
        (report) => report.status === "published"
    );

    const summary = {
        activeEvents,
        criticalHazards,
        draftEops,
        openDispatch,
        availableResources,
        publishedSitreps,
        publishedAars,
    };

    const isLoading =
        eventsQuery.isLoading ||
        hazardsQuery.isLoading ||
        eopQuery.isLoading ||
        dispatchQuery.isLoading ||
        resourcesQuery.isLoading ||
        sitrepQuery.isLoading ||
        afterActionQuery.isLoading;

    const hasError =
        eventsQuery.isError ||
        hazardsQuery.isError ||
        eopQuery.isError ||
        dispatchQuery.isError ||
        resourcesQuery.isError ||
        sitrepQuery.isError ||
        afterActionQuery.isError;

    const refreshAll = () => {
        void eventsQuery.refetch();
        void hazardsQuery.refetch();
        void eopQuery.refetch();
        void dispatchQuery.refetch();
        void resourcesQuery.refetch();
        void sitrepQuery.refetch();
        void afterActionQuery.refetch();
    };

    const statCards = [
        {
            label: "Sự kiện đang xử lý",
            value: summary.activeEvents.length,
            icon: Siren,
            className: "border-red-200 bg-red-50 text-red-700",
        },
        {
            label: "Nguy hiểm nghiêm trọng",
            value: summary.criticalHazards.length,
            icon: AlertTriangle,
            className: "border-rose-200 bg-rose-50 text-rose-700",
        },
        {
            label: "EOP nháp",
            value: summary.draftEops.length,
            icon: ClipboardList,
            className: "border-amber-200 bg-amber-50 text-amber-700",
        },
        {
            label: "Điều phối đang mở",
            value: summary.openDispatch.length,
            icon: Truck,
            className: "border-blue-200 bg-blue-50 text-blue-700",
        },
        {
            label: "Nguồn lực sẵn sàng",
            value: summary.availableResources.length,
            icon: Activity,
            className: "border-emerald-200 bg-emerald-50 text-emerald-700",
        },
        {
            label: "SITREP đã xuất bản",
            value: summary.publishedSitreps.length,
            icon: Radio,
            className: "border-sky-200 bg-sky-50 text-sky-700",
        },
        {
            label: "AAR đã xuất bản",
            value: summary.publishedAars.length,
            icon: FileCheck2,
            className: "border-indigo-200 bg-indigo-50 text-indigo-700",
        },
    ];

    return (
        <div className="space-y-6 p-4 md:p-6">
            <header className="rounded-xl bg-gradient-to-r from-slate-900 via-red-900 to-orange-700 p-5 text-white shadow-lg">
                <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                        <h1 className="text-2xl font-bold md:text-3xl">
                            Bảng điều khiển SOS
                        </h1>
                        <p className="mt-2 text-sm text-white/90 md:text-base">
                            Tổng quan tình hình thiên tai, EOP, điều phối nguồn lực
                            và báo cáo sự kiện.
                        </p>
                    </div>
                    <button
                        type="button"
                        onClick={refreshAll}
                        className="inline-flex items-center gap-2 rounded-lg border border-white/40 bg-white/10 px-3 py-1.5 text-sm text-white hover:bg-white/20"
                    >
                        <RefreshCw size={14} />
                        Làm mới
                    </button>
                </div>

                <div className="mt-3 flex flex-wrap gap-2">
                    {[
                        { to: "/admin/emergency-center", label: "Trung tâm chỉ huy" },
                        { to: "/admin/emergency-center/before", label: "Trước thiên tai" },
                        { to: "/admin/emergency-center/during", label: "Trong thiên tai" },
                        { to: "/admin/emergency-center/after", label: "Sau thiên tai" },
                    ].map((link) => (
                        <Link
                            key={link.to}
                            to={link.to}
                            className="inline-flex rounded-lg border border-white/35 bg-white/10 px-3 py-1.5 text-xs font-medium text-white hover:bg-white/20"
                        >
                            {link.label}
                        </Link>
                    ))}
                    <Link
                        to="/map"
                        className="inline-flex items-center gap-1 rounded-lg border border-white/35 bg-white/10 px-3 py-1.5 text-xs font-medium text-white hover:bg-white/20"
                    >
                        <MapIcon size={12} />
                        Bản đồ nguy cơ công khai
                    </Link>
                </div>
            </header>

            {hasError ? (
                <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                    Một số nguồn dữ liệu SOS chưa phản hồi. Các số liệu còn lại vẫn
                    được hiển thị và sẽ tự cập nhật.
                </div>
            ) : null}

            <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                {statCards.map((card) => (
                    <article
                        key={card.label}
                        className={`rounded-xl border p-4 shadow-sm ${card.className}`}
                    >
                        <div className="flex items-center justify-between">
                            <p className="text-xs font-semibold uppercase tracking-wide">
                                {card.label}
                            </p>
                            <card.icon size={18} />
                        </div>
                        <p className="mt-2 text-3xl font-bold">
                            {isLoading ? "—" : card.value}
                        </p>
                    </article>
                ))}
            </section>

            <section className="grid gap-6 xl:grid-cols-[1.4fr_1fr]">
                <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
                    <div className="mb-3 flex items-center justify-between gap-3">
                        <h2 className="text-lg font-semibold text-slate-900">
                            Sự kiện khẩn cấp đang hoạt động
                        </h2>
                        <Link
                            to="/admin/emergency-center"
                            className="text-sm font-medium text-red-600 hover:text-red-700"
                        >
                            Mở chỉ huy →
                        </Link>
                    </div>

                    {isLoading ? (
                        <p className="text-sm text-slate-500">Đang tải sự kiện...</p>
                    ) : summary.activeEvents.length === 0 ? (
                        <p className="text-sm text-slate-500">
                            Không có sự kiện khẩn cấp nào đang hoạt động.
                        </p>
                    ) : (
                        <ul className="space-y-2">
                            {summary.activeEvents.slice(0, 8).map((event) => (
                                <li
                                    key={event.id}
                                    className="rounded-lg border border-slate-200 p-3"
                                >
                                    <div className="flex flex-wrap items-center justify-between gap-2">
                                        <p className="font-medium text-slate-900">
                                            {event.title}
                                        </p>
                                        <span
                                            className={`rounded-full px-2.5 py-1 text-xs font-medium ${
                                                STATUS_CLASS[event.status] ??
                                                "bg-slate-100 text-slate-700"
                                            }`}
                                        >
                                            {event.status}
                                        </span>
                                    </div>
                                    <p className="mt-1 text-xs text-slate-500">
                                        <span
                                            className={`mr-2 rounded-full px-2 py-0.5 text-[11px] font-medium ${
                                                SEVERITY_CLASS[event.severity] ??
                                                "bg-slate-100 text-slate-700"
                                            }`}
                                        >
                                            {event.severity}
                                        </span>
                                        {event.event_type} · cập nhật{" "}
                                        {formatDateTime(event.updated_at)}
                                    </p>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>

                <div className="space-y-6">
                    <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
                        <h2 className="mb-3 text-lg font-semibold text-slate-900">
                            Nguồn lực theo trạng thái
                        </h2>
                        <ul className="space-y-2 text-sm text-slate-700">
                            {["available", "standby", "deployed", "offline", "maintenance"].map(
                                (status) => (
                                    <li
                                        key={status}
                                        className="flex items-center justify-between rounded-md bg-slate-50 px-3 py-2"
                                    >
                                        <span>{RESOURCE_STATUS_LABEL[status] ?? status}</span>
                                        <span className="font-semibold text-slate-900">
                                            {
                                                resources.filter(
                                                    (resource) => resource.status === status
                                                ).length
                                            }
                                        </span>
                                    </li>
                                )
                            )}
                        </ul>
                    </div>

                    <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
                        <h2 className="mb-3 text-lg font-semibold text-slate-900">
                            Cảnh báo nghiêm trọng
                        </h2>
                        {summary.criticalHazards.length === 0 ? (
                            <p className="text-sm text-slate-500">
                                Không có cảnh báo mức nghiêm trọng.
                            </p>
                        ) : (
                            <ul className="space-y-2 text-sm">
                                {summary.criticalHazards.slice(0, 6).map((hazard) => (
                                    <li
                                        key={hazard.id}
                                        className="rounded-md border border-slate-200 p-3"
                                    >
                                        <p className="font-medium text-slate-900">
                                            {hazard.title}
                                        </p>
                                        <p className="mt-1 text-xs text-slate-500">
                                            {hazard.event_type} ·{" "}
                                            {hazard.district || "Chưa rõ khu vực"}
                                        </p>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </div>
                </div>
            </section>
        </div>
    );
};

export default SosDashboard;
