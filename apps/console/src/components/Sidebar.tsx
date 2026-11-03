// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import React from "react";
import { Link, useLocation } from "@tanstack/react-router";
import {
    LayoutDashboard,
    Map,
    Settings,
    Siren,
    ShieldCheck,
    Activity,
    CloudLightning,
    Menu,
    X,
    ExternalLink,
} from "lucide-react";
import { useAuthStore } from "../stores/authStore";

interface SidebarProps {
    activeTab?: string;
    setActiveTab?: (tab: string) => void;
}

interface MenuItem {
    id: string;
    label: string;
    icon: React.ComponentType<{ size?: number; className?: string }>;
    path: string;
}

/**
 * Emergency-operations navigation only. City asset/incident/IoT/maintenance/
 * budget/report/alert/user/ingest/technician entries deliberately do not exist
 * in this product.
 */
const menuItems: MenuItem[] = [
    {
        id: "dashboard",
        label: "Bảng điều khiển SOS",
        icon: LayoutDashboard,
        path: "/admin",
    },
    {
        id: "emergency",
        label: "Chỉ huy khẩn cấp",
        icon: Siren,
        path: "/admin/emergency-center",
    },
    {
        id: "before",
        label: "Bảng chuẩn bị",
        icon: ShieldCheck,
        path: "/admin/emergency-center/before",
    },
    {
        id: "during",
        label: "Bảng ứng phó (SITREP)",
        icon: Activity,
        path: "/admin/emergency-center/during",
    },
    {
        id: "after",
        label: "Bảng phục hồi (AAR)",
        icon: CloudLightning,
        path: "/admin/emergency-center/after",
    },
    {
        id: "public-map",
        label: "Bản đồ nguy cơ công khai",
        icon: Map,
        path: "/map",
    },
];

const Sidebar: React.FC<SidebarProps> = () => {
    const location = useLocation();
    const { user } = useAuthStore();
    const [isMobileOpen, setIsMobileOpen] = React.useState(false);

    const isActive = (path: string) => {
        if (path === "/admin") {
            return location.pathname === "/admin" || location.pathname === "/admin/";
        }
        if (path === "/admin/emergency-center") {
            return (
                location.pathname === "/admin/emergency-center" ||
                location.pathname.startsWith("/admin/emergency-center/operations")
            );
        }
        return (
            location.pathname === path ||
            location.pathname.startsWith(path + "/")
        );
    };

    return (
        <>
            {/* Mobile menu button */}
            <button
                onClick={() => setIsMobileOpen(!isMobileOpen)}
                className="lg:hidden fixed top-4 left-4 z-50 p-2 bg-slate-900 text-white rounded-lg shadow-lg"
                aria-label="Mở menu điều hướng"
            >
                {isMobileOpen ? <X size={24} /> : <Menu size={24} />}
            </button>

            {/* Sidebar */}
            <div
                className={`fixed lg:static inset-y-0 left-0 z-50 w-64 bg-slate-900 text-white flex flex-col shadow-xl transform transition-transform duration-300 ease-in-out ${
                    isMobileOpen
                        ? "translate-x-0"
                        : "-translate-x-full lg:translate-x-0"
                }`}
            >
                {/* Logo Section */}
                <div className="p-6 border-b border-slate-800">
                    <Link
                        to="/admin"
                        className="flex items-center gap-3 hover:opacity-80 transition-opacity"
                    >
                        <div className="bg-red-600 p-2 rounded-lg">
                            <Siren size={24} />
                        </div>
                        <div>
                            <h1 className="text-lg font-bold tracking-tight">
                                SynapseCity SOS
                            </h1>
                            <p className="text-xs text-slate-400">
                                Emergency Operations
                            </p>
                        </div>
                    </Link>
                </div>

                {/* Navigation */}
                <nav className="flex-1 p-4 space-y-1 overflow-y-auto">
                    {menuItems.map((item) => {
                        const Icon = item.icon;
                        const active = isActive(item.path);

                        return (
                            <Link
                                key={item.id}
                                to={item.path}
                                onClick={() => setIsMobileOpen(false)}
                                className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg transition-all duration-200 ${
                                    active
                                        ? "bg-red-600 text-white shadow-lg shadow-red-900/20"
                                        : "text-slate-400 hover:bg-slate-800 hover:text-white"
                                }`}
                            >
                                <Icon size={20} />
                                <span className="font-medium flex-1 text-left">
                                    {item.label}
                                </span>
                                {active && (
                                    <div className="ml-auto w-1.5 h-1.5 rounded-full bg-white" />
                                )}
                            </Link>
                        );
                    })}

                    {/* Public cross-product link: plain external navigation only. */}
                    <a
                        href="https://synapsecity.sbs"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="w-full flex items-center gap-3 px-4 py-3 rounded-lg text-slate-400 hover:bg-slate-800 hover:text-white transition-all duration-200"
                    >
                        <ExternalLink size={20} />
                        <span className="font-medium flex-1 text-left">
                            SynapseCity
                        </span>
                    </a>
                </nav>

                {/* User Section */}
                <div className="p-4 border-t border-slate-800">
                    <div className="bg-slate-800/50 rounded-lg p-4">
                        <div className="flex items-center gap-3 mb-2">
                            <div className="w-8 h-8 rounded-full bg-gradient-to-tr from-red-500 to-orange-500 flex items-center justify-center font-bold text-xs">
                                {user?.email?.charAt(0).toUpperCase() || "S"}
                            </div>
                            <div className="flex-1 min-w-0">
                                <p className="text-sm font-medium truncate">
                                    {user?.email || "SOS Operator"}
                                </p>
                                <p className="text-xs text-slate-400 capitalize">
                                    {user?.role || "operator"}
                                </p>
                            </div>
                        </div>
                        <Link
                            to="/admin/settings"
                            onClick={() => setIsMobileOpen(false)}
                            className="flex items-center gap-2 text-sm text-slate-400 hover:text-white transition-colors"
                        >
                            <Settings size={16} />
                            <span>Cài đặt</span>
                        </Link>
                    </div>
                </div>
            </div>

            {/* Mobile overlay */}
            {isMobileOpen && (
                <div
                    className="fixed inset-0 bg-black/50 z-30 lg:hidden"
                    onClick={() => setIsMobileOpen(false)}
                />
            )}
        </>
    );
};

export default Sidebar;
