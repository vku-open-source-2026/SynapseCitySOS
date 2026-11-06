// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import React, { useState, useCallback, useMemo } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import {
    AlertTriangle,
    RefreshCw,
    MapPin,
    Clock,
    ShieldAlert,
    X,
    Phone,
    Crosshair,
    Home,
    LifeBuoy,
    Siren,
    Sparkles,
    Send,
} from "lucide-react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { fetchTileConfig } from "../lib/tileConfig";
import VndmsHazardLayer, { VndmsLegend } from "../components/VndmsHazardLayer";
import { useVndmsHazards, useVndmsStatus, type VndmsHazard } from "../hooks/useVndmsHazards";
import HazardMarkersLayer from "../components/HazardMarkersLayer";
import EmergencyEventsLayer from "../components/EmergencyEventsLayer";
import { hazardsApi } from "../api/hazards";
import { aiApi, type AiAnswer } from "../api/ai";
import { resourcesApi, type NearbyShelter } from "../api/resources";
import { usePublicEmergencyEvents } from "../hooks/usePublicEmergencyEvents";
import { emergencyStatusLabel, emergencyStatusTone, isOngoingEmergencyStatus } from "../lib/emergencyStatus";
import type { Hazard } from "../types/hazard";
import type {
    PublicEmergencyEvent,
    EmergencyEventType,
    EmergencySeverity,
} from "../types/emergency";

// ── Visual maps ──────────────────────────────────────────────────────────────

const TYPE_LABEL_VI: Record<string, string> = {
    water_level: "Mực nước",
    warning_rain: "Cảnh báo mưa",
    warning_wind: "Cảnh báo gió",
    warning_earthquake: "Động đất",
    warning_flood: "Lũ lụt",
};

const TYPE_EMOJI: Record<string, string> = {
    water_level: "💧",
    warning_rain: "🌧️",
    warning_wind: "💨",
    warning_earthquake: "🌍",
    warning_flood: "🌊",
};

const SEVERITY_BG: Record<string, string> = {
    low: "bg-green-100 text-green-800",
    medium: "bg-yellow-100 text-yellow-800",
    high: "bg-red-100 text-red-800",
    critical: "bg-purple-100 text-purple-800",
};

const SEVERITY_LABEL: Record<string, string> = {
    low: "Thấp",
    medium: "Trung bình",
    high: "Cao",
    critical: "Nghiêm trọng",
};

const EVENT_TYPE_LABEL: Record<EmergencyEventType, string> = {
    flood: "Lũ lụt",
    storm: "Bão",
    landslide: "Sạt lở",
    fire: "Cháy rừng",
    earthquake: "Động đất",
    outage: "Mất điện",
    pollution: "Ô nhiễm",
    other: "Khác",
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function timeAgo(ms: number): string {
    const diff = Date.now() - ms;
    const m = Math.floor(diff / 60000);
    if (m < 1) return "Vừa xong";
    if (m < 60) return `${m} phút trước`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h} giờ trước`;
    return `${Math.floor(h / 24)} ngày trước`;
}

function haversineKm(
    a: { lat: number; lng: number },
    b: { lat: number; lng: number }
): number {
    const R = 6371;
    const toRad = (d: number) => (d * Math.PI) / 180;
    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lng - a.lng);
    const lat1 = toRad(a.lat);
    const lat2 = toRad(b.lat);
    const x =
        Math.sin(dLat / 2) ** 2 +
        Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
    return 2 * R * Math.asin(Math.sqrt(x));
}

function pointFromHazard(h: Hazard): { lat: number; lng: number } | null {
    if (!h.geometry?.coordinates) return null;
    if (h.geometry.type === "Point") {
        const [lng, lat] = h.geometry.coordinates as number[];
        if (typeof lat === "number" && typeof lng === "number") return { lat, lng };
    }
    return null;
}

function pointFromEvent(e: PublicEmergencyEvent): { lat: number; lng: number } | null {
    if (!e.geometry?.coordinates) return null;
    if (e.geometry.type === "Point") {
        const [lng, lat] = e.geometry.coordinates as number[];
        if (typeof lat === "number" && typeof lng === "number") return { lat, lng };
    }
    return null;
}

const VIETNAM_CENTER: [number, number] = [16.0, 107.0];
const NEAR_ME_RADIUS_KM = 10;

type FilterChip = "all" | "critical" | "near";

// ── Cards ────────────────────────────────────────────────────────────────────

const EventCard: React.FC<{
    event: PublicEmergencyEvent;
    onLocate: (e: PublicEmergencyEvent) => void;
}> = ({ event, onLocate }) => {
    const sevColor =
        event.severity === "critical"
            ? "#7c3aed"
            : event.severity === "high"
            ? "#ef4444"
            : event.severity === "medium"
            ? "#f59e0b"
            : "#22c55e";
    const loc = event.location;
    const locText = [loc?.address, loc?.ward, loc?.district, loc?.city]
        .filter(Boolean)
        .join(", ");
    const startedAt = event.started_at ?? event.created_at;
    const hasGeom = !!pointFromEvent(event);
    return (
        <div
            className="bg-white rounded-xl border border-slate-100 shadow-sm overflow-hidden border-l-4"
            style={{ borderLeftColor: sevColor }}
        >
            <div className="p-3 flex items-start gap-2.5">
                <span className="text-xl flex-shrink-0 mt-0.5">🚨</span>
                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap mb-1">
                        <span
                            className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
                                SEVERITY_BG[event.severity] ?? "bg-slate-100 text-slate-700"
                            }`}
                        >
                            {SEVERITY_LABEL[event.severity] ?? event.severity}
                        </span>
                        <span className="text-[10px] text-slate-500">
                            {EVENT_TYPE_LABEL[event.event_type] ?? event.event_type}
                        </span>
                        <span className={`text-[10px] font-semibold ${
                            emergencyStatusTone(event.status) === "amber"
                                ? "text-amber-600"
                                : emergencyStatusTone(event.status) === "blue"
                                ? "text-blue-600"
                                : emergencyStatusTone(event.status) === "red"
                                ? "text-red-600"
                                : "text-slate-500"
                        }`}>
                            • {emergencyStatusLabel(event.status)}
                        </span>
                    </div>
                    <h3 className="font-semibold text-slate-900 text-sm leading-snug">
                        {event.title}
                    </h3>
                    {locText && (
                        <p className="text-xs text-slate-500 mt-0.5">📍 {locText}</p>
                    )}
                    {startedAt && (
                        <p className="text-[10px] text-slate-400 mt-0.5">
                            Bắt đầu: {timeAgo(new Date(startedAt).getTime())}
                        </p>
                    )}
                </div>
                <button
                    onClick={() => onLocate(event)}
                    disabled={!hasGeom}
                    title={hasGeom ? "Xem trên bản đồ" : "Không có tọa độ"}
                    className="flex-shrink-0 p-1.5 text-blue-600 hover:bg-blue-50 rounded transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                >
                    <MapPin size={14} />
                </button>
            </div>
        </div>
    );
};

const VndmsCard: React.FC<{
    hazard: VndmsHazard;
    onLocate: (h: VndmsHazard) => void;
}> = ({ hazard, onLocate }) => (
    <div className="bg-white rounded-xl border border-slate-100 shadow-sm overflow-hidden hover:shadow-md transition-shadow">
        <div className="p-3 flex items-start gap-2.5">
            <span className="text-xl flex-shrink-0 mt-0.5">
                {TYPE_EMOJI[hazard.warning_type] ?? "⚠️"}
            </span>
            <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5 flex-wrap mb-1">
                    <span
                        className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
                            SEVERITY_BG[hazard.severity] ?? "bg-slate-100 text-slate-700"
                        }`}
                    >
                        {SEVERITY_LABEL[hazard.severity] ?? hazard.severity}
                    </span>
                    <span className="text-[10px] text-slate-500">
                        {TYPE_LABEL_VI[hazard.warning_type] ?? hazard.warning_type}
                    </span>
                </div>
                <h3 className="font-semibold text-slate-900 text-sm leading-snug truncate">
                    {hazard.label || "(Không tên)"}
                </h3>
                {hazard.value && (
                    <p className="text-xs text-slate-600 mt-0.5">
                        Giá trị: <span className="font-medium">{hazard.value}</span>
                    </p>
                )}
            </div>
            <button
                onClick={() => onLocate(hazard)}
                title="Xem trên bản đồ"
                className="flex-shrink-0 p-1.5 text-blue-600 hover:bg-blue-50 rounded transition-colors"
            >
                <MapPin size={14} />
            </button>
        </div>
    </div>
);

const StoredHazardCard: React.FC<{
    hazard: Hazard;
    onLocate: (h: Hazard) => void;
}> = ({ hazard, onLocate }) => (
    <div
        className="bg-white rounded-xl border border-slate-100 shadow-sm overflow-hidden border-l-4"
        style={{
            borderLeftColor:
                hazard.severity === "critical"
                    ? "#7c3aed"
                    : hazard.severity === "high"
                    ? "#ef4444"
                    : hazard.severity === "medium"
                    ? "#f59e0b"
                    : "#22c55e",
        }}
    >
        <div className="p-3 flex items-start gap-2.5">
            <span className="text-xl flex-shrink-0 mt-0.5">⚠️</span>
            <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5 flex-wrap mb-1">
                    <span
                        className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
                            SEVERITY_BG[hazard.severity as EmergencySeverity] ??
                            "bg-slate-100 text-slate-700"
                        }`}
                    >
                        {SEVERITY_LABEL[hazard.severity] ?? hazard.severity}
                    </span>
                    <span className="text-[10px] text-slate-500">
                        {hazard.event_type}
                    </span>
                </div>
                <h3 className="font-semibold text-slate-900 text-sm leading-snug">
                    {hazard.title}
                </h3>
                {hazard.district && (
                    <p className="text-xs text-slate-500 mt-0.5">
                        📍 {hazard.district}
                    </p>
                )}
            </div>
            <button
                onClick={() => onLocate(hazard)}
                className="flex-shrink-0 p-1.5 text-blue-600 hover:bg-blue-50 rounded"
            >
                <MapPin size={14} />
            </button>
        </div>
    </div>
);

const SafetyHelpModal: React.FC<{ onClose: () => void }> = ({ onClose }) => (
    <div
        className="fixed inset-0 z-[2000] bg-black/50 flex items-center justify-center p-4"
        onClick={onClose}
    >
        <div
            className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-hidden flex flex-col"
            onClick={(e) => e.stopPropagation()}
        >
            <div className="p-5 border-b border-slate-100 flex items-start justify-between bg-gradient-to-r from-red-50 to-orange-50">
                <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-full bg-red-100 flex items-center justify-center">
                        <LifeBuoy className="text-red-600" size={20} />
                    </div>
                    <div>
                        <h2 className="font-bold text-slate-900 text-lg">
                            Hướng dẫn an toàn
                        </h2>
                        <p className="text-xs text-slate-500">
                            Trợ giúp khẩn cấp và nơi trú ẩn
                        </p>
                    </div>
                </div>
                <button
                    onClick={onClose}
                    className="p-1 hover:bg-white/60 rounded transition-colors"
                    aria-label="Đóng hướng dẫn"
                >
                    <X size={18} />
                </button>
            </div>
            <div className="flex-1 overflow-y-auto p-5 space-y-3 text-sm text-slate-700">
                <p className="rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-red-700 font-medium">
                    Khi tính mạng bị đe dọa, gọi ngay 114 (cứu hỏa &amp; cứu nạn)
                    hoặc 112 (cứu hộ khẩn cấp).
                </p>
                <ul className="space-y-2">
                    <li className="rounded-lg bg-slate-50 p-3">
                        Theo dõi cảnh báo mới nhất trên bản đồ này và làm theo
                        hướng dẫn của chính quyền địa phương.
                    </li>
                    <li className="rounded-lg bg-slate-50 p-3">
                        Di chuyển đến nơi trú ẩn kiên cố gần nhất; tránh khu vực
                        ngập sâu, sạt lở và ven sông suối.
                    </li>
                    <li className="rounded-lg bg-slate-50 p-3">
                        Không tự ý vượt qua dòng nước chảy xiết hoặc khu vực đã
                        được phong tỏa.
                    </li>
                    <li className="rounded-lg bg-slate-50 p-3">
                        Giữ điện thoại và pin dự phòng; chuẩn bị nước uống, thuốc
                        và giấy tờ tùy thân.
                    </li>
                </ul>

            </div>
        </div>
    </div>
);

const ShelterModal: React.FC<{
    shelters: NearbyShelter[];
    loading: boolean;
    error: string | null;
    onClose: () => void;
    onRetry: () => void;
}> = ({ shelters, loading, error, onClose, onRetry }) => (
    <div className="fixed inset-0 z-[2000] bg-black/50 flex items-center justify-center p-4" onClick={onClose}>
        <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[85vh] overflow-hidden flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="p-5 border-b border-slate-100 flex items-start justify-between bg-gradient-to-r from-emerald-50 to-sky-50">
                <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-full bg-emerald-100 flex items-center justify-center">
                        <Home className="text-emerald-600" size={20} />
                    </div>
                    <div>
                        <h2 className="font-bold text-slate-900 text-lg">Nơi trú ẩn gần bạn</h2>
                        <p className="text-xs text-slate-500">Đơn vị trú ẩn SOS trong bán kính 20 km</p>
                    </div>
                </div>
                <button onClick={onClose} className="p-1 hover:bg-white/60 rounded transition-colors" aria-label="Đóng danh sách nơi trú ẩn">
                    <X size={18} />
                </button>
            </div>
            <div className="flex-1 overflow-y-auto p-5 space-y-2 text-sm">
                {loading ? <p className="text-slate-500">Đang tìm nơi trú ẩn...</p> : null}
                {error ? (
                    <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-amber-800">
                        <p>{error}</p>
                        <button type="button" onClick={onRetry} className="mt-2 rounded-md border border-amber-300 px-2.5 py-1 text-xs font-medium">
                            Thử lại
                        </button>
                    </div>
                ) : null}
                {!loading && !error && shelters.length === 0 ? (
                    <p className="text-slate-500">Chưa có nơi trú ẩn nào được khai báo gần vị trí của bạn.</p>
                ) : null}
                {shelters.map((shelter) => (
                    <div key={shelter.id} className="rounded-lg border border-slate-200 p-3">
                        <div className="flex items-start justify-between gap-2">
                            <div>
                                <p className="font-semibold text-slate-900">{shelter.name}</p>
                                <p className="text-xs text-slate-500">
                                    {[shelter.ward, shelter.district].filter(Boolean).join(", ") || "Chưa rõ khu vực"}
                                </p>
                            </div>
                            <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-700">
                                {(shelter.distance_m / 1000).toFixed(1)} km
                            </span>
                        </div>
                        {shelter.capacity ? (
                            <p className="mt-1 text-xs text-slate-600">
                                Sức chứa: {shelter.capacity} {shelter.capacity_unit ?? "người"}
                            </p>
                        ) : null}
                        {shelter.contact_phone ? (
                            <a href={`tel:${shelter.contact_phone}`} className="mt-1 inline-block text-xs font-medium text-blue-600">
                                Gọi {shelter.contact_phone}
                            </a>
                        ) : null}
                    </div>
                ))}
            </div>
        </div>
    </div>
);

// ── Main page ────────────────────────────────────────────────────────────────

const PublicHazardMap: React.FC = () => {
    const containerRef = React.useRef<HTMLDivElement | null>(null);
    const mapRef = React.useRef<L.Map | null>(null);
    const tileLayerRef = React.useRef<L.TileLayer | null>(null);
    const userMarkerRef = React.useRef<L.Marker | null>(null);
    const [leafletMap, setLeafletMap] = useState<L.Map | null>(null);

    const [filterChip, setFilterChip] = useState<FilterChip>("all");
    const [userLocation, setUserLocation] = useState<{ lat: number; lng: number } | null>(
        null
    );
    const [geoError, setGeoError] = useState<string | null>(null);
    const [focusedEventId, setFocusedEventId] = useState<string | null>(null);
    const [focusEventNonce, setFocusEventNonce] = useState(0);
    const [focusedHazardId, setFocusedHazardId] = useState<string | null>(null);
    const [focusHazardNonce, setFocusHazardNonce] = useState(0);
    const [showHelp, setShowHelp] = useState(false);
    const [aiQuestion, setAiQuestion] = useState("");
    const [aiAnswer, setAiAnswer] = useState<AiAnswer | null>(null);
    const [aiError, setAiError] = useState<string | null>(null);
    const [aiAsking, setAiAsking] = useState(false);
    const [aiBriefExpanded, setAiBriefExpanded] = useState(false);

    const {
        data: vndmsHazards = [],
        isLoading: vndmsLoading,
        refetch: refetchVndms,
        isFetching: vndmsFetching,
        dataUpdatedAt: vndmsUpdatedAt,
        isError: vndmsError,
    } = useVndmsHazards(true);
    const { data: vndmsStatus } = useVndmsStatus(true);

    const {
        data: storedHazards = [],
        refetch: refetchStored,
        isLoading: storedLoading,
        isError: storedError,
    } = useQuery({
        queryKey: ["hazards", "active-public"],
        queryFn: () => hazardsApi.list({ is_active: true, limit: 200 }),
        staleTime: 60_000,
        refetchInterval: 5 * 60_000,
    });

    const {
        data: aiBrief,
        isLoading: aiBriefLoading,
        isError: aiBriefError,
        isFetching: aiBriefFetching,
        refetch: refetchAiBrief,
    } = useQuery({
        queryKey: ["ai", "brief"],
        queryFn: () => aiApi.brief({ hours: 24, limit: 8 }),
        staleTime: 5 * 60_000,
        refetchInterval: (query) => (query.state.data?.fallback ? 30_000 : 5 * 60_000),
        retry: 1,
    });

    const {
        data: publicEvents = [],
        refetch: refetchEvents,
        isLoading: eventsLoading,
        isError: eventsError,
    } = usePublicEmergencyEvents(true, 100);

    const {
        data: nearbyStored = [],
        isFetching: nearbyFetching,
        isError: nearbyError,
        refetch: refetchNearby,
    } = useQuery({
        queryKey: ["hazards", "near", userLocation?.lat, userLocation?.lng],
        queryFn: () =>
            hazardsApi.nearby({
                lat: userLocation!.lat,
                lng: userLocation!.lng,
                radius_m: NEAR_ME_RADIUS_KM * 1000,
                limit: 200,
            }),
        enabled: filterChip === "near" && !!userLocation,
        staleTime: 60_000,
    });

    const [shelters, setShelters] = useState<NearbyShelter[]>([]);
    const [shelterOpen, setShelterOpen] = useState(false);
    const [shelterLoading, setShelterLoading] = useState(false);
    const [shelterError, setShelterError] = useState<string | null>(null);

    // Initialize the map. The container must have an explicit height (the page
    // body is a full-height flex column) or Leaflet renders a 0px canvas.
    React.useEffect(() => {
        const container = containerRef.current;
        if (!container || mapRef.current) return;

        const map = L.map(container, {
            center: VIETNAM_CENTER,
            zoom: 6,
            maxZoom: 19,
            scrollWheelZoom: true,
        });
        mapRef.current = map;
        setLeafletMap(map);

        let cancelled = false;
        fetchTileConfig()
            .then((cfg) => {
                if (cancelled || mapRef.current !== map) return;
                const tileLayer = L.tileLayer(cfg.tileUrl, {
                    attribution: cfg.attribution,
                    maxZoom: cfg.maxZoom,
                    ...(cfg.maxNativeZoom ? { maxNativeZoom: cfg.maxNativeZoom } : {}),
                });
                tileLayer.addTo(map);
                tileLayerRef.current = tileLayer;
            })
            .catch((err) => {
                console.error("Failed to load tile config", err);
            });

        // The flex layout can settle after mount; make sure Leaflet measures it.
        const resizeFrame = window.requestAnimationFrame(() => {
            if (mapRef.current === map) {
                map.invalidateSize();
            }
        });

        return () => {
            cancelled = true;
            window.cancelAnimationFrame(resizeFrame);
            if (tileLayerRef.current) {
                tileLayerRef.current.remove();
                tileLayerRef.current = null;
            }
            userMarkerRef.current = null;
            map.remove();
            mapRef.current = null;
            setLeafletMap(null);
        };
    }, []);

    // ── Filtering ─────────────────────────────────────────────────────────────
    const filteredVndms = useMemo(() => {
        let arr = vndmsHazards;
        if (filterChip === "critical") {
            arr = arr.filter((h) => h.severity === "high");
        } else if (filterChip === "near" && userLocation) {
            arr = arr.filter(
                (h) =>
                    haversineKm(userLocation, { lat: h.lat, lng: h.lon }) <=
                    NEAR_ME_RADIUS_KM
            );
        }
        return arr;
    }, [vndmsHazards, filterChip, userLocation]);

    const filteredStored = useMemo(() => {
        // Use the server-side radius query when the user selects "Gần tôi";
        // the browser no longer scans only the first page (issue #12).
        let arr = filterChip === "near" && userLocation
            ? nearbyStored.filter((h) => h.is_active !== false)
            : storedHazards;
        if (filterChip === "critical") {
            arr = arr.filter(
                (h) => h.severity === "critical" || h.severity === "high"
            );
        }
        return arr;
    }, [storedHazards, nearbyStored, filterChip, userLocation]);

    const filteredEvents = useMemo(() => {
        let arr = publicEvents;
        if (filterChip === "critical") {
            arr = arr.filter(
                (e) => e.severity === "critical" || e.severity === "high"
            );
        } else if (filterChip === "near" && userLocation) {
            arr = arr.filter((e) => {
                const p = pointFromEvent(e);
                if (!p) return false;
                return haversineKm(userLocation, p) <= NEAR_ME_RADIUS_KM;
            });
        }
        return arr;
    }, [publicEvents, filterChip, userLocation]);

    const handleLocateVndms = useCallback(
        (h: VndmsHazard) => {
            if (!leafletMap) return;
            leafletMap.flyTo([h.lat, h.lon], 11, { animate: true, duration: 1.2 });
        },
        [leafletMap]
    );

    const handleLocateStored = useCallback(
        (h: Hazard) => {
            const p = pointFromHazard(h);
            if (!leafletMap || !p) return;
            leafletMap.flyTo([p.lat, p.lng], 14, { animate: true, duration: 1.2 });
            setFocusedHazardId(h.id);
            setFocusHazardNonce((n) => n + 1);
        },
        [leafletMap]
    );

    const handleLocateEvent = useCallback(
        (e: PublicEmergencyEvent) => {
            const p = pointFromEvent(e);
            if (!leafletMap || !p) return;
            leafletMap.flyTo([p.lat, p.lng], 13, { animate: true, duration: 1.2 });
            setFocusedEventId(e.id);
            setFocusEventNonce((n) => n + 1);
        },
        [leafletMap]
    );

    const totalAlerts =
        publicEvents.length + storedHazards.length + vndmsHazards.length;
    const isFetchingAny = vndmsFetching || nearbyFetching;
    const dataError = vndmsError || storedError || eventsError || nearbyError;
    const dataLoading = vndmsLoading || storedLoading || eventsLoading;
    const vndmsConfigured = vndmsStatus?.status === "ready" || vndmsStatus?.status === "degraded";

    const handleRefreshAll = useCallback(() => {
        refetchVndms();
        refetchStored();
        refetchEvents();
        if (filterChip === "near" && userLocation) void refetchNearby();
    }, [refetchVndms, refetchStored, refetchEvents, refetchNearby, filterChip, userLocation]);

    const handleAskAi = useCallback(async () => {
        const question = aiQuestion.trim();
        if (!question || aiAsking) return;
        setAiAsking(true);
        setAiError(null);
        try {
            setAiAnswer(await aiApi.ask(question, 5));
        } catch (error) {
            console.error("AI ask failed", error);
            setAiError("AI tạm thời không trả lời được. Vui lòng thử lại sau.");
        } finally {
            setAiAsking(false);
        }
    }, [aiQuestion, aiAsking]);

    const handleFindShelters = useCallback(() => {
        if (!navigator.geolocation) {
            setShelterError("Trình duyệt không hỗ trợ định vị.");
            setShelterOpen(true);
            return;
        }
        setShelterOpen(true);
        setShelterLoading(true);
        setShelterError(null);
        navigator.geolocation.getCurrentPosition(
            async (pos) => {
                try {
                    const result = await resourcesApi.nearbyShelters({
                        lat: pos.coords.latitude,
                        lng: pos.coords.longitude,
                        radius_m: 20_000,
                        limit: 20,
                    });
                    setShelters(result.shelters);
                } catch (err) {
                    console.error(err);
                    setShelterError("Không thể tải danh sách nơi trú ẩn.");
                } finally {
                    setShelterLoading(false);
                }
            },
            (err) => {
                setShelterError(err.message || "Không lấy được vị trí của bạn.");
                setShelterLoading(false);
            },
            { enableHighAccuracy: true, timeout: 10_000 }
        );
    }, []);

    // ── Geolocation ──────────────────────────────────────────────────────────
    const handleLocateMe = useCallback(() => {
        if (!navigator.geolocation) {
            setGeoError("Trình duyệt không hỗ trợ định vị");
            return;
        }
        setGeoError(null);
        navigator.geolocation.getCurrentPosition(
            (pos) => {
                const loc = { lat: pos.coords.latitude, lng: pos.coords.longitude };
                setUserLocation(loc);
                if (leafletMap) {
                    leafletMap.flyTo([loc.lat, loc.lng], 13, {
                        animate: true,
                        duration: 1.2,
                    });
                    if (userMarkerRef.current) {
                        userMarkerRef.current.setLatLng([loc.lat, loc.lng]);
                    } else {
                        const icon = L.divIcon({
                            className: "",
                            html: `<div style="
                                width:18px;height:18px;border-radius:50%;
                                background:#2563eb;
                                border:3px solid white;
                                box-shadow:0 0 0 3px rgba(37,99,235,0.35);
                            "></div>`,
                            iconSize: [18, 18],
                            iconAnchor: [9, 9],
                        });
                        userMarkerRef.current = L.marker([loc.lat, loc.lng], { icon }).addTo(
                            leafletMap
                        );
                    }
                }
            },
            (err) => {
                setGeoError(err.message || "Không lấy được vị trí");
            },
            { enableHighAccuracy: true, timeout: 10_000 }
        );
    }, [leafletMap]);

    // ── Render ────────────────────────────────────────────────────────────────
    const eventsForLayer = useMemo(
        () => publicEvents.filter((e) => isOngoingEmergencyStatus(e.status) && !!pointFromEvent(e)),
        [publicEvents]
    );

    const hasNoAlerts = totalAlerts === 0 && !dataError && !dataLoading;

    return (
        <div className="flex flex-col h-screen bg-slate-50 font-sans text-slate-900">
            {/* ── Top bar (red gradient, citizen-first) ── */}
            <header className="bg-gradient-to-r from-red-600 via-red-500 to-orange-500 text-white px-4 py-3 flex items-center gap-3 z-50 relative shadow-md shrink-0">
                <Link to="/" className="hidden sm:block">
                    <h1 className="text-lg font-bold text-white drop-shadow-sm">
                        SynapseCity SOS
                    </h1>
                </Link>
                <div className="hidden sm:block w-px h-6 bg-white/30" />

                <div className="flex items-center gap-2">
                    <Siren className="text-white" size={22} />
                    <div>
                        <h2 className="font-bold text-white text-sm sm:text-base leading-tight">
                            Cảnh báo thiên tai khu vực của bạn
                        </h2>
                        <p className="text-[11px] text-white/80 hidden sm:block">
                            Cập nhật công khai · Dành cho người dân
                            {!vndmsConfigured ? " · nguồn KTTV chưa cấu hình" : " · nguồn KTTV đã kết nối"}
                        </p>
                    </div>
                </div>

                <div className="ml-auto flex items-center gap-2">
                    <div className="hidden sm:flex items-center gap-1.5 px-3 py-1.5 bg-white/15 backdrop-blur border border-white/30 rounded-full text-white text-xs font-bold">
                        <AlertTriangle size={13} />
                        <span>{totalAlerts}</span>
                        <span className="font-medium opacity-90">cảnh báo</span>
                    </div>
                    <button
                        onClick={handleLocateMe}
                        title="Xác định vị trí của tôi"
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/15 hover:bg-white/25 text-white text-sm font-semibold border border-white/30 transition-colors"
                    >
                        <Crosshair size={14} />
                        <span className="hidden md:inline">Vị trí tôi</span>
                    </button>
                    <a
                        href="tel:114"
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white text-red-600 text-sm font-bold hover:bg-red-50 transition-colors shadow"
                        title="Gọi cứu hỏa khẩn cấp"
                    >
                        <Phone size={14} />
                        <span>114</span>
                    </a>
                    <button
                        onClick={handleRefreshAll}
                        disabled={isFetchingAny}
                        title="Làm mới"
                        className="p-2 rounded-lg text-white hover:bg-white/15 transition-colors disabled:opacity-50"
                    >
                        <RefreshCw
                            size={16}
                            className={isFetchingAny ? "animate-spin" : ""}
                        />
                    </button>
                </div>
            </header>

            {/* ── Body: full-width map + floating right panel ── */}
            <div className="flex-1 min-h-0 relative overflow-hidden">
                <div ref={containerRef} className="absolute inset-0 w-full h-full" />

                {leafletMap && filteredVndms.length > 0 && (
                    <VndmsHazardLayer map={leafletMap} hazards={filteredVndms} />
                )}
                {leafletMap && filteredStored.length > 0 && (
                    <HazardMarkersLayer
                        map={leafletMap}
                        hazards={filteredStored}
                        focusedHazardId={focusedHazardId}
                        focusNonce={focusHazardNonce}
                    />
                )}
                {leafletMap && eventsForLayer.length > 0 && (
                    <EmergencyEventsLayer
                        map={leafletMap}
                        events={eventsForLayer}
                        focusedEventId={focusedEventId}
                        focusNonce={focusEventNonce}
                    />
                )}

                {/* Legend bottom-left */}
                <div className="absolute bottom-24 left-4 z-[1000]">
                    <VndmsLegend />
                </div>

                {/* Floating right panel */}
                <aside className="absolute top-3 right-3 bottom-24 w-full max-w-[22rem] z-[1000] flex flex-col bg-white/95 backdrop-blur rounded-2xl border border-slate-200 shadow-xl overflow-hidden">
                    {/* Filter chips */}
                    <div className="p-3 border-b border-slate-100 shrink-0">
                        <div className="flex gap-1.5">
                            {(
                                [
                                    { key: "all", label: "Tất cả" },
                                    { key: "critical", label: "Nghiêm trọng" },
                                    { key: "near", label: "Gần tôi" },
                                ] as const
                            ).map((chip) => {
                                const disabled =
                                    chip.key === "near" && !userLocation;
                                const active = filterChip === chip.key;
                                return (
                                    <button
                                        key={chip.key}
                                        onClick={() => {
                                            if (chip.key === "near" && !userLocation) {
                                                setFilterChip("near");
                                                handleLocateMe();
                                                return;
                                            }
                                            setFilterChip(chip.key);
                                        }}
                                        disabled={disabled && filterChip !== chip.key}
                                        title={
                                            disabled
                                                ? "Cho phép định vị để dùng bộ lọc này"
                                                : undefined
                                        }
                                        className={`flex-1 text-xs font-semibold px-2 py-1.5 rounded-lg border transition-colors ${
                                            active
                                                ? "bg-red-600 text-white border-red-600"
                                                : "bg-white text-slate-700 border-slate-200 hover:bg-slate-50"
                                        } ${
                                            disabled && !active
                                                ? "opacity-60 cursor-not-allowed"
                                                : ""
                                        }`}
                                    >
                                        {chip.label}
                                    </button>
                                );
                            })}
                        </div>
                        {geoError && (
                            <p className="text-[11px] text-red-600 mt-1.5">{geoError}</p>
                        )}
                        <div className="flex items-center gap-1 text-[11px] text-slate-500 mt-2">
                            <Clock size={11} />
                            {vndmsLoading ? (
                                "Đang tải..."
                            ) : (
                                <>
                                    <span>
                                        {filteredEvents.length} chiến dịch ·{" "}
                                        {filteredStored.length + filteredVndms.length}{" "}
                                        cảnh báo
                                    </span>
                                    {vndmsUpdatedAt > 0 && (
                                        <span className="ml-auto text-slate-400">
                                            {timeAgo(vndmsUpdatedAt)}
                                        </span>
                                    )}
                                </>
                            )}
                        </div>
                    </div>

                    {dataError ? (
                        <div className="mx-3 mt-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-[11px] text-amber-900">
                            <p className="font-semibold">Dữ liệu cảnh báo không khả dụng.</p>
                            <p className="mt-0.5">
                                Không thể xác minh khu vực an toàn. Hãy gọi 114 nếu tính mạng bị đe dọa và
                                thử làm mới khi có kết nối.
                            </p>
                        </div>
                    ) : null}

                    {/* List sections */}
                    <div className="flex-1 overflow-y-auto p-3 space-y-4">
                        {/* Section 0: grounded AI situation brief */}
                        <section>
                            <div className="flex items-center justify-between mb-2">
                                <h3 className="text-[11px] uppercase font-bold tracking-wide text-violet-700 flex items-center gap-1">
                                    <Sparkles size={12} /> AI nhận định tình hình
                                </h3>
                                <button
                                    type="button"
                                    onClick={() => void refetchAiBrief()}
                                    disabled={aiBriefFetching}
                                    className="p-1.5 rounded-lg text-violet-600 hover:bg-violet-50 disabled:opacity-40"
                                    title="Làm mới nhận định AI"
                                >
                                    <RefreshCw size={12} className={aiBriefFetching ? "animate-spin" : ""} />
                                </button>
                            </div>
                            <div className="rounded-xl border border-violet-200 bg-violet-50/70 p-3">
                                {aiBriefLoading ? (
                                    <p className="text-[11px] text-slate-500">Đang tổng hợp tình hình…</p>
                                ) : aiBriefError ? (
                                    <div className="text-[11px] text-slate-600">
                                        <p className="font-semibold text-violet-800">AI tạm thời không khả dụng.</p>
                                        <p className="mt-0.5">Bản đồ và cảnh báo chính thức vẫn hoạt động bình thường.</p>
                                        <button
                                            type="button"
                                            onClick={() => void refetchAiBrief()}
                                            className="mt-2 text-[11px] font-bold text-violet-700 underline"
                                        >
                                            Thử lại
                                        </button>
                                    </div>
                                ) : aiBrief ? (
                                    <>
                                        <p
                                            className="text-xs text-slate-700 whitespace-pre-line leading-relaxed"
                                            style={aiBriefExpanded ? undefined : {
                                                display: "-webkit-box",
                                                WebkitLineClamp: 6,
                                                WebkitBoxOrient: "vertical",
                                                overflow: "hidden",
                                            }}
                                        >
                                            {aiBrief.brief}
                                        </p>
                                        {aiBrief.brief.length > 360 && (
                                            <button
                                                type="button"
                                                onClick={() => setAiBriefExpanded((value) => !value)}
                                                className="mt-1 text-[10px] font-bold text-violet-700 underline"
                                            >
                                                {aiBriefExpanded ? "Thu gọn" : "Xem thêm"}
                                            </button>
                                        )}
                                        {aiBrief.hazards.length > 0 && (
                                            <div className="mt-2 flex flex-wrap gap-1">
                                                {aiBrief.hazards.slice(0, 5).map((hazard) => (
                                                    <a
                                                        key={hazard.id}
                                                        href={hazard.url}
                                                        target="_blank"
                                                        rel="noreferrer"
                                                        title={hazard.title}
                                                        className="text-[10px] px-2 py-0.5 rounded-full bg-white border border-violet-200 text-violet-700 hover:bg-violet-100"
                                                    >
                                                        {hazard.title.slice(0, 28)}
                                                        {hazard.title.length > 28 ? "…" : ""}
                                                    </a>
                                                ))}
                                            </div>
                                        )}
                                        <p className="mt-2 text-[10px] text-slate-500">
                                            {aiBrief.fallback
                                                ? "Tóm tắt tất định từ feed cảnh báo"
                                                : `AI · ${aiBrief.model ?? "Tier-2 model"}`}
                                            {" · "}
                                            {new Date(aiBrief.generated_at).toLocaleString("vi-VN")}
                                        </p>
                                    </>
                                ) : null}

                                <div className="mt-3 flex gap-1.5">
                                    <input
                                        value={aiQuestion}
                                        onChange={(e) => setAiQuestion(e.target.value)}
                                        onKeyDown={(e) => {
                                            if (e.key === "Enter") {
                                                e.preventDefault();
                                                void handleAskAi();
                                            }
                                        }}
                                        placeholder="Hỏi AI về tình hình…"
                                        className="flex-1 min-w-0 rounded-lg border border-violet-200 bg-white px-2.5 py-1.5 text-[11px] text-slate-700 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-violet-300"
                                    />
                                    <button
                                        type="button"
                                        onClick={() => void handleAskAi()}
                                        disabled={aiAsking || !aiQuestion.trim()}
                                        className="px-2.5 py-1.5 rounded-lg bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-40"
                                        title="Hỏi AI"
                                    >
                                        <Send size={13} />
                                    </button>
                                </div>
                                {aiError && <p className="mt-2 text-[10px] text-red-600">{aiError}</p>}
                                {aiAnswer && (
                                    <div className="mt-2 rounded-lg border border-violet-100 bg-white p-2.5">
                                        <p className="text-[11px] text-slate-700 whitespace-pre-line leading-relaxed">
                                            {aiAnswer.answer}
                                        </p>
                                        {aiAnswer.citations.length > 0 && (
                                            <div className="mt-1.5 flex flex-wrap gap-1">
                                                {aiAnswer.citations.slice(0, 4).map((citation) =>
                                                    citation.url ? (
                                                        <a
                                                            key={`${citation.documentId}-${citation.index}`}
                                                            href={citation.url}
                                                            target="_blank"
                                                            rel="noreferrer"
                                                            title={citation.title}
                                                            className="text-[10px] px-1.5 py-0.5 rounded bg-violet-50 text-violet-700 hover:bg-violet-100"
                                                        >
                                                            [{citation.index}] {citation.title.slice(0, 24)}
                                                            {citation.title.length > 24 ? "…" : ""}
                                                        </a>
                                                    ) : (
                                                        <span key={`${citation.documentId}-${citation.index}`} className="text-[10px] text-slate-500">
                                                            [{citation.index}] {citation.title.slice(0, 24)}
                                                        </span>
                                                    ),
                                                )}
                                            </div>
                                        )}
                                    </div>
                                )}
                            </div>
                        </section>

                        {/* Section 1: ongoing rescue operations */}
                        <section>
                            <h3 className="text-[11px] uppercase font-bold tracking-wide text-red-600 mb-2 flex items-center gap-1">
                                🚨 Chiến dịch cứu hộ đang diễn ra
                            </h3>
                            {filteredEvents.length === 0 ? (
                                <div className="text-[11px] text-slate-400 italic py-2">
                                    Không có chiến dịch nào đang diễn ra
                                </div>
                            ) : (
                                <div className="space-y-2">
                                    {filteredEvents.map((e) => (
                                        <EventCard
                                            key={e.id}
                                            event={e}
                                            onLocate={handleLocateEvent}
                                        />
                                    ))}
                                </div>
                            )}
                        </section>

                        {/* Section 2: hazards 24h */}
                        <section>
                            <h3 className="text-[11px] uppercase font-bold tracking-wide text-amber-700 mb-2 flex items-center gap-1">
                                ⚠️ Cảnh báo thiên tai hôm nay
                            </h3>
                            <p className="text-[10px] text-slate-500 mb-2">
                                Nguồn NCHMF/VNDMS ·{" "}
                                {vndmsStatus?.last_success_at
                                    ? new Date(vndmsStatus.last_success_at).toLocaleString("vi-VN")
                                    : "đang cập nhật"}
                            </p>
                            {dataError ? (
                                <div className="text-center py-6 text-slate-400">
                                    <ShieldAlert size={28} className="mx-auto mb-2 opacity-30" />
                                    <p className="text-sm text-amber-800 font-semibold">
                                        Không thể xác minh tình trạng an toàn
                                    </p>
                                    <p className="mt-1 text-[11px] text-slate-500">
                                        Nguồn cảnh báo đang lỗi hoặc chưa tải xong.
                                    </p>
                                </div>
                            ) : hasNoAlerts ? (
                                <div className="text-center py-6 text-slate-400">
                                    <ShieldAlert
                                        size={28}
                                        className="mx-auto mb-2 opacity-30"
                                    />
                                    <p className="text-sm text-emerald-700 font-semibold">
                                        Không có cảnh báo đang hoạt động
                                    </p>
                                    <p className="mt-1 text-[11px] text-slate-500">
                                        Dữ liệu đã được tải từ nguồn công khai.
                                    </p>
                                </div>
                            ) : filteredStored.length + filteredVndms.length === 0 ? (
                                <div className="text-[11px] text-slate-400 italic py-2">
                                    Không có cảnh báo phù hợp bộ lọc
                                </div>
                            ) : (
                                <div className="space-y-2">
                                    {filteredStored.map((h) => (
                                        <StoredHazardCard
                                            key={h.id}
                                            hazard={h}
                                            onLocate={handleLocateStored}
                                        />
                                    ))}
                                    {filteredVndms.map((h) => (
                                        <VndmsCard
                                            key={h.id}
                                            hazard={h}
                                            onLocate={handleLocateVndms}
                                        />
                                    ))}
                                </div>
                            )}
                        </section>
                    </div>
                </aside>

                {/* Bottom SOS help bar */}
                <div className="absolute bottom-3 left-3 right-3 z-[1000] flex justify-center pointer-events-none">
                    <div className="bg-white/95 backdrop-blur rounded-2xl border border-slate-200 shadow-xl p-2 flex gap-2 pointer-events-auto">
                        <a
                            href="tel:114"
                            className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-red-600 text-white font-bold hover:bg-red-700 transition-colors shadow-sm"
                        >
                            <Phone size={16} />
                            <span className="text-sm">Gọi 114</span>
                        </a>
                        <button
                            onClick={() => setShowHelp(true)}
                            className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-amber-500 text-white font-bold hover:bg-amber-600 transition-colors shadow-sm"
                        >
                            <LifeBuoy size={16} />
                            <span className="text-sm">Hướng dẫn an toàn</span>
                        </button>
                        <button
                            onClick={handleFindShelters}
                            className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-slate-100 text-slate-600 font-bold hover:bg-slate-200 transition-colors"
                        >
                            <Home size={16} />
                            <span className="text-sm">Nơi trú ẩn gần</span>
                        </button>
                    </div>
                </div>
            </div>

            {showHelp && <SafetyHelpModal onClose={() => setShowHelp(false)} />}
            {shelterOpen && (
                <ShelterModal
                    shelters={shelters}
                    loading={shelterLoading}
                    error={shelterError}
                    onClose={() => setShelterOpen(false)}
                    onRetry={handleFindShelters}
                />
            )}
        </div>
    );
};

export default PublicHazardMap;
