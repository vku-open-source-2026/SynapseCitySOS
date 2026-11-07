// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import Header from "../components/Header";
import Footer from "../components/Footer";
import { Code, Database, Copy, Check, Play, Loader2 } from "lucide-react";
import { useState } from "react";

const API_BASE_URL = "https://sos.synapsecity.sbs";

interface EndpointParam {
    name: string;
    type: string;
    desc: string;
    default?: string;
}

interface Endpoint {
    method: string;
    path: string;
    title: string;
    description: string;
    params?: EndpointParam[];
    testPath?: string;
    requiresAuth?: boolean;
}

interface EndpointSection {
    id: string;
    label: string;
    icon: string;
    title: string;
    description: string;
    endpoints: Endpoint[];
}

/**
 * SOS-owned namespaces only:
 * /v1/sos, /v1/auth, /v1/emergency*, /v1/hazards*, /v1/geo, /v1/map, /v1/ai.
 * City-infrastructure APIs are documented by the SynapseCity product.
 */
const sections: EndpointSection[] = [
    {
        id: "auth",
        label: "Phiên đăng nhập",
        icon: "🔐",
        title: "Auth shell",
        description:
            "Phiên đăng nhập dùng token HMAC-SHA256. Đây là shell phiên làm việc, không lưu mật khẩu và không tạo bản ghi người dùng; production phải uỷ quyền danh tính cho dịch vụ định danh.",
        endpoints: [
            {
                method: "POST",
                path: "/v1/auth/login",
                title: "Đăng nhập",
                description:
                    "Nhận username + password (không rỗng) và trả access/refresh token cùng hồ sơ phiên.",
            },
            {
                method: "POST",
                path: "/v1/auth/register",
                title: "Đăng ký shell",
                description:
                    "Tạo phiên đăng ký shell-only; không tạo bản ghi người dùng SOS hoặc City.",
            },
            {
                method: "POST",
                path: "/v1/auth/refresh",
                title: "Làm mới token",
                description: "Xoay access/refresh token từ refresh token còn hiệu lực.",
            },
            {
                method: "POST",
                path: "/v1/auth/logout",
                title: "Đăng xuất",
                description: "Kết thúc phiên phía client (204).",
            },
            {
                method: "POST",
                path: "/v1/auth/change-password",
                title: "Đổi mật khẩu",
                description:
                    "Yêu cầu Bearer. Endpoint này xác nhận yêu cầu đổi mật khẩu của phiên hiện tại.",
                requiresAuth: true,
            },
            {
                method: "GET",
                path: "/v1/auth/me",
                title: "Hồ sơ phiên",
                description: "Trả hồ sơ AuthUser từ Bearer token.",
                requiresAuth: true,
            },
            {
                method: "GET",
                path: "/v1/auth/verify",
                title: "Kiểm tra token",
                description: "Xác thực Bearer token và trả thời hạn phiên.",
                requiresAuth: true,
            },
        ],
    },
    {
        id: "service",
        label: "Dịch vụ SOS",
        icon: "🛰️",
        title: "Thông tin dịch vụ",
        description:
            "Kiểm tra sức khỏe dịch vụ và các năng lực đang hoạt động.",
        endpoints: [
            {
                method: "GET",
                path: "/health",
                title: "Health check",
                description: "Trạng thái sống của dịch vụ SOS và các phụ thuộc công khai.",
                testPath: "/health",
            },
            {
                method: "GET",
                path: "/ready",
                title: "Readiness check",
                description: "Sẵn sàng nhận lưu lượng sau khi kiểm tra phụ thuộc dịch vụ nền.",
                testPath: "/ready",
            },
            {
                method: "GET",
                path: "/v1/sos",
                title: "Năng lực sản phẩm SOS",
                description:
                    "Liệt kê các năng lực đang hoạt động (thiên tai, sự kiện, EOP, điều phối, nguồn lực, SITREP, AAR).",
                testPath: "/v1/sos",
            },
        ],
    },
    {
        id: "emergency",
        label: "Sự kiện khẩn cấp",
        icon: "🚨",
        title: "Sự kiện khẩn cấp",
        description:
            "Tiếp nhận, cập nhật, đóng sự kiện và công bố sự kiện ra bản đồ công khai.",
        endpoints: [
            {
                method: "GET",
                path: "/v1/emergency",
                title: "Danh sách sự kiện",
                description: "Lọc sự kiện khẩn cấp theo trạng thái, mức độ và loại.",
                params: [
                    { name: "status", type: "string", desc: "monitoring | active | contained | resolved | canceled" },
                    { name: "severity", type: "string", desc: "low | medium | high | critical" },
                    { name: "event_type", type: "string", desc: "flood | storm | landslide | ..." },
                    { name: "limit", type: "integer", desc: "Số bản ghi tối đa", default: "50" },
                ],
                testPath: "/v1/emergency?limit=5",
            },
            {
                method: "POST",
                path: "/v1/emergency",
                title: "Tạo sự kiện khẩn cấp",
                description:
                    "Tạo sự kiện với tiêu đề, loại, mức độ, vị trí và hướng dẫn công khai.",
            },
            {
                method: "GET",
                path: "/v1/emergency/{event_id}",
                title: "Chi tiết sự kiện",
                description: "Lấy đầy đủ thông tin của một sự kiện khẩn cấp.",
            },
            {
                method: "PUT",
                path: "/v1/emergency/{event_id}",
                title: "Cập nhật sự kiện",
                description: "Cập nhật trạng thái, mức độ, mô tả và hướng dẫn.",
            },
            {
                method: "POST",
                path: "/v1/emergency/{event_id}/resolve",
                title: "Đóng sự kiện",
                description: "Đánh dấu sự kiện đã xử lý và tạo đúng một AAR nháp (idempotent) từ dữ liệu sự kiện/điều phối/SITREP.",
            },
            {
                method: "GET",
                path: "/v1/emergency/public",
                title: "Sự kiện công khai",
                description:
                    "Danh sách sự kiện đã công bố cho bản đồ cảnh báo công cộng (không cần đăng nhập).",
                testPath: "/v1/emergency/public?limit=5",
            },
            {
                method: "GET",
                path: "/v1/emergency/sos/timeline",
                title: "SOS timeline",
                description:
                    "Dòng thời gian sự kiện SOS kèm số lần vi phạm SLA và nguồn tham chiếu.",
                testPath: "/v1/emergency/sos/timeline?limit=10",
            },
            {
                method: "GET",
                path: "/v1/emergency/sosconn/status",
                title: "Trạng thái SOSConn",
                description: "Kiểm tra thật trạng thái dịch vụ nền và năng lực AI; AI trả về capability_unavailable cho tới khi dịch vụ nền phát hành.",
            },
        ],
    },
    {
        id: "hazards",
        label: "Thiên tai",
        icon: "🌊",
        title: "Cảnh báo thiên tai & VNDMS",
        description:
            "Nguồn cảnh báo lũ, bão, sạt lở; dữ liệu recent 24h và triển khai cảnh báo thành sự kiện.",
        endpoints: [
            {
                method: "GET",
                path: "/v1/hazards",
                title: "Danh sách cảnh báo",
                description: "Lọc cảnh báo đang hoạt động theo loại, mức độ và nguồn.",
                params: [
                    { name: "active_only", type: "boolean", desc: "Chỉ lấy cảnh báo đang hoạt động" },
                    { name: "event_type", type: "string", desc: "flood | storm | landslide | ..." },
                    { name: "limit", type: "integer", desc: "Số bản ghi tối đa", default: "100" },
                ],
                testPath: "/v1/hazards?active_only=true&limit=5",
            },
            {
                method: "GET",
                path: "/v1/hazards/recent",
                title: "Cảnh báo gần đây",
                description: "Cảnh báo trong N giờ gần nhất, kèm liên kết sự kiện đã triển khai.",
                params: [
                    { name: "hours", type: "integer", desc: "Khoảng thời gian (giờ)", default: "24" },
                    { name: "limit", type: "integer", desc: "Số bản ghi tối đa", default: "200" },
                ],
                testPath: "/v1/hazards/recent?hours=24&limit=5",
            },
            {
                method: "GET",
                path: "/v1/hazards/geo/near",
                title: "Cảnh báo quanh một điểm",
                description: "Tìm cảnh báo trong bán kính cho trước quanh tọa độ.",
                params: [
                    { name: "lat", type: "number", desc: "Vĩ độ" },
                    { name: "lng", type: "number", desc: "Kinh độ" },
                    { name: "radius_m", type: "integer", desc: "Bán kính mét", default: "10000" },
                ],
            },
            {
                method: "POST",
                path: "/v1/hazards/geo/in-polygon",
                title: "Cảnh báo trong đa giác",
                description: "Lọc cảnh báo nằm trong GeoJSON Polygon/MultiPolygon; trả 400 invalid_geometry nếu sai.",
            },
            {
                method: "GET",
                path: "/v1/hazards/ingest/status",
                title: "Trạng thái nhập VNDMS",
                description: "Trạng thái thật từ run history: unconfigured | ready | degraded | stale | error.",
            },
            {
                method: "POST",
                path: "/v1/hazards/ingest",
                title: "Nhập lô VNDMS",
                description: "Chuẩn hóa, validate và upsert theo hazard_id; lịch chạy thuộc dịch vụ nền scheduled work.",
                requiresAuth: true,
            },
            {
                method: "POST",
                path: "/v1/hazards/{hazard_id}/deploy",
                title: "Triển khai cảnh báo",
                description:
                    "Tạo sự kiện khẩn cấp và bản nháp EOP từ một cảnh báo (idempotent).",
            },
            {
                method: "POST",
                path: "/v1/hazards/expire-stale",
                title: "Hết hạn cảnh báo cũ",
                description:
                    "Đánh dấu cảnh báo đang hoạt động cũ hơn TTL (mặc định 24 giờ) thành is_active=false và status=expired.",
                requiresAuth: true,
            },
            {
                method: "GET",
                path: "/v1/emergency/stream/hazards",
                title: "Live hazard SSE",
                description:
                    "Server-Sent Events đẩy snapshot cảnh báo công khai; khi dịch vụ nền lỗi phát event error và giữ snapshot tốt nhất, không phát snapshot rỗng.",
            },
        ],
    },
    {
        id: "eop",
        label: "EOP",
        icon: "📋",
        title: "Kế hoạch ứng phó (EOP)",
        description:
            "Sinh bản nháp EOP từ mẫu nghiệp vụ deterministic (dịch vụ nền AI chưa khả dụng), duyệt, xuất bản và sinh task.",
        endpoints: [
            {
                method: "GET",
                path: "/v1/emergency/eop",
                title: "Danh sách EOP",
                description: "Lọc theo sự kiện và trạng thái kế hoạch.",
                params: [
                    { name: "emergency_event_id", type: "string", desc: "ID sự kiện khẩn cấp" },
                    { name: "status", type: "string", desc: "draft | review_pending | approved | published | archived" },
                ],
                testPath: "/v1/emergency/eop?limit=5",
            },
            {
                method: "POST",
                path: "/v1/emergency/eop/generate-draft",
                title: "Sinh bản nháp EOP",
                description:
                    "Sinh bản nháp EOP bằng AI dịch vụ nền từ sự kiện, cảnh báo và nguồn lực; force_new_version tăng version, không tạo trùng v1. Metadata ghi generated_by=ai (model, prompt_version, usage). AI không khả dụng trả 503 ai_capability_unavailable; fallback=deterministic là lựa chọn tường minh.",
            },
            {
                method: "PATCH",
                path: "/v1/emergency/eop/{plan_id}/markdown",
                title: "Cập nhật markdown",
                description: "Chỉnh sửa nội dung markdown của bản nháp/kế hoạch.",
            },
            {
                method: "POST",
                path: "/v1/emergency/eop/{plan_id}/approve",
                title: "Duyệt EOP",
                description: "Chuyển kế hoạch sang trạng thái đã duyệt kèm ghi chú.",
            },
            {
                method: "POST",
                path: "/v1/emergency/eop/{plan_id}/publish",
                title: "Xuất bản EOP",
                description: "Công bố kế hoạch cho các đơn vị ứng cứu.",
            },
            {
                method: "POST",
                path: "/v1/emergency/eop/{plan_id}/submit",
                title: "Gửi EOP & sinh nhiệm vụ",
                description: "Gửi kế hoạch và sinh các lệnh điều phối tương ứng.",
            },
        ],
    },
    {
        id: "dispatch",
        label: "Điều phối",
        icon: "🚑",
        title: "Lệnh điều phối & nguồn lực",
        description:
            "Phân công đơn vị ứng cứu, tối ưu lộ trình và quản lý trạng thái nguồn lực.",
        endpoints: [
            {
                method: "GET",
                path: "/v1/emergency/dispatch",
                title: "Danh sách lệnh điều phối",
                description: "Lọc theo sự kiện, trạng thái và mức ưu tiên.",
                testPath: "/v1/emergency/dispatch?limit=5",
            },
            {
                method: "POST",
                path: "/v1/emergency/dispatch/{order_id}/approve",
                title: "Duyệt & phân công",
                description:
                    "Duyệt lệnh điều phối và gán một đơn vị ứng cứu (resource unit id).",
            },
            {
                method: "POST",
                path: "/v1/emergency/dispatch/{order_id}/reject",
                title: "Từ chối lệnh",
                description: "Từ chối lệnh điều phối đang chờ.",
            },
            {
                method: "POST",
                path: "/v1/emergency/dispatch/optimize",
                title: "Tối ưu điều phối",
                description: "Gán nguồn lực available tương thích, tính ETA, đánh dấu quá hạn; số liệu trả về khớp bản ghi đã cập nhật.",
            },
            {
                method: "GET",
                path: "/v1/emergency/resources",
                title: "Danh sách nguồn lực",
                description:
                    "Đơn vị ứng cứu, phương tiện, vật tư y tế, thiết bị cứu hộ và nơi trú ẩn.",
                params: [
                    { name: "status", type: "string", desc: "available | deployed | standby | offline | maintenance" },
                    { name: "resource_type", type: "string", desc: "personnel | vehicle | medical_supply | rescue_equipment | shelter" },
                    { name: "district", type: "string", desc: "Lọc theo quận/huyện" },
                ],
                testPath: "/v1/emergency/resources?limit=5",
            },
            {
                method: "POST",
                path: "/v1/emergency/resources/{resource_id}/status",
                title: "Cập nhật trạng thái nguồn lực",
                description: "Chuyển nguồn lực giữa các trạng thái vận hành.",
            },
        ],
    },
    {
        id: "sitrep",
        label: "SITREP & AAR",
        icon: "📝",
        title: "SITREP & báo cáo sau sự kiện",
        description:
            "Báo cáo tình hình hiện trường, delta cập nhật và after-action report tổng kết KPI.",
        endpoints: [
            {
                method: "GET",
                path: "/v1/emergency/sitrep",
                title: "Danh sách SITREP",
                description: "Lọc báo cáo tình hình theo sự kiện và trạng thái xuất bản.",
                testPath: "/v1/emergency/sitrep?limit=5",
            },
            {
                method: "POST",
                path: "/v1/emergency/sitrep",
                title: "Tạo SITREP",
                description: "Bắt buộc emergency_event_id, title và reporting period; số thương vong/thiệt hại là số nguyên không âm.",
            },
            {
                method: "POST",
                path: "/v1/emergency/sitrep/{sitrep_id}/delta",
                title: "Thêm delta SITREP",
                description: "Delta trên báo cáo đã publish tạo revision mới (amends_sitrep_id); báo cáo gốc bất biến.",
            },
            {
                method: "GET",
                path: "/v1/emergency/after-action",
                title: "Danh sách AAR",
                description: "Báo cáo sau sự kiện kèm điểm KPI tổng thể.",
                testPath: "/v1/emergency/after-action?limit=5",
            },
            {
                method: "POST",
                path: "/v1/emergency/after-action/generate",
                title: "Tạo AAR",
                description: "Tính KPI/timeline thật từ event + dispatch + SITREP + resource; force_regenerate tạo version mới.",
            },
            {
                method: "POST",
                path: "/v1/emergency/after-action/{report_id}/publish",
                title: "Xuất bản AAR",
                description: "Công bố báo cáo sau sự kiện.",
            },
        ],
    },
    {
        id: "geo",
        label: "Bản đồ & AI",
        icon: "🗺️",
        title: "Bản đồ, geocode & AI",
        description:
            "Cấu hình tile và geocoding cho bản đồ công khai. Trợ lý AI trả 503 cho tới khi dịch vụ nền AI capability tồn tại.",
        endpoints: [
            {
                method: "GET",
                path: "/v1/map/config",
                title: "Cấu hình tile bản đồ",
                description:
                    "Trả về tile URL, attribution và giới hạn zoom cho bản đồ SOS.",
                testPath: "/v1/map/config",
            },
            {
                method: "POST",
                path: "/v1/geo/geocode",
                title: "Geocode địa chỉ",
                description: "Chuyển địa chỉ thành tọa độ để định vị trên bản đồ.",
            },
            {
                method: "POST",
                path: "/v1/geo/reverse-geocode",
                title: "Reverse geocode",
                description: "Chuyển tọa độ thành địa chỉ hiển thị.",
            },
            {
                method: "GET",
                path: "/v1/geo/search-address",
                title: "Gợi ý địa chỉ",
                description: "Tìm kiếm địa chỉ và trả về danh sách gợi ý.",
            },
            {
                method: "POST",
                path: "/v1/ai/chat",
                title: "Trợ lý AI SOS",
                description:
                    "Trả 503 ai_capability_unavailable khi dịch vụ nền chưa có AI; không trả câu trả lời tĩnh giả lập.",
            },
        ],
    },
];

const codeExamples = {
    curl: `# Lấy cảnh báo đang hoạt động
curl -X GET "${API_BASE_URL}/v1/hazards?active_only=true&limit=10" \\
  -H "Accept: application/json"

# Lấy sự kiện công khai cho bản đồ
curl -X GET "${API_BASE_URL}/v1/emergency/public?limit=10" \\
  -H "Accept: application/json"`,
    javascript: `// Theo dõi cảnh báo công khai
const response = await fetch(
  '${API_BASE_URL}/v1/emergency/public?limit=10'
);
const events = await response.json();

for (const event of events) {
  console.log(event.title, event.severity, event.location?.district);
}`,
    python: `import requests

response = requests.get(
    '${API_BASE_URL}/v1/hazards',
    params={'active_only': True, 'limit': 10},
)
hazards = response.json()

for hazard in hazards:
    print(hazard['title'], hazard['severity'], hazard['event_type'])`,
};

const sseExample = `// Live hazard stream trong trung tâm chỉ huy
const stream = new EventSource(
  '${API_BASE_URL}/v1/emergency/stream/hazards?access_token=<token>'
);

stream.addEventListener('hazards', (event) => {
  const payload = JSON.parse(event.data);
  // payload.snapshot hoặc payload.delta
  console.log(payload);
});`;

function CopyButton({ text }: { text: string }) {
    const [copied, setCopied] = useState(false);

    const handleCopy = async () => {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    return (
        <button
            onClick={handleCopy}
            className="p-2 rounded-md bg-slate-700 hover:bg-slate-600 transition-colors"
            title="Sao chép vào clipboard"
        >
            {copied ? (
                <Check size={16} className="text-green-400" />
            ) : (
                <Copy size={16} className="text-slate-300" />
            )}
        </button>
    );
}

function endpointRequiresAuth(endpoint: Endpoint): boolean {
    if (endpoint.requiresAuth) return true;
    const path = endpoint.path;
    if (path.startsWith("/v1/emergency/public") || path === "/v1/emergency/stream/hazards") return false;
    if (path === "/v1/hazards/recent" || path.startsWith("/v1/hazards/recent/")) return false;
    if (path.startsWith("/v1/hazards/geo/") || path === "/v1/hazards/vndms-live") return false;
    if (path === "/v1/sos" || path.startsWith("/v1/geo") || path.startsWith("/v1/map") || path.startsWith("/v1/ai")) return false;
    if (path.startsWith("/v1/auth")) return Boolean(endpoint.requiresAuth);
    if (path.startsWith("/v1/hazards")) {
        if (endpoint.method === "GET" || endpoint.method === "HEAD") return false;
        return true;
    }
    return path.startsWith("/v1/emergency");
}

function EndpointCard({ endpoint }: { endpoint: Endpoint }) {
    const [isLoading, setIsLoading] = useState(false);
    const [response, setResponse] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const requiresAuth = endpointRequiresAuth(endpoint);

    const handleTest = async () => {
        if (!endpoint.testPath) {
            return;
        }
        setIsLoading(true);
        setError(null);
        setResponse(null);

        try {
            const res = await fetch(`${API_BASE_URL}${endpoint.testPath}`);
            const data = await res.json();
            setResponse(JSON.stringify(data, null, 2));
        } catch (err) {
            setError(err instanceof Error ? err.message : "Đã xảy ra lỗi");
        } finally {
            setIsLoading(false);
        }
    };

    return (
        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
            <div className="p-6">
                <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
                    <div className="flex items-center gap-3">
                        <span className="px-3 py-1 bg-emerald-100 text-emerald-700 text-sm font-mono font-semibold rounded">
                            {endpoint.method}
                        </span>
                        <code className="text-slate-800 font-mono text-sm">
                            {endpoint.path}
                        </code>
                    </div>
                    {requiresAuth && (
                        <span className="px-2 py-1 bg-amber-100 text-amber-700 text-xs font-semibold rounded">
                            Bearer
                        </span>
                    )}
                    {endpoint.testPath && !requiresAuth && (
                        <button
                            onClick={handleTest}
                            disabled={isLoading}
                            className="inline-flex items-center gap-2 px-4 py-2 bg-gradient-to-r from-red-600 to-orange-500 text-white font-medium rounded-lg hover:shadow-lg transition-all disabled:opacity-50"
                        >
                            {isLoading ? (
                                <Loader2 size={16} className="animate-spin" />
                            ) : (
                                <Play size={16} />
                            )}
                            Thử
                        </button>
                    )}
                </div>
                <h3 className="text-lg font-semibold text-slate-900 mb-1">
                    {endpoint.title}
                </h3>
                <p className="text-slate-600">{endpoint.description}</p>
                {requiresAuth && (
                    <p className="mt-2 text-xs text-amber-700">
                        Yêu cầu header <code className="font-mono">Authorization: Bearer &lt;access_token&gt;</code>.
                    </p>
                )}

                {endpoint.params && (
                    <div className="mt-4">
                        <h4 className="text-sm font-semibold text-slate-700 mb-2">
                            Tham số:
                        </h4>
                        <div className="bg-slate-50 rounded-lg p-4 overflow-x-auto">
                            <table className="w-full text-sm">
                                <thead>
                                    <tr className="text-left text-slate-500">
                                        <th className="pb-2 pr-4">Tên</th>
                                        <th className="pb-2 pr-4">Loại</th>
                                        <th className="pb-2">Mô tả</th>
                                    </tr>
                                </thead>
                                <tbody className="text-slate-700">
                                    {endpoint.params.map((param) => (
                                        <tr key={param.name}>
                                            <td className="py-1 pr-4 font-mono text-red-600">
                                                {param.name}
                                            </td>
                                            <td className="py-1 pr-4 text-slate-500">
                                                {param.type}
                                            </td>
                                            <td className="py-1">
                                                {param.desc}
                                                {param.default ? (
                                                    <span className="text-slate-400">
                                                        {" "}
                                                        (mặc định: {param.default})
                                                    </span>
                                                ) : null}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </div>
                )}

                {(response || error || isLoading) && (
                    <div className="mt-4">
                        <div className="bg-slate-900 rounded-lg overflow-hidden">
                            <div className="flex items-center justify-between px-4 py-2 border-b border-slate-700">
                                <span className="text-xs text-slate-400">
                                    {error ? "Lỗi" : "application/json"}
                                </span>
                                {response && <CopyButton text={response} />}
                            </div>
                            <div className="p-4 max-h-96 overflow-auto">
                                {isLoading && (
                                    <div className="flex items-center justify-center py-8">
                                        <Loader2
                                            size={24}
                                            className="animate-spin text-red-400"
                                        />
                                    </div>
                                )}
                                {error && (
                                    <p className="text-red-400 text-sm">{error}</p>
                                )}
                                {response && (
                                    <pre className="text-sm text-slate-300 overflow-x-auto">
                                        <code>{response}</code>
                                    </pre>
                                )}
                            </div>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}

export default function ApiDocsPage() {
    const [activeTab, setActiveTab] = useState<"curl" | "javascript" | "python">(
        "javascript"
    );

    const scrollToSection = (id: string) => {
        const el = document.getElementById(id);
        if (el) {
            el.scrollIntoView({ behavior: "smooth", block: "start" });
        }
    };

    return (
        <div className="min-h-screen bg-gradient-to-b from-slate-50 to-white">
            <Header />

            {/* Sidebar - fixed on desktop */}
            <aside className="hidden lg:block fixed left-0 top-20 w-56 h-[calc(100vh-5rem)] bg-white border-r border-slate-200 p-4 overflow-y-auto z-40">
                <nav className="space-y-1">
                    <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3 px-3">
                        Điều hướng
                    </h3>
                    {sections.map((section) => (
                        <button
                            key={section.id}
                            onClick={() => scrollToSection(section.id)}
                            className="w-full flex items-center gap-3 px-3 py-2 text-sm text-slate-700 hover:bg-slate-100 hover:text-red-600 rounded-lg transition-colors text-left"
                        >
                            <span>{section.icon}</span>
                            <span>{section.label}</span>
                        </button>
                    ))}
                    <button
                        onClick={() => scrollToSection("examples")}
                        className="w-full flex items-center gap-3 px-3 py-2 text-sm text-slate-700 hover:bg-slate-100 hover:text-red-600 rounded-lg transition-colors text-left"
                    >
                        <span>💻</span>
                        <span>Ví dụ mã</span>
                    </button>
                </nav>
            </aside>

            <main className="pt-24 pb-16 lg:ml-56">
                {/* Hero */}
                <section className="max-w-6xl mx-auto px-4 mb-14">
                    <div className="text-center mb-10">
                        <div className="inline-flex items-center gap-2 bg-red-100 text-red-700 px-4 py-2 rounded-full text-sm font-medium mb-4">
                            <Database size={16} />
                            API điều hành khẩn cấp
                        </div>
                        <h1 className="text-4xl md:text-5xl font-bold text-slate-900 mb-4">
                            Tài liệu API SynapseCity SOS
                        </h1>
                        <p className="text-xl text-slate-600 max-w-2xl mx-auto">
                            Cảnh báo thiên tai, sự kiện khẩn cấp, EOP, điều phối
                            nguồn lực, SITREP (có validate) và báo cáo sau sự kiện (KPI thật).
                        </p>
                    </div>

                    <div className="grid md:grid-cols-3 gap-4">
                        <div className="rounded-xl border border-slate-200 bg-white p-4">
                            <p className="text-xs uppercase tracking-wide text-slate-500">
                                Base URL
                            </p>
                            <code className="mt-1 block text-sm font-mono text-slate-800 break-all">
                                {API_BASE_URL}
                            </code>
                        </div>
                        <div className="rounded-xl border border-slate-200 bg-white p-4">
                            <p className="text-xs uppercase tracking-wide text-slate-500">
                                Namespaces
                            </p>
                            <code className="mt-1 block text-sm font-mono text-slate-800">
                                /v1/sos · /v1/auth · /v1/emergency · /v1/hazards
                            </code>
                        </div>
                        <div className="rounded-xl border border-slate-200 bg-white p-4">
                            <p className="text-xs uppercase tracking-wide text-slate-500">
                                Định dạng
                            </p>
                            <p className="mt-1 text-sm text-slate-800">
                                JSON, GeoJSON, SSE
                            </p>
                        </div>
                    </div>
                </section>

                {/* Endpoint sections */}
                {sections.map((section) => (
                    <section
                        key={section.id}
                        id={section.id}
                        className="max-w-6xl mx-auto px-4 mb-14 scroll-mt-24"
                    >
                        <h2 className="text-2xl font-bold text-slate-900 mb-2 flex items-center gap-3">
                            <Code size={26} className="text-red-600" />
                            {section.title}
                        </h2>
                        <p className="text-slate-500 mb-6">{section.description}</p>
                        <div className="space-y-4">
                            {section.endpoints.map((endpoint) => (
                                <EndpointCard
                                    key={`${endpoint.method}-${endpoint.path}`}
                                    endpoint={endpoint}
                                />
                            ))}
                        </div>
                    </section>
                ))}

                {/* Code examples */}
                <section
                    id="examples"
                    className="max-w-6xl mx-auto px-4 mb-14 scroll-mt-24"
                >
                    <h2 className="text-2xl font-bold text-slate-900 mb-6">
                        Ví dụ mã
                    </h2>

                    <div className="bg-slate-900 rounded-2xl overflow-hidden">
                        <div className="flex border-b border-slate-700">
                            {(["javascript", "python", "curl"] as const).map((tab) => (
                                <button
                                    key={tab}
                                    onClick={() => setActiveTab(tab)}
                                    className={`px-6 py-3 text-sm font-medium transition-colors ${
                                        activeTab === tab
                                            ? "bg-slate-800 text-white"
                                            : "text-slate-400 hover:text-white"
                                    }`}
                                >
                                    {tab.charAt(0).toUpperCase() + tab.slice(1)}
                                </button>
                            ))}
                        </div>
                        <div className="relative p-6">
                            <div className="absolute top-2 right-2">
                                <CopyButton text={codeExamples[activeTab]} />
                            </div>
                            <pre className="text-sm text-slate-300 overflow-x-auto">
                                <code>{codeExamples[activeTab]}</code>
                            </pre>
                        </div>
                    </div>

                    <h3 className="text-lg font-semibold text-slate-900 mt-8 mb-3">
                        Live hazard stream (SSE)
                    </h3>
                    <div className="bg-slate-900 rounded-2xl overflow-hidden">
                        <div className="relative p-6">
                            <div className="absolute top-2 right-2">
                                <CopyButton text={sseExample} />
                            </div>
                            <pre className="text-sm text-slate-300 overflow-x-auto">
                                <code>{sseExample}</code>
                            </pre>
                        </div>
                    </div>
                </section>
            </main>

            <div className="lg:ml-56">
                <Footer />
            </div>
        </div>
    );
}
