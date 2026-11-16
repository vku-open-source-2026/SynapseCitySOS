// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import axios, {
    type AxiosInstance,
    type AxiosError,
    type InternalAxiosRequestConfig,
} from "axios";
import { useAuthStore } from "../stores";
import { WORKSPACE_URL } from "./workspace";
import type { AxiosResponse } from "axios";

export { asList, isNonListPayload } from "./asList";

// Create main API instance
// Force HTTPS in production
const getApiBaseUrl = () => {
    const url = import.meta.env.VITE_BASE_API_URL || "/v1";
    if (typeof window !== 'undefined' && window.location.protocol === 'https:' && url.startsWith('http://')) {
        return url.replace('http://', 'https://');
    }
    return url;
};

export const httpClient: AxiosInstance = axios.create({
    baseURL: getApiBaseUrl(),
    timeout: 30000,
    headers: {
        "Content-Type": "application/json",
    },
});

// Request interceptor for adding auth token
const requestInterceptor = (config: InternalAxiosRequestConfig) => {
    const token = useAuthStore.getState().accessToken;

    if (token && config.headers) {
        config.headers.Authorization = `Bearer ${token}`;
    }

    return config;
};

// Request error interceptor
const requestErrorInterceptor = (error: AxiosError) => {
    console.error("Request Error:", error);
    return Promise.reject(error);
};

// Response interceptor for handling errors
const responseInterceptor = (response: AxiosResponse) => {
    return response;
};

// Response error interceptor
const responseErrorInterceptor = (error: AxiosError) => {
    if (error.response) {
        const { status } = error.response;

        switch (status) {
            case 401:
                // Tier 3 has no login page: work surfaces live in the DX
                // workspace. Clear the session and go to the fixed workspace
                // URL — never a token or return target in the URL.
                useAuthStore.getState().logout();
                if (typeof window !== 'undefined') {
                    window.location.assign(WORKSPACE_URL);
                }
                break;

            case 403:
                console.error("Access forbidden: the session lacks the required emergency permission");
                break;

            case 404:
                console.error("Resource not found");
                break;

            case 500:
                console.error("Server error");
                break;

            default:
                console.error(`Error ${status}:`, error.message);
        }
    } else if (error.request) {
        // Request was made but no response received
        console.error("Network Error:", error.message);
    } else {
        // Something happened in setting up the request
        console.error("Request Setup Error:", error.message);
    }

    return Promise.reject(error);
};

// Apply interceptors to main API
httpClient.interceptors.request.use(
    requestInterceptor,
    requestErrorInterceptor
);
httpClient.interceptors.response.use(
    responseInterceptor,
    responseErrorInterceptor
);

export default httpClient;
