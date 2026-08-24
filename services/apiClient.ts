import {
  AdminSourceReview,
  AlertSubscription,
  AppStateSnapshot,
  ChatMessage,
  DeepScanResponse,
  ExpandEvidenceResponse,
  DomainWeight,
  EvidenceBrief,
  EvidenceBriefSections,
  FeedbackEvent,
  GenerateMode,
  JelPaper,
  MonitorOverview,
  MonitorCost,
  MonitorAlert,
  MonitorActivityEvent,
  PaperPlan,
  PaperPlanClarification,
  PaperPlanOutline,
  PaperPlanUpload,
  UploadPreview,
  PersonaId,
  SavedPaper,
  SearchFilters,
  SearchRun,
  RetrievalAudit,
  UserPreferences,
  WeightAlert,
  WeightProposal,
  XPost,
  SignalItem,
  Work} from '../types';
import { supabase } from './supabaseClient';

const API_BASE = (import.meta.env.VITE_API_BASE_URL || '/api').replace(/\/$/, '');

async function getAuthHeader(): Promise<Record<string, string>> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) {
    return {};
  }
  return { Authorization: `Bearer ${session.access_token}` };
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const authHeaders = await getAuthHeader();

  const response = await fetch(`${API_BASE}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders,
      ...(init?.headers || {}),
    },
    ...init,
  });

  if (!response.ok) {
    const raw = await response.text();
    // Prefer the JSON `error` field when the backend returns one; fall back
    // to the raw text. Strip HTML (e.g. nginx 502 pages) so the user sees a
    // human-readable message instead of '<html><head>...502 Bad Gateway</title>'.
    let message = raw;
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && typeof parsed.error === 'string') {
        message = parsed.error;
        // Log structured detail/code to console for diagnosis without
        // bloating the user-facing toast.
        if (typeof parsed.detail === 'string' && parsed.detail.length > 0) {
          console.error('[apiClient] backend error detail:', parsed.detail, 'code:', parsed.code);
        }
      }
    } catch {
      // Not JSON — likely an HTML proxy error page. Strip tags + collapse.
      if (raw.includes('<html') || raw.includes('<HTML')) {
        if (response.status === 502 || response.status === 504) {
          message = 'Search service is temporarily unavailable. Try again in a moment.';
        } else {
          message = `Request failed (${response.status}). Try again or rephrase your query.`;
        }
      }
    }
    throw new Error(message || `Request failed with ${response.status}`);
  }

  return response.json() as Promise<T>;
}

export const apiClient = {
  getSnapshot(): Promise<AppStateSnapshot> {
    return request<AppStateSnapshot>('/snapshot');
  },
  getMonitorOverview(): Promise<MonitorOverview> {
    return request<MonitorOverview>('/admin/monitor/overview');
  },
  getMonitorCost(): Promise<MonitorCost> {
    return request<MonitorCost>('/admin/monitor/cost');
  },
  getMonitorAlerts(): Promise<{ alerts: MonitorAlert[] }> {
    return request<{ alerts: MonitorAlert[] }>('/admin/monitor/alerts');
  },
  getMonitorActivity(limit = 100): Promise<{ events: MonitorActivityEvent[] }> {
    return request<{ events: MonitorActivityEvent[] }>(`/admin/monitor/activity?limit=${limit}`);
  },
  getMonitorRunQuality(runId: string): Promise<{ duplicates: any[]; relevance: any } | { error: string }> {
    return request(`/admin/monitor/quality/run/${encodeURIComponent(runId)}`);
  },
  getMonitorPaperQuality(paperId: string): Promise<{ proseIssues: any[] } | { error: string }> {
    return request(`/admin/monitor/quality/paper/${encodeURIComponent(paperId)}`);
  },
  judgePaper(paperId: string): Promise<{ paperId: string; model: string; overall: string; findings: any[] } | { error: string }> {
    return request(`/admin/monitor/judge/${encodeURIComponent(paperId)}`, { method: 'POST', body: JSON.stringify({}) });
  },
  getPaperReview(paperId: string): Promise<any> {
    return request(`/admin/monitor/judge/${encodeURIComponent(paperId)}`);
  },
  // Durable plugin keys for the Claude Code plugin (mint once, shown raw once).
  createPluginKey(label?: string): Promise<{ id: string; key: string; prefix: string; label: string | null; createdAt: string }> {
    return request('/plugin-keys', { method: 'POST', body: JSON.stringify({ label: label ?? null }) });
  },
  listPluginKeys(): Promise<{ keys: Array<{ id: string; prefix: string; label: string | null; created_at: string; last_used_at: string | null }> }> {
    return request('/plugin-keys');
  },
  revokePluginKey(id: string): Promise<{ ok: boolean }> {
    return request(`/plugin-keys/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },
  createSearchRun(
    query: string,
    filters: SearchFilters,
    rerankWeights?: Record<string, number> | null,
    channels?: string[] | null,
  ): Promise<SearchRun> {
    return request<SearchRun>('/search-runs', {
      method: 'POST',
      body: JSON.stringify({
        query,
        filters,
        ...(rerankWeights ? { rerankWeights } : {}),
        ...(channels?.length ? { channels } : {}),
      }),
    });
  },
  getSearchRun(id: string): Promise<SearchRun> {
    return request<SearchRun>(`/search-runs/${id}`);
  },
  /**
   * Hard delete a search run and all its children
   * (briefs, chat messages, feedback, feed items).
   */
  deleteSearchRun(id: string): Promise<{ ok: boolean; deletedBriefCount: number }> {
    return request(`/search-runs/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },
  /**
   * Deep scan — opt-in second retrieval round. An LLM names the literatures
   * the first pass missed and runs 2-4 follow-up sub-queries through the
   * read-only corpus search. 409 if a deep scan already ran for this run.
   */
  deepScanSearchRun(runId: string): Promise<DeepScanResponse> {
    return request<DeepScanResponse>(`/search-runs/${encodeURIComponent(runId)}/deep-scan`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
  },
  loadMoreEvidence(runId: string): Promise<{ works: Work[]; total: number }> {
    return request<{ works: Work[]; total: number }>(`/search-runs/${encodeURIComponent(runId)}/more-evidence`);
  },
  createBrief(
    searchRunId: string,
    persona?: PersonaId,
    lang?: 'en' | 'es' | 'pt',
    evidenceWorkIdsOverride?: string[],
    extraPapers?: PaperPlanUpload[],
  ): Promise<EvidenceBrief> {
    return request<EvidenceBrief>('/briefs', {
      method: 'POST',
      body: JSON.stringify({ searchRunId, persona, lang, evidenceWorkIdsOverride, extraPapers }),
    });
  },
  resolvePaper(input: { doiOrUrl?: string; pastedText?: string }): Promise<PaperPlanUpload> {
    return request<PaperPlanUpload>('/resolve-paper', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },
  // POLICY-ONLY (2026-06-03): renderBrief() and POST /api/briefs/render were
  // removed — they only powered the persona-swap UI (now gone, briefs are always
  // the policy register). The language toggle re-renders client-side.
  getBrief(id: string): Promise<EvidenceBrief> {
    return request<EvidenceBrief>(`/briefs/${id}`);
  },
  createSubscription(payload: Omit<AlertSubscription, 'id' | 'tenantId'>): Promise<AlertSubscription> {
    return request<AlertSubscription>('/alerts/subscriptions', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },
  getFollowDigest(opts?: {
    windowDays?: number;
    limit?: number;
    methodology?: string[];
    regions?: string[];
    tiers?: string[];
    sources?: string[];
  }): Promise<{
    windowDays: number;
    generatedAt: string;
    subscriptions: Array<{
      subscription: AlertSubscription;
      updates: import('../types').Work[];
      signals: Array<{
        id: string;
        title: string;
        url: string | null;
        snippet: string | null;
        publishedDate: string | null;
        domain: string | null;
        author: string | null;
        sourceType: 'news' | 'blog' | 'x' | 'other';
      }>;
      totalThisWeek: number;
    }>;
  }> {
    const p = new URLSearchParams();
    if (opts?.windowDays) p.set('windowDays', String(opts.windowDays));
    if (opts?.limit) p.set('limit', String(opts.limit));
    if (opts?.methodology?.length) p.set('methodology', opts.methodology.join(','));
    if (opts?.regions?.length) p.set('regions', opts.regions.join(','));
    if (opts?.tiers?.length) p.set('tiers', opts.tiers.join(','));
    if (opts?.sources?.length) p.set('sources', opts.sources.join(','));
    const qs = p.toString();
    return request(`/follow/digest${qs ? `?${qs}` : ''}`);
  },
  submitFeedback(payload: Omit<FeedbackEvent, 'id' | 'tenantId' | 'createdAt'>): Promise<FeedbackEvent> {
    return request<FeedbackEvent>('/feedback', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },
  reviewSource(payload: AdminSourceReview): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>('/admin/source-review', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  excludeWork(workId: string, excluded: boolean): Promise<{ ok: boolean; excluded: boolean }> {
    return request<{ ok: boolean; excluded: boolean }>(`/admin/works/${encodeURIComponent(workId)}/exclude`, {
      method: 'POST',
      body: JSON.stringify({ excluded }),
    });
  },

  starWork(workId: string, starred: boolean): Promise<{ ok: boolean; starred: boolean }> {
    return request<{ ok: boolean; starred: boolean }>(`/admin/works/${encodeURIComponent(workId)}/star`, {
      method: 'POST',
      body: JSON.stringify({ starred }),
    });
  },

  // Learning agent admin methods
  runLearningAgent(): Promise<{ usersProcessed: number; proposalsCreated: number; alertFired: boolean; processedSignals: number }> {
    return request('/admin/learning-agent/run', { method: 'POST' });
  },

  getWeights(): Promise<DomainWeight[]> {
    return request<DomainWeight[]>('/admin/weights');
  },

  getProposals(): Promise<WeightProposal[]> {
    return request<WeightProposal[]>('/admin/proposals');
  },

  reviewProposal(proposalId: string, status: 'approved' | 'rejected'): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>(`/admin/proposals/${proposalId}/review`, {
      method: 'POST',
      body: JSON.stringify({ status }),
    });
  },

  getAlerts(): Promise<WeightAlert[]> {
    return request<WeightAlert[]>('/admin/alerts');
  },

  getRetrievalAudits(): Promise<RetrievalAudit[]> {
    return request<RetrievalAudit[]>('/admin/retrieval-audits');
  },

  runRetrievalAudit(searchRunId: string, mode: 'corpus' | 'external' = 'corpus'): Promise<RetrievalAudit> {
    return request<RetrievalAudit>('/admin/retrieval-audits/run', {
      method: 'POST',
      body: JSON.stringify({ searchRunId, mode }),
    });
  },

  submitRetrievalAuditFeedback(
    auditId: string,
    item: { title: string; doi?: string | null; year?: number | null; source?: string | null; authors?: string[]; whyExpected?: string; status?: string },
    verdict: 'not_relevant' | 'relevant' = 'not_relevant',
    note?: string,
  ): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>(`/admin/retrieval-audits/${encodeURIComponent(auditId)}/feedback`, {
      method: 'POST',
      body: JSON.stringify({
        itemTitle: item.title,
        itemDoi: item.doi,
        itemYear: item.year,
        itemSource: item.source,
        itemAuthors: item.authors,
        itemWhyExpected: item.whyExpected,
        itemStatus: item.status,
        verdict,
        note,
      }),
    });
  },

  getPreferences(): Promise<UserPreferences> {
    return request<UserPreferences>('/preferences');
  },

  savePreferences(prefs: UserPreferences): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>('/preferences', {
      method: 'POST',
      body: JSON.stringify(prefs),
    });
  },

  getSavedPapers(): Promise<SavedPaper[]> {
    return request<SavedPaper[]>('/saved-papers');
  },

  deleteSavedPaper(feedbackId: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>(`/saved-papers/${encodeURIComponent(feedbackId)}`, {
      method: 'DELETE',
    });
  },

  getMyWeights(): Promise<DomainWeight[]> {
    return request<DomainWeight[]>('/my-weights');
  },

  deleteSubscription(id: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>(`/alerts/subscriptions/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  },

  createJelPaper(searchRunId: string, briefId?: string | null): Promise<JelPaper> {
    return request<JelPaper>('/jel-papers', {
      method: 'POST',
      body: JSON.stringify({ searchRunId, briefId: briefId ?? null }),
    });
  },

  getJelPaper(paperId: string): Promise<JelPaper> {
    return request<JelPaper>(`/jel-papers/${encodeURIComponent(paperId)}`);
  },

  renameJelPaper(paperId: string, newTitle: string): Promise<JelPaper> {
    return request<JelPaper>(`/jel-papers/${encodeURIComponent(paperId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ query: newTitle }),
    });
  },

  deleteJelPaper(paperId: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>(`/jel-papers/${encodeURIComponent(paperId)}`, {
      method: 'DELETE',
    });
  },

  // Talk-to-the-draft: re-draft targeted section(s) over the SAME evidence set.
  // Capped at 2 per paper server-side. Returns the paper flipped to 'running'.
  reviseJelPaper(paperId: string, instruction: string): Promise<JelPaper> {
    return request<JelPaper>(`/jel-papers/${encodeURIComponent(paperId)}/revise`, {
      method: 'POST',
      body: JSON.stringify({ instruction }),
    });
  },

  // ---- Paper Studio (paper plans) ----
  createPaperPlan(searchRunId: string, briefId?: string | null, orderedWorkIds?: string[]): Promise<JelPaper> {
    return request<JelPaper>('/paper-plans', {
      method: 'POST',
      body: JSON.stringify({
        searchRunId,
        briefId: briefId ?? null,
        ...(orderedWorkIds ? { curatedWorkIdsOverride: orderedWorkIds } : {}),
      }),
    });
  },

  getPaperPlan(planId: string): Promise<JelPaper> {
    return request<JelPaper>(`/paper-plans/${encodeURIComponent(planId)}`);
  },

  expandEvidence(planId: string, planner: 'gemini' | 'qwen', cap = 15): Promise<ExpandEvidenceResponse> {
    return request<ExpandEvidenceResponse>(`/paper-plans/${encodeURIComponent(planId)}/expand-evidence`, {
      method: 'POST',
      body: JSON.stringify({ planner, cap }),
    });
  },

  // Shallow-merges the partial into the stored plan jsonb and returns the row.
  patchPaperPlan(planId: string, planPartial: Partial<PaperPlan>): Promise<JelPaper> {
    return request<JelPaper>(`/paper-plans/${encodeURIComponent(planId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ plan: planPartial }),
    });
  },

  clarifyPlan(planId: string): Promise<PaperPlanClarification> {
    return request<PaperPlanClarification>(`/paper-plans/${encodeURIComponent(planId)}/clarify`, {
      method: 'POST',
    });
  },

  refreshOutlinePreview(planId: string): Promise<{ outlinePreview: PaperPlanOutline | null; degraded: boolean }> {
    return request(`/paper-plans/${encodeURIComponent(planId)}/outline-preview`, {
      method: 'POST',
    });
  },

  // Upload a paper to a plan. Without confirm → preview only (nothing persisted).
  // With confirm:true (+ uploadId from the preview) → attaches + writes a signal.
  // Pass `upload` on confirm to persist user-edited metadata verbatim (server
  // preserves matchedWorkId/card/smsLevel from the original resolve pass).
  uploadToPlan(
    planId: string,
    body: { doiOrUrl?: string; pastedText?: string; uploadId?: string; confirm?: boolean; upload?: PaperPlanUpload },
  ): Promise<UploadPreview & { attached?: boolean }> {
    return request(`/paper-plans/${encodeURIComponent(planId)}/uploads`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },

  // This tenant's previously-uploaded papers (≤50) for reuse across papers.
  listPaperUploads(): Promise<{ uploads: (PaperPlanUpload & { kind?: string; uploadedAt?: string })[] }> {
    return request('/paper-uploads');
  },

  // Kick off generation FROM a curated plan (reuses the planning row).
  generateFromPlan(planId: string, opts?: { generateMode?: GenerateMode; autoExpand?: boolean }): Promise<JelPaper> {
    return request<JelPaper>('/jel-papers', {
      method: 'POST',
      body: JSON.stringify({ planId, ...(opts?.generateMode ? { generateMode: opts.generateMode } : {}), ...(opts?.autoExpand ? { autoExpand: true } : {}) }),
    });
  },

  getChatMessages(briefId: string): Promise<ChatMessage[]> {
    return request<ChatMessage[]>(`/briefs/${encodeURIComponent(briefId)}/messages`);
  },

  deleteChatMessage(briefId: string, messageId: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>(`/briefs/${encodeURIComponent(briefId)}/messages/${encodeURIComponent(messageId)}`, {
      method: 'DELETE',
    });
  },

  async streamChatMessage(
    briefId: string,
    question: string,
    history: Array<{ role: 'user' | 'model'; content: string }>,
    callbacks: {
      onChunk: (text: string) => void;
      onCitations: (workIds: string[]) => void;
      onSuggestions?: (suggestions: string[]) => void;
      // Fired when the verifier replaces the streamed Gemini draft with a
      // table-grounded correction. Frontend should swap the assistant
      // message text with `text` when this fires. No-op if not provided.
      onCorrection?: (text: string) => void;
      onDone: (messageId: string | null) => void;
      onError: (error: string) => void;
    }
  ): Promise<void> {
    const authHeaders = await getAuthHeader();
    const response = await fetch(
      `${API_BASE}/briefs/${encodeURIComponent(briefId)}/chat`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({ question, history }),
      }
    );

    if (!response.ok) {
      const text = await response.text();
      callbacks.onError(text || `Chat failed with ${response.status}`);
      return;
    }

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    // A stream can close cleanly WITHOUT a terminal event (proxy idle-timeout,
    // backend restart mid-generation). Without this flag the promise resolved
    // normally and the caller's loading state stayed true forever.
    let terminal = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n\n');
      buffer = parts.pop() || '';

      for (const part of parts) {
        const eventMatch = part.match(/^event:\s*(.+)$/m);
        const dataMatch = part.match(/^data:\s*(.+)$/m);
        if (!eventMatch || !dataMatch) continue;

        const eventType = eventMatch[1].trim();
        try {
          const data = JSON.parse(dataMatch[1]);
          switch (eventType) {
            case 'chunk': callbacks.onChunk(data.text); break;
            case 'correction':
              if (callbacks.onCorrection && typeof data.text === 'string') {
                callbacks.onCorrection(data.text);
              }
              break;
            case 'citations': callbacks.onCitations(data.workIds || []); break;
            case 'suggestions':
              if (callbacks.onSuggestions && Array.isArray(data.suggestions)) {
                callbacks.onSuggestions(data.suggestions);
              }
              break;
            case 'done': terminal = true; callbacks.onDone(data.messageId || null); break;
            case 'error': terminal = true; callbacks.onError(data.error || 'Chat error'); break;
          }
        } catch {
          // Malformed SSE data — skip
        }
      }
    }
    if (!terminal) {
      callbacks.onError('The connection dropped before the answer finished. Please try again.');
    }
  },

  /**
   * Stream brief generation via SSE (Phase 4 — SYNTH-03).
   * Uses GET /api/briefs/stream instead of POST /api/briefs.
   * Cannot use the request() helper because it awaits response.json().
   */
  // --- BYOK synthesis (admin) ---
  // Any authenticated user: which model their next generation uses + provenance.
  getSynthesisAccess(): Promise<{ status: 'granted' | 'default'; provider?: 'gemini' | 'claude'; model?: string; grantedByEmail?: string | null; ownKey?: boolean; defaultModel?: string; requestFromEmail?: string | null }> {
    return request('/synthesis-access');
  },
  getSynthesisKeys(): Promise<{ keys: Array<{ id: string; provider: string; model: string | null; label: string | null; active: boolean; last_used_at?: string | null; created_at?: string | null; owner_self_use?: boolean; owner_self_model?: string | null }> }> {
    return request('/synthesis-keys');
  },
  updateSynthesisKeySelf(id: string, input: { ownerSelfUse?: boolean; ownerSelfModel?: string | null }): Promise<{ ok: boolean }> {
    return request(`/synthesis-keys/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(input) });
  },
  setSynthesisKey(input: { provider: 'gemini' | 'claude'; apiKey: string; model?: string; label?: string | null }): Promise<{ id: string; provider: string; model: string | null }> {
    return request('/synthesis-keys', { method: 'POST', body: JSON.stringify(input) });
  },
  revokeSynthesisKey(id: string): Promise<{ ok: boolean }> {
    return request(`/synthesis-keys/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },
  searchSynthesisUsers(q: string): Promise<{ users: Array<{ id: string; email: string }> }> {
    return request(`/synthesis-users?q=${encodeURIComponent(q)}`);
  },
  getSynthesisGrants(keyId?: string): Promise<{ grants: Array<{ id: string; email: string; status: string; createdAt: string }> }> {
    return request(`/synthesis-grants${keyId ? `?keyId=${encodeURIComponent(keyId)}` : ''}`);
  },
  grantSynthesisAccess(keyId: string, granteeEmail: string): Promise<{ id: string; email: string }> {
    return request('/synthesis-grants', { method: 'POST', body: JSON.stringify({ keyId, granteeEmail }) });
  },
  revokeSynthesisGrant(id: string): Promise<{ ok: boolean }> {
    return request(`/synthesis-grants/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },
  getSynthesisUsage(window: '30d' | 'all' = '30d'): Promise<{
    window: string; since: string | null;
    overall: { calls: number; tokensIn: number; tokensOut: number; estCostUsd: number };
    byPerson: Array<{ email: string; calls: number; tokensIn: number; tokensOut: number; estCostUsd: number;
      daily: Array<{ date: string; tokensIn: number; tokensOut: number; calls: number }> }>;
  }> {
    return request(`/synthesis-usage?window=${window}`);
  },

  fetchSignals(
    query: string,
    profiles: ('policy' | 'buzz')[],
  ): Promise<{ policy: SignalItem[]; buzz: SignalItem[] }> {
    if (profiles.length === 0) {
      return Promise.resolve({ policy: [], buzz: [] });
    }
    const params = new URLSearchParams({
      query,
      profiles: profiles.join(','),
    });
    return request<{ policy: SignalItem[]; buzz: SignalItem[] }>(
      `/signals?${params.toString()}`,
      { method: 'GET' },
    );
  },


  async streamBrief(
    searchRunId: string,
    callbacks: {
      onPhase1: (brief: EvidenceBrief) => void;
      onChunk: (text: string) => void;
      onDone: (brief: EvidenceBrief) => void;
      // Fired after post-done verification corrects brief prose. Frontend
      // should patch the current brief's sections with these values.
      // Optional; no-op if not provided.
      onVerified?: (corrections: { sections?: EvidenceBriefSections; methodologyNote?: string; gapSummary?: string }) => void;
      onError: (error: string) => void;
    },
    persona?: PersonaId,
    lang?: 'en' | 'es' | 'pt',
    opts?: { excludedWorkIds?: string[]; visibleWorkIds?: string[]; extraPapers?: PaperPlanUpload[]; signal?: AbortSignal }
  ): Promise<void> {
    const authHeaders = await getAuthHeader();
    const personaParam = persona ? `&persona=${encodeURIComponent(persona)}` : '';
    const langParam = lang ? `&lang=${lang}` : '';
    const excluded = opts?.excludedWorkIds ?? [];
    const excludedParam = excluded.length > 0
      ? `&excludedWorkIds=${encodeURIComponent(excluded.join(','))}`
      : '';
    // visibleWorkIds: papers currently visible in the table. Backend filters
    // evidence to this set so boxes + brief reflect only what user sees.
    const visible = opts?.visibleWorkIds ?? [];
    const visibleParam = visible.length > 0
      ? `&visibleWorkIds=${encodeURIComponent(visible.join(','))}`
      : '';
    let extraPapersParam = '';
    if (opts?.extraPapers && opts.extraPapers.length > 0) {
      // UTF-8-safe base64: bare btoa() throws InvalidCharacterError on any
      // char > U+00FF (é, ñ, em-dash — routine in LAC paper metadata), which
      // failed the whole regenerate before the request was even sent. Encode
      // to UTF-8 bytes first; the server decodes the byte-string back as UTF-8.
      const utf8 = new TextEncoder().encode(JSON.stringify(opts.extraPapers));
      let bin = '';
      for (let i = 0; i < utf8.length; i++) bin += String.fromCharCode(utf8[i]);
      extraPapersParam = `&extraPapersJson=${encodeURIComponent(btoa(bin))}`;
    }
    const response = await fetch(
      `${API_BASE}/briefs/stream?searchRunId=${encodeURIComponent(searchRunId)}${personaParam}${langParam}${excludedParam}${visibleParam}${extraPapersParam}`,
      { headers: { ...authHeaders }, signal: opts?.signal }
    );

    if (!response.ok) {
      if (opts?.signal?.aborted) return; // intentional cancel — don't surface as error
      const text = await response.text();
      callbacks.onError(text || `Stream failed with ${response.status}`);
      return;
    }

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    // A stream can close cleanly WITHOUT a terminal event (Vercel proxy
    // idle-timeout on a slow synthesis, deploy webhook restarting the backend
    // mid-stream). Without this flag the promise resolved normally, App never
    // left 'synthesizing', and the whole search tab was wedged until reload.
    let terminal = false;

    while (true) {
      let readResult;
      try {
        readResult = await reader.read();
      } catch (e) {
        if (opts?.signal?.aborted) return; // intentional cancel
        throw e;
      }
      const { done, value } = readResult;
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n\n');
      buffer = parts.pop() || '';

      for (const part of parts) {
        const eventMatch = part.match(/^event:\s*(.+)$/m);
        const dataMatch = part.match(/^data:\s*(.+)$/m);
        if (!eventMatch || !dataMatch) continue;

        const eventType = eventMatch[1].trim();
        try {
          const data = JSON.parse(dataMatch[1]);
          switch (eventType) {
            case 'phase1': callbacks.onPhase1(data); break;
            case 'chunk': callbacks.onChunk(data.text); break;
            case 'done': terminal = true; callbacks.onDone(data); break;
            case 'verified':
              if (callbacks.onVerified) callbacks.onVerified(data || {});
              break;
            case 'error': terminal = true; callbacks.onError(data.error || 'Stream error'); break;
          }
        } catch {
          // Malformed SSE data — skip
        }
      }
    }
    if (!terminal && !opts?.signal?.aborted) {
      callbacks.onError('The connection dropped before the brief finished generating. Please try again.');
    }
  },
};
