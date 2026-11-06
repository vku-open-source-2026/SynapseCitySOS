// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/**
 * Tier-2 AI capability adapter.
 *
 * SOS never holds a model/provider key and never talks to SynapseOne. Every
 * inference call goes through `POST /v1/capabilities/ai/chat` on the Tier-2
 * capabilities API. When that capability is missing, unconfigured or failing,
 * the adapter raises a typed `503 ai_capability_unavailable` instead of
 * fabricating a local answer (issue #14).
 */
import { CapabilitiesError, type CapabilitiesClient } from '@synapsedx/capabilities';
import { badGateway, badRequest, serviceUnavailable } from './errors';
import { HttpError } from './errors';

export type AiRole = 'system' | 'user' | 'assistant';

export interface AiMessage {
  role: AiRole;
  content: string;
}

export interface AiChatOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  correlationId?: string;
}

export interface AiChatResult {
  content: string;
  model: string | null;
  usage: Record<string, unknown> | null;
  provider: 'synapsedx';
}

export interface AiStatus {
  capability: 'ai';
  provider: 'tier-2-ai';
  configured: boolean;
  reachable: boolean;
  status: 'ok' | 'degraded' | 'unavailable';
  model: string | null;
  dependency: string | null;
  detail: string;
  checked_at: string;
  base_url: string | null;
}

const DEFAULT_AI_TIMEOUT_MS = 45_000;
const STATUS_TTL_MS = 10_000;

interface StatusCache {
  at: number;
  value: AiStatus;
}

let statusCache: StatusCache | null = null;

/** Test hook: forget the short AI-status cache. */
export function resetAiStatusCache(): void {
  statusCache = null;
}

export function aiTimeoutMs(value: unknown = process.env.SYNAPSEDX_AI_TIMEOUT_MS): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1_000) return DEFAULT_AI_TIMEOUT_MS;
  return Math.min(Math.floor(parsed), 120_000);
}

function upstreamStatus(error: unknown): number | null {
  return error instanceof CapabilitiesError && typeof error.status === 'number' ? error.status : null;
}

/**
 * Map any Tier-2 AI failure to one typed 503. A provider failure is not the
 * caller's fault and is deliberately retryable, so the console can offer
 * "retry with AI" without guessing.
 */
export function aiUnavailable(detail: string, error?: unknown) {
  const status = upstreamStatus(error);
  const code = error instanceof CapabilitiesError ? error.code ?? null : null;
  return serviceUnavailable('ai_capability_unavailable', detail, {
    dependency: 'synapsedx',
    capability: 'ai',
    // A provider/network failure may succeed on retry; a missing credential or
    // capability will not, so it is flagged as non-retryable.
    retryable: status === null || status >= 500,
    ...(status !== null ? { upstream_status: status } : {}),
    ...(code ? { upstream_code: code } : {}),
  });
}

function collectContent(value: unknown, depth = 0): string | null {
  if (depth > 4 || value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const parts = value.map((item) => collectContent(item, depth + 1)).filter((item): item is string => Boolean(item));
    return parts.length ? parts.join('') : null;
  }
  if (typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  for (const key of ['content', 'text', 'output_text', 'message']) {
    const found = collectContent(record[key], depth + 1);
    if (found) return found;
  }
  return null;
}

/** Extract assistant text from an OpenAI-compatible or wrapped AI response. */
export function aiContentOf(response: unknown): string | null {
  if (!response || typeof response !== 'object' || Array.isArray(response)) return null;
  const body = response as Record<string, unknown>;
  const choices = Array.isArray(body.choices) ? body.choices : [];
  const first = choices[0];
  if (first && typeof first === 'object') {
    const choice = first as Record<string, unknown>;
    const message = choice.message && typeof choice.message === 'object' ? choice.message as Record<string, unknown> : null;
    const fromMessage = message ? collectContent(message.content) : null;
    if (fromMessage && fromMessage.trim()) return fromMessage;
    const fromDelta = choice.delta && typeof choice.delta === 'object' ? collectContent((choice.delta as Record<string, unknown>).content) : null;
    if (fromDelta && fromDelta.trim()) return fromDelta;
    const fromText = collectContent(choice.text);
    if (fromText && fromText.trim()) return fromText;
  }
  for (const key of ['output_text', 'content', 'output', 'data', 'result']) {
    const found = collectContent(body[key]);
    if (found && found.trim()) return found;
  }
  return null;
}

function modelOf(response: unknown): string | null {
  if (!response || typeof response !== 'object') return null;
  const body = response as Record<string, unknown>;
  const model = body.model ?? (body.metadata as Record<string, unknown> | undefined)?.model;
  return typeof model === 'string' && model.trim() ? model : null;
}

function usageOf(response: unknown): Record<string, unknown> | null {
  if (!response || typeof response !== 'object') return null;
  const usage = (response as Record<string, unknown>).usage;
  return usage && typeof usage === 'object' && !Array.isArray(usage) ? usage as Record<string, unknown> : null;
}

/** Call the Tier-2 AI chat capability. Throws a typed 503 when unavailable. */
export async function aiChat(
  client: CapabilitiesClient,
  messages: AiMessage[],
  options: AiChatOptions = {},
): Promise<AiChatResult> {
  if (!messages.length) throw badGateway('ai_prompt_empty', 'the AI prompt must contain at least one message');
  let response: unknown;
  try {
    response = await client.ai.chat(messages, {
      ...(options.model ? { model: options.model } : {}),
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(options.maxTokens !== undefined ? { max_tokens: options.maxTokens } : {}),
      timeoutMs: options.timeoutMs ?? aiTimeoutMs(),
      ...(options.correlationId ? { correlationId: options.correlationId } : {}),
    });
  } catch (error) {
    throw aiUnavailable('The Tier-2 AI capability did not return a response.', error);
  }
  const content = aiContentOf(response);
  if (!content || !content.trim()) {
    throw aiUnavailable('The Tier-2 AI capability returned an empty completion.', null);
  }
  return {
    content: content.trim(),
    model: modelOf(response),
    usage: usageOf(response),
    provider: 'synapsedx',
  };
}

/**
 * Extract the first JSON object from an LLM response. Models often wrap JSON in
 * a Markdown fence or add a sentence before it; both are accepted, but a
 * non-JSON body is an upstream contract failure (502), never a silent template.
 */
export function jsonObjectFrom(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  const candidates: string[] = [trimmed];
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) candidates.push(fenced[1].trim());
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) candidates.push(trimmed.slice(start, end + 1));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

/** Report real AI provider readiness. Never claims `ok` without a Tier-2 answer. */
export async function aiStatus(client: CapabilitiesClient, baseUrl?: string): Promise<AiStatus> {
  const cached = statusCache;
  if (cached && Date.now() - cached.at < STATUS_TTL_MS) return cached.value;
  const checkedAt = new Date().toISOString();
  let status: AiStatus;
  try {
    const raw = await client.ai.status({ timeoutMs: 5_000 });
    const body = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const upstream = body.upstream && typeof body.upstream === 'object' ? body.upstream as Record<string, unknown> : {};
    const upstreamStatus = String(body.status ?? upstream.status ?? '').toLowerCase();
    const ok = upstreamStatus === 'ok' || upstreamStatus === 'ready' || upstreamStatus === 'healthy';
    const degraded = upstreamStatus === 'degraded';
    status = {
      capability: 'ai',
      provider: 'tier-2-ai',
      configured: ok || degraded,
      reachable: true,
      status: ok ? 'ok' : degraded ? 'degraded' : 'unavailable',
      model: typeof body.model === 'string' ? body.model : typeof upstream.model === 'string' ? upstream.model : null,
      dependency: typeof body.dependency === 'string' ? body.dependency : null,
      detail: ok
        ? 'Tier-2 AI capability is ready; EOP drafts are generated by the model.'
        : degraded
          ? 'Tier-2 AI capability is degraded; drafts may fail and return a typed 503.'
          : 'Tier-2 AI capability reported that no model is configured.',
      checked_at: checkedAt,
      base_url: baseUrl ?? null,
    };
  } catch (error) {
    const httpStatus = upstreamStatus(error);
    status = {
      capability: 'ai',
      provider: 'tier-2-ai',
      configured: false,
      reachable: httpStatus === 404 || httpStatus === 501 ? true : false,
      status: 'unavailable',
      model: null,
      dependency: 'synapseone-inference',
      detail: httpStatus === 404 || httpStatus === 501
        ? 'The Tier-2 capabilities API does not expose an AI capability yet.'
        : httpStatus === 401 || httpStatus === 403
          ? 'The Tier-2 service credential is missing or lacks the AI scope.'
          : 'The Tier-2 AI capability did not respond.',
      checked_at: checkedAt,
      base_url: baseUrl ?? null,
    };
  }
  statusCache = { at: Date.now(), value: status };
  return status;
}

// ---------------------------------------------------------------------------
// Knowledge-backed LLM features (Tier-2 hazard brief + RAG answer)
// ---------------------------------------------------------------------------

export interface HazardBriefCitation {
  id: string;
  hazard_id: string;
  title: string;
  event_type: string;
  severity: string;
  provinces: string[];
  published_at: string;
  url: string;
}

export interface HazardBriefResult {
  brief: string;
  hazards: HazardBriefCitation[];
  model: string | null;
  fallback: boolean;
  generated_at: string;
  hours: number;
  provider: 'synapsedx';
}

export interface KnowledgeCitation {
  index: number;
  title: string;
  documentId: string;
  url?: string;
  publishedAt?: string;
}

export interface KnowledgeAnswerResult {
  answer: string;
  citations: KnowledgeCitation[];
  entities: string[];
  noAnswer: boolean;
  model: string | null;
  provider: 'synapsedx';
}

interface BriefCacheEntry {
  at: number;
  key: string;
  value: HazardBriefResult;
}

const BRIEF_TTL_MS = 60_000;
let briefCache: BriefCacheEntry | null = null;

/** Test hook: forget the short hazard-brief cache. */
export function resetHazardBriefCache(): void {
  briefCache = null;
}

function knowledgeSdk(client: CapabilitiesClient): {
  hazards?: { brief?: (input: { hours?: number; limit?: number; focus?: string }, opts?: Record<string, unknown>) => Promise<unknown> };
  knowledge?: { query?: (input: { question: string; topK?: number }, opts?: Record<string, unknown>) => Promise<unknown> };
} {
  return client as unknown as {
    hazards?: { brief?: (input: { hours?: number; limit?: number; focus?: string }, opts?: Record<string, unknown>) => Promise<unknown> };
    knowledge?: { query?: (input: { question: string; topK?: number }, opts?: Record<string, unknown>) => Promise<unknown> };
  };
}

function asBrief(value: unknown): HazardBriefResult | null {
  if (!value || typeof value !== 'object') return null;
  const body = value as Record<string, unknown>;
  if (typeof body.brief !== 'string' || !body.brief.trim()) return null;
  const hazards = Array.isArray(body.hazards) ? body.hazards as HazardBriefCitation[] : [];
  return {
    brief: body.brief,
    hazards,
    model: typeof body.model === 'string' ? body.model : null,
    fallback: body.fallback === true,
    generated_at: typeof body.generated_at === 'string' ? body.generated_at : new Date().toISOString(),
    hours: Number.isFinite(Number(body.hours)) ? Number(body.hours) : 24,
    provider: 'synapsedx',
  };
}

function asAnswer(value: unknown): KnowledgeAnswerResult | null {
  if (!value || typeof value !== 'object') return null;
  const body = value as Record<string, unknown>;
  if (typeof body.answer !== 'string' || !body.answer.trim()) return null;
  const citations = Array.isArray(body.citations) ? body.citations as KnowledgeCitation[] : [];
  const entities = Array.isArray(body.entities) ? body.entities.map(String) : [];
  return {
    answer: body.answer,
    citations,
    entities,
    noAnswer: body.noAnswer === true,
    model: typeof body.model === 'string' ? body.model : null,
    provider: 'synapsedx',
  };
}

/**
 * Generate a grounded situation brief from the Tier-2 hazard feed. The brief
 * itself is produced by Tier-2 (knowledge + LLM); SOS only caches it briefly.
 */
export async function hazardBrief(
  client: CapabilitiesClient,
  options: { hours?: number; limit?: number; focus?: string } = {},
  nowMs = Date.now(),
): Promise<HazardBriefResult> {
  const hours = Math.min(Math.max(Math.trunc(options.hours ?? 24), 1), 168);
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 8), 1), 40);
  const focus = String(options.focus ?? '').trim().slice(0, 500);
  const key = `${hours}:${limit}:${focus}`;
  const ttl = briefCache?.value.fallback ? 15_000 : BRIEF_TTL_MS;
  if (briefCache && briefCache.key === key && nowMs - briefCache.at < ttl) return briefCache.value;

  const sdk = knowledgeSdk(client);
  if (!sdk.hazards?.brief) throw aiUnavailable('The Tier-2 API does not expose the hazard brief capability yet.', null);
  try {
    const raw = await sdk.hazards.brief({ hours, limit, ...(focus ? { focus } : {}) }, { timeoutMs: aiTimeoutMs() });
    const result = asBrief(raw);
    if (!result) throw aiUnavailable('The Tier-2 hazard brief capability returned an empty brief.', null);
    briefCache = { at: nowMs, key, value: result };
    return result;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw aiUnavailable('The Tier-2 hazard brief capability did not return a response.', error);
  }
}

/** Grounded RAG answer using the Tier-2 knowledge base (vector + graph). */
export async function knowledgeAsk(
  client: CapabilitiesClient,
  question: string,
  topK = 5,
  context?: string,
): Promise<KnowledgeAnswerResult> {
  const text = String(question ?? '').trim();
  if (!text) throw badRequest('question_required', 'question is required');
  const live = String(context ?? '').trim().slice(0, 4000);
  const sdk = knowledgeSdk(client);
  if (!sdk.knowledge?.query) throw aiUnavailable('The Tier-2 API does not expose the knowledge query capability yet.', null);
  try {
    const raw = await sdk.knowledge.query(
      {
        question: text.slice(0, 2000),
        topK: Math.min(Math.max(Math.trunc(topK), 1), 12),
        ...(live ? { context: live } : {}),
      },
      { timeoutMs: aiTimeoutMs() },
    );
    const result = asAnswer(raw);
    if (!result) throw aiUnavailable('The Tier-2 knowledge capability returned an empty answer.', null);
    return result;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw aiUnavailable('The Tier-2 knowledge capability did not return a response.', error);
  }
}
