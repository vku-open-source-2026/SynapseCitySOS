// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { Link } from "@tanstack/react-router";

const Logo = () => {
    return (
        <Link to="/" className="flex items-center space-x-2">
            <div className="w-10 h-10 bg-gradient-to-br from-orange-500 to-rose-700 rounded-lg flex items-center justify-center">
                <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 3v4m0 10v4M5.6 5.6l2.8 2.8m7.2 7.2l2.8 2.8M3 12h4m10 0h4M5.6 18.4l2.8-2.8m7.2-7.2l2.8-2.8" />
                </svg>
            </div>
            <span className="text-xl font-bold text-gray-main">SynapseCity SOS</span>
        </Link>
    );
};

export default Logo;
