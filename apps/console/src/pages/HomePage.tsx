// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import {
    ArrowRight,
    ClipboardList,
    Download,
    FileCheck2,
    MapPin,
    Phone,
    Radio,
    Siren,
    ShieldAlert,
    Truck,
    Waves,
} from "lucide-react";

import { emergencyApi } from "../api/emergency";
import { hazardsApi } from "../api/hazards";
import Footer from "../components/Footer";
import Header from "../components/Header";
import { usePWA } from "../hooks/usePWA";

const capabilities = [
    {
        icon: Waves,
        title: "Cảnh báo thiên tai",
        description:
            "Theo dõi lũ, bão, sạt lở và dữ liệu VNDMS trực tiếp trên bản đồ nguy cơ công khai.",
        to: "/map" as const,
        cta: "Mở bản đồ nguy cơ",
    },
    {
        icon: Siren,
        title: "Sự kiện khẩn cấp",
        description:
            "Tiếp nhận, phân loại và theo dõi sự kiện khẩn cấp theo mức độ và vòng đời xử lý.",
        to: "/admin/emergency-center" as const,
        cta: "Vào trung tâm chỉ huy",
    },
    {
        icon: ClipboardList,
        title: "Kế hoạch ứng phó (EOP)",
        description:
            "Tạo bản nháp EOP bằng AI, duyệt, xuất bản và sinh nhiệm vụ điều phối tự động.",
        to: "/admin/emergency-center/before" as const,
        cta: "Bảng trước thiên tai",
    },
    {
        icon: Truck,
        title: "Điều phối & nguồn lực",
        description:
            "Phân công đơn vị ứng cứu, tối ưu lệnh điều phối và theo dõi trạng thái triển khai.",
        to: "/admin/emergency-center/during" as const,
        cta: "Bảng điều phối",
    },
    {
        icon: Radio,
        title: "SITREP thời gian thực",
        description:
            "Cập nhật tình hình hiện trường, delta báo cáo và tín hiệu vận hành trong suốt sự kiện.",
        to: "/admin/emergency-center/during" as const,
        cta: "Xem SITREP",
    },
    {
        icon: FileCheck2,
        title: "Báo cáo sau sự kiện (AAR)",
        description:
            "Tổng hợp KPI, bài học kinh nghiệm và xuất bản after-action report sau mỗi chiến dịch.",
        to: "/admin/emergency-center/after" as const,
        cta: "Bảng sau thiên tai",
    },
];

const HomePage = () => {
    const { canShowInstallButton, promptInstall } = usePWA();
    const [activeEvents, setActiveEvents] = useState<number | null>(null);
    const [activeHazards, setActiveHazards] = useState<number | null>(null);
    const [criticalHazards, setCriticalHazards] = useState<number | null>(null);

    useEffect(() => {
        let cancelled = false;

        Promise.allSettled([
            emergencyApi.listPublic({ limit: 200 }),
            hazardsApi.listRecentItems({ hours: 24, limit: 200 }),
        ]).then(([eventsResult, hazardsResult]) => {
            if (cancelled) {
                return;
            }

            if (eventsResult.status === "fulfilled") {
                setActiveEvents(eventsResult.value.length);
            } else {
                setActiveEvents(null);
            }

            if (hazardsResult.status === "fulfilled") {
                setActiveHazards(hazardsResult.value.length);
                setCriticalHazards(
                    hazardsResult.value.filter((hazard) => hazard.severity === "critical").length
                );
            } else {
                setActiveHazards(null);
                setCriticalHazards(null);
            }
        });

        return () => {
            cancelled = true;
        };
    }, []);

    const statCards = [
        {
            label: "Sự kiện đang xử lý",
            value: activeEvents === null ? "—" : String(activeEvents),
            tone: "text-red-600",
        },
        {
            label: "Cảnh báo đang hoạt động",
            value: activeHazards === null ? "—" : String(activeHazards),
            tone: "text-amber-600",
        },
        {
            label: "Cảnh báo nghiêm trọng",
            value: criticalHazards === null ? "—" : String(criticalHazards),
            tone: "text-rose-700",
        },
    ];

    return (
        <div className="min-h-screen bg-white text-gray-heading">
            <Header />
            <main className="pt-28">
                {/* Hero */}
                <section className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-16 md:py-24">
                    <div className="grid md:grid-cols-2 gap-12 items-center">
                        <div className="space-y-6">
                            <div className="inline-flex items-center gap-2 px-3 py-1 bg-red-100 text-red-700 rounded-full text-sm font-medium">
                                <Siren className="w-4 h-4" />
                                Điều hành khẩn cấp
                            </div>
                            <h1 className="text-4xl md:text-5xl font-bold text-slate-900 leading-tight">
                                Ứng phó thiên tai{" "}
                                <span className="bg-gradient-to-r from-red-500 to-orange-500 bg-clip-text text-transparent">
                                    nhanh và có tổ chức
                                </span>
                            </h1>
                            <p className="text-lg text-slate-600 leading-relaxed">
                                SynapseCity SOS hợp nhất cảnh báo thiên tai, sự kiện
                                khẩn cấp, kế hoạch ứng phó (EOP), điều phối nguồn
                                lực, SITREP và báo cáo sau sự kiện trong một trung
                                tâm chỉ huy duy nhất.
                            </p>
                            <div className="flex flex-col sm:flex-row gap-4 pt-2">
                                <Link
                                    to="/admin/emergency-center"
                                    className="inline-flex items-center justify-center px-6 py-3 text-white font-semibold rounded-full bg-gradient-to-r from-red-600 to-orange-500 shadow-lg hover:shadow-xl transition-shadow"
                                >
                                    <Siren className="w-4 h-4 mr-2" />
                                    Vào trung tâm chỉ huy
                                </Link>
                                <Link
                                    to="/map"
                                    className="inline-flex items-center justify-center px-6 py-3 border border-slate-200 text-slate-700 rounded-full hover:border-red-400 hover:text-red-600 transition-colors"
                                >
                                    <MapPin className="w-4 h-4 mr-2" />
                                    Bản đồ nguy cơ
                                </Link>
                                {canShowInstallButton && (
                                    <button
                                        onClick={promptInstall}
                                        className="inline-flex items-center justify-center px-6 py-3 bg-slate-900 text-white font-semibold rounded-full hover:bg-slate-800 transition-colors shadow-lg"
                                    >
                                        <Download className="w-4 h-4 mr-2" />
                                        Cài đặt ứng dụng
                                    </button>
                                )}
                            </div>
                        </div>

                        <div className="relative z-0">
                            <div className="rounded-2xl bg-gradient-to-br from-slate-900 via-red-900 to-orange-700 p-6 shadow-2xl text-white">
                                <div className="flex items-center justify-between mb-5">
                                    <span className="text-sm font-semibold">
                                        Tình hình vận hành
                                    </span>
                                    <span className="flex items-center gap-1.5 text-xs font-medium text-red-100">
                                        <span className="w-2 h-2 rounded-full bg-red-400 animate-pulse" />
                                        LIVE
                                    </span>
                                </div>
                                <div className="grid grid-cols-1 gap-3">
                                    {statCards.map((stat) => (
                                        <div
                                            key={stat.label}
                                            className="flex items-center justify-between rounded-lg bg-white/10 px-4 py-3"
                                        >
                                            <span className="text-sm text-white/85">
                                                {stat.label}
                                            </span>
                                            <span className="text-2xl font-bold">
                                                {stat.value}
                                            </span>
                                        </div>
                                    ))}
                                </div>
                                <p className="mt-5 text-xs text-white/70">
                                    Số liệu lấy trực tiếp từ API sự kiện khẩn cấp
                                    và cảnh báo thiên tai của SOS.
                                </p>
                            </div>
                        </div>
                    </div>
                </section>

                {/* Capabilities */}
                <section id="features" className="bg-slate-50 py-20 border-y border-slate-100">
                    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
                        <div className="text-center mb-14">
                            <h2 className="text-3xl md:text-4xl font-bold mb-4 text-slate-900">
                                Năng lực điều hành khẩn cấp
                            </h2>
                            <p className="text-lg text-slate-600">
                                Từ chuẩn bị, ứng phó đến phục hồi — tất cả trong
                                một luồng nghiệp vụ.
                            </p>
                        </div>
                        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
                            {capabilities.map((capability) => (
                                <div
                                    key={capability.title}
                                    className="bg-white border border-slate-200 rounded-xl p-6 hover:border-red-300 hover:shadow-lg transition-all flex flex-col"
                                >
                                    <capability.icon className="w-8 h-8 text-red-500 mb-4" />
                                    <h3 className="text-lg font-semibold text-slate-900 mb-2">
                                        {capability.title}
                                    </h3>
                                    <p className="text-slate-600 text-sm flex-1">
                                        {capability.description}
                                    </p>
                                    <Link
                                        to={capability.to}
                                        className="mt-4 inline-flex items-center gap-1 text-sm font-semibold text-red-600 hover:text-red-700"
                                    >
                                        {capability.cta}
                                        <ArrowRight className="w-4 h-4" />
                                    </Link>
                                </div>
                            ))}
                        </div>
                    </div>
                </section>

                {/* Public hazard map strip */}
                <section className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-20">
                    <div className="grid md:grid-cols-2 gap-12 items-center">
                        <div className="space-y-5">
                            <div className="inline-flex items-center gap-2 px-3 py-1 bg-amber-100 text-amber-700 rounded-full text-sm font-medium">
                                <ShieldAlert className="w-4 h-4" />
                                Dành cho người dân
                            </div>
                            <h2 className="text-3xl md:text-4xl font-bold text-slate-900 leading-tight">
                                Bản đồ cảnh báo thiên tai{" "}
                                <span className="bg-gradient-to-r from-amber-500 to-orange-500 bg-clip-text text-transparent">
                                    theo thời gian thực
                                </span>
                            </h2>
                            <p className="text-lg text-slate-600 leading-relaxed">
                                Theo dõi mưa, gió, lũ và mực nước từ dữ liệu VNDMS
                                chính thức, xem các chiến dịch cứu hộ đang diễn ra
                                và tìm nơi trú ẩn gần nhất.
                            </p>
                            <div className="flex flex-col sm:flex-row gap-4">
                                <Link
                                    to="/map"
                                    className="inline-flex items-center justify-center px-6 py-3 bg-gradient-to-r from-amber-500 to-orange-500 text-white font-semibold rounded-full shadow-lg hover:shadow-xl transition-all"
                                >
                                    <MapPin className="w-4 h-4 mr-2" />
                                    Mở bản đồ nguy cơ
                                </Link>
                                <a
                                    href="tel:114"
                                    className="inline-flex items-center justify-center px-6 py-3 border border-red-200 text-red-600 font-semibold rounded-full hover:bg-red-50 transition-colors"
                                >
                                    <Phone className="w-4 h-4 mr-2" />
                                    Gọi 114
                                </a>
                            </div>
                        </div>
                        <div className="bg-white rounded-2xl border border-amber-100 shadow-xl p-6 space-y-4">
                            <h3 className="text-lg font-semibold text-slate-900">
                                Trên bản đồ công khai
                            </h3>
                            {[
                                "Cảnh báo lũ, bão, sạt lở và động đất",
                                "Lọc theo mức độ nghiêm trọng và vị trí gần bạn",
                                "Vị trí các chiến dịch cứu hộ đang triển khai",
                                "Chỉ đường tới nơi trú ẩn và đầu mối hỗ trợ",
                            ].map((item) => (
                                <div
                                    key={item}
                                    className="flex items-start gap-3 rounded-lg bg-slate-50 p-3 text-sm text-slate-700"
                                >
                                    <span className="mt-1 w-2 h-2 rounded-full bg-amber-500 shrink-0" />
                                    {item}
                                </div>
                            ))}
                        </div>
                    </div>
                </section>

                {/* CTA */}
                <section className="bg-slate-50 py-20 border-t border-slate-100">
                    <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 text-center space-y-8">
                        <h2 className="text-3xl md:text-5xl font-bold text-slate-900">
                            Sẵn sàng cho mùa mưa bão
                        </h2>
                        <p className="text-xl text-slate-600 max-w-2xl mx-auto">
                            Bắt đầu từ bảng chuẩn bị, chuyển sang điều phối khi
                            thiên tai xảy ra và khép lại bằng báo cáo sau sự kiện.
                        </p>
                        <div className="flex flex-col sm:flex-row gap-6 justify-center pt-4">
                            <Link
                                to="/admin/emergency-center/before"
                                className="inline-flex items-center justify-center px-8 py-4 text-white font-bold text-lg rounded-full bg-gradient-to-r from-red-600 to-orange-500 shadow-lg hover:shadow-xl transition-all"
                            >
                                Bắt đầu chuẩn bị
                            </Link>
                            <Link
                                to="/docs"
                                className="inline-flex items-center justify-center px-8 py-4 border-2 border-slate-300 text-slate-700 font-bold text-lg rounded-full hover:border-red-400 hover:text-red-600 transition-all"
                            >
                                Tài liệu API
                            </Link>
                        </div>
                    </div>
                </section>

                {/* Open source */}
                <section className="bg-white py-16">
                    <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 text-center space-y-6">
                        <div className="inline-block px-4 py-1 bg-rose-100 text-rose-700 rounded-full text-sm font-medium">
                            Mã nguồn mở
                        </div>
                        <h2 className="text-3xl md:text-4xl font-bold text-slate-900">
                            Cùng xây dựng năng lực ứng phó
                        </h2>
                        <p className="text-lg text-slate-600 max-w-2xl mx-auto">
                            SynapseCity SOS là dự án mã nguồn mở. Bạn có thể đóng
                            góp mã, báo lỗi hoặc bổ sung kịch bản ứng phó cho
                            cộng đồng.
                        </p>
                        <div className="flex flex-col sm:flex-row gap-6 justify-center pt-2">
                            <a
                                href="https://github.com/vku-open-source-2026/SynapseCitySOS"
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center justify-center gap-3 px-8 py-4 bg-slate-900 text-white font-bold rounded-full hover:bg-slate-800 transition-all"
                            >
                                Xem mã nguồn
                            </a>
                            <a
                                href="https://github.com/vku-open-source-2026/SynapseCitySOS/issues"
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center justify-center gap-3 px-8 py-4 bg-white border border-slate-200 text-slate-700 font-bold rounded-full hover:border-red-300 hover:text-red-600 transition-all"
                            >
                                Báo lỗi
                            </a>
                        </div>
                        <div className="flex flex-wrap items-center justify-center gap-6 pt-4 text-sm text-slate-500">
                            <a
                                href="https://github.com/vku-open-source-2026/SynapseCitySOS/blob/main/LICENSE"
                                target="_blank"
                                rel="noopener noreferrer"
                                className="hover:text-red-600 transition-colors"
                            >
                                Mã nguồn: Apache 2.0
                            </a>
                            <span className="text-slate-400">·</span>
                            <a
                                href="https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/"
                                target="_blank"
                                rel="noopener noreferrer"
                                className="hover:text-red-600 transition-colors"
                            >
                                Dữ liệu: OGL v3.0
                            </a>
                        </div>
                    </div>
                </section>
            </main>
            <Footer />
        </div>
    );
};

export default HomePage;
