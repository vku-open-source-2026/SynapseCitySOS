// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { httpClient } from '../lib/httpClient';

export interface AiHazardCitation {
    id: string;
    hazard_id: string;
    title: string;
    event_type: string;
    severity: string;
    provinces: string[];
    published_at: string;
    url: string;
}

export interface AiBrief {
    brief: string;
    hazards: AiHazardCitation[];
    model: string | null;
    fallback: boolean;
    generated_at: string;
    hours: number;
    provider: string;
}

export interface AiAnswerCitation {
    index: number;
    title: string;
    documentId: string;
    url?: string;
    publishedAt?: string;
}

export interface AiAnswer {
    answer: string;
    citations: AiAnswerCitation[];
    entities: string[];
    noAnswer: boolean;
    model: string | null;
    provider: string;
}

export const aiApi = {
    brief: async (params?: { hours?: number; limit?: number; focus?: string }): Promise<AiBrief> => {
        const response = await httpClient.post<AiBrief>('/ai/brief', {
            hours: params?.hours ?? 24,
            limit: params?.limit ?? 8,
            ...(params?.focus ? { focus: params.focus } : {}),
        });
        return response.data;
    },

    ask: async (question: string, topK = 5): Promise<AiAnswer> => {
        const response = await httpClient.post<AiAnswer>('/ai/ask', { question, topK });
        return response.data;
    },
};
