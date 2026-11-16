// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { ExternalLink, MapPinned } from "lucide-react";
import { WORKSPACE_URL } from "../lib/workspace";

/**
 * Fallback notice for a retired Tier-3 work surface.
 *
 * The root route and nginx redirect these paths to the Tier-2 workspace before
 * this component renders. It stays dependency-light and public so a visitor
 * with JavaScript disabled (or an intercepted redirect) still gets a working
 * HTTPS link and the public hazard map.
 */
export function WorkspaceMovedNotice() {
    return (
        <main className="flex min-h-screen items-center justify-center bg-slate-50 px-4 py-16 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
            <section className="w-full max-w-xl rounded-2xl border border-slate-200 bg-white p-8 shadow-sm dark:border-slate-800 dark:bg-slate-900">
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-amber-600">
                    SynapseCity SOS
                </p>
                <h1 className="mt-2 font-montserrat text-2xl font-bold">Workspace moved</h1>
                <p className="mt-3 text-sm leading-relaxed text-slate-600 dark:text-slate-300">
                    Login, registration and every emergency operations, command-centre or
                    coordination dashboard now live in the shared SynapseDX workspace. This public
                    site keeps the hazard and emergency map.
                </p>
                <a
                    href={WORKSPACE_URL}
                    rel="noopener"
                    className="mt-6 inline-flex items-center gap-2 rounded-xl bg-amber-600 px-5 py-3 text-sm font-semibold text-white transition hover:bg-amber-700"
                >
                    Open SynapseDX workspace
                    <ExternalLink className="h-4 w-4" aria-hidden="true" />
                </a>
                <div className="mt-6">
                    <a
                        href="/map"
                        className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
                    >
                        <MapPinned className="h-4 w-4" aria-hidden="true" />
                        Public hazard map
                    </a>
                </div>
            </section>
        </main>
    );
}
