// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { Link } from "@tanstack/react-router";
import { useState, useCallback } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faBars, faXmark } from "@fortawesome/free-solid-svg-icons";
import { CircleAlert, LogIn, Siren } from "lucide-react";
import { BrandSymbol } from "./BrandSymbol";

interface NavigationItem {
    label: string;
    to: string;
    isButton?: boolean;
    isLogin?: boolean;
    isEmergency?: boolean;
    isCitizen?: boolean;
}

/**
 * Public SOS navigation only. City-infrastructure pages belong to the
 * SynapseCity product and are never linked from the emergency console.
 */
const navigationItems: NavigationItem[] = [
    {
        label: "Trung tâm chỉ huy",
        to: "/admin/emergency-center",
        isEmergency: true,
    },
    {
        label: "Bản đồ nguy cơ",
        to: "/map",
        isCitizen: true,
    },
    {
        label: "SITREP & điều phối",
        to: "/admin/emergency-center/during",
        isEmergency: true,
    },
    {
        label: "Tài liệu API",
        to: "/docs",
    },
    {
        label: "Đăng nhập",
        to: "/login",
        isLogin: true,
    },
    {
        label: "Bắt đầu ngay",
        to: "/map",
        isButton: true,
    },
];

const Header: React.FC = () => {
    const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);

    const toggleMobileMenu = useCallback(() => {
        setIsMobileMenuOpen((prev) => !prev);
    }, []);

    const closeMobileMenu = useCallback(() => {
        setIsMobileMenuOpen(false);
    }, []);

    return (
        <header className="fixed z-[1001] top-0 left-0 h-20 w-full bg-white shadow-sm pointer-events-auto">
            <div className="flex items-center justify-between h-full px-4 mx-auto max-w-7xl">
                {/* Logo */}
                <div className="flex items-center">
                    <Link to="/" onClick={closeMobileMenu} className="flex items-center gap-2.5">
                        <BrandSymbol className="h-9 w-9 shrink-0" />
                        <div className="ml-0">
                            <h1 className="text-xl font-bold font-montserrat text-[#EA580C]">SynapseCity SOS</h1>
                            <span className="text-[10px] font-semibold tracking-[0.18em] text-amber-700">EMERGENCY COMMAND</span>
                        </div>
                    </Link>
                </div>

                {/* Mobile Menu Toggle Button */}
                <button
                    type="button"
                    className="text-xl hidden max-lg:block absolute right-4 text-[#6C7580] cursor-pointer hover:text-[#4FACFE] transition-colors"
                    onClick={toggleMobileMenu}
                    aria-label="Chuyển đổi menu trên di động"
                    aria-expanded={isMobileMenuOpen}
                >
                    <FontAwesomeIcon icon={faBars} />
                </button>

                {/* Navigation */}
                <nav
                    className={`flex items-center max-lg:flex-col max-lg:absolute max-lg:top-0 max-lg:right-0 max-lg:bg-white max-lg:w-4/5 max-lg:h-screen max-lg:pt-20 max-lg:transition-transform max-lg:duration-500 max-lg:ease-in-out max-lg:z-[1002] ${
                        isMobileMenuOpen
                            ? "max-lg:translate-x-0"
                            : "max-lg:translate-x-full"
                    }`}
                >
                    {/* Mobile Menu Close Button */}
                    <button
                        type="button"
                        className="absolute top-6 right-6 text-3xl text-[#6C7580] hidden max-lg:block cursor-pointer hover:text-[#4FACFE] transition-colors"
                        onClick={closeMobileMenu}
                        aria-label="Đóng menu trên di động"
                    >
                        <FontAwesomeIcon icon={faXmark} />
                    </button>

                    {/* Navigation Links */}
                    {navigationItems.map((item) => {
                        if (item.isButton) {
                            return (
                                <Link
                                    key={item.to}
                                    to={item.to}
                                    onClick={closeMobileMenu}
                                    className="ml-8
                                    text-base
                                    h-10 bg-linear-to-r
                                    from-[#f97316] from-21% to-[#dc5b43]
                                    px-6 flex items-center rounded-full
                                    max-lg:mx-2 max-lg:w-4/5 max-lg:text-xl
                                    max-lg:flex-col max-lg:justify-center
                                    hover:shadow-lg transition-shadow
                                    z-70"
                                >
                                    <span className="text-white font-semibold text-center">
                                        {item.label}
                                    </span>
                                </Link>
                            );
                        }

                        if (item.isLogin) {
                            return (
                                <Link
                                    key={item.to}
                                    to={item.to}
                                    onClick={closeMobileMenu}
                                    className="ml-8 text-base text-[#6C7580] max-lg:text-lg max-lg:ml-2 max-lg:my-2 hover:text-[#4FACFE] transition-colors flex items-center gap-1.5"
                                >
                                    <LogIn className="w-4 h-4" />
                                    {item.label}
                                </Link>
                            );
                        }

                        if (item.isEmergency) {
                            return (
                                <Link
                                    key={item.to}
                                    to={item.to}
                                    onClick={closeMobileMenu}
                                    className="ml-8 text-base text-[#b9382b] max-lg:text-lg max-lg:ml-2 max-lg:my-2 hover:text-red-600 transition-colors flex items-center gap-1.5 font-bold"
                                >
                                    <Siren className="w-4 h-4" />
                                    {item.label}
                                </Link>
                            );
                        }

                        if (item.isCitizen) {
                            return (
                                <Link
                                    key={item.to}
                                    to={item.to}
                                    onClick={closeMobileMenu}
                                    className="ml-8 text-base text-amber-600 max-lg:text-lg max-lg:ml-2 max-lg:my-2 hover:text-amber-700 transition-colors flex items-center gap-1.5 font-medium"
                                >
                                    <CircleAlert className="w-4 h-4" />
                                    {item.label}
                                </Link>
                            );
                        }

                        return (
                            <Link
                                key={item.to}
                                to={item.to}
                                onClick={closeMobileMenu}
                                className="ml-8 text-base text-[#6C7580] max-lg:text-lg max-lg:ml-2 max-lg:my-2 hover:text-[#4FACFE] transition-colors"
                            >
                                {item.label}
                            </Link>
                        );
                    })}

                    {/* Public cross-product navigation only (never an API dependency). */}
                    <a
                        href="https://synapsecity.sbs"
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={closeMobileMenu}
                        className="ml-8 text-base text-[#6C7580] max-lg:text-lg max-lg:ml-2 max-lg:my-2 hover:text-[#4FACFE] transition-colors"
                    >
                        SynapseCity
                    </a>
                </nav>
            </div>
        </header>
    );
};

export default Header;
