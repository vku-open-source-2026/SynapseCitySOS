// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC

/**
 * SynapseCity SOS app-icon tile: blue tile, white beacon ring and amber signal dot.
 */
export function BrandSymbol({ className = "h-9 w-9" }: { className?: string }) {
    return (
        <svg viewBox="0 0 256 256" className={className} aria-hidden="true">
            <rect width="256" height="256" rx="56" fill="#1D4ED8" />
            <g transform="translate(51.2 51.2) scale(0.6)">
                <path
                    fill="#FFFFFF"
                    d="M 228.5 101.1 A 104 104 0 1 1 154.9 27.5 L 142.5 73.9 A 56 56 0 1 0 182.1 113.5 Z"
                />
                <rect x="164.6" y="51.4" width="40" height="40" rx="12" fill="#F59E0B" />
            </g>
        </svg>
    );
}
