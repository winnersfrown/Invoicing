// Shared contracts for API, agent, frontend and tests. Change here first; never redefine elsewhere.
import { z } from 'zod';

export const SCHEMA_VERSION = 1;
export const PROMPT_VERSION = 'investigate-v1';

// ---------- enums ----------
export const Role = z.enum(['admin', 'reviewer', 'viewer']);
export const InvoiceStatus = z.enum([
  'uploaded', // file stored, nothing validated yet
  'needs_extraction_review', // required fields missing or uncertain
  'validated', // deterministic checks passed, no open discrepancies
  'exception', // one or more open discrepancies
  'resolved', // every discrepancy resolved or dismissed by a human
  'rejected', // reviewer rejected (for example confirmed duplicate)
  'superseded', // replaced by a corrected invoice; kept as evidence
]);
export const DiscrepancyType = z.enum([
  'duplicate_candidate',
  'incorrect_total',
  'line_arithmetic',
  'tax_mismatch',
  'unit_price_mismatch',
  'quantity_mismatch',
  'unmatched_line',
  'supplier_mismatch',
  'missing_purchase_order',
  'currency_mismatch',
  'ambiguous_reference',
  'potential_extraction_error',
]);
export const Severity = z.enum(['low', 'medium', 'high']);
export const DiscrepancyStatus = z.enum(['open', 'investigating', 'awaiting_supplier', 'resolved', 'dismissed']);
export const InvestigationStatus = z.enum(['queued', 'in_progress', 'completed', 'insufficient_evidence', 'failed']);
export const RecommendedAction = z.enum([
  'approve_review_completion',
  'request_corrected_invoice',
  'request_supplier_clarification',
  'investigate_duplicate',
  'verify_po_amendment',
  'correct_extraction_error',
  'escalate_to_reviewer',
  'insufficient_evidence',
]);
export const Confidence = z.enum(['low', 'medium', 'high']);
export const ApprovalStatus = z.enum(['approved', 'rejected', 'more_info_requested']);
export const ActorType = z.enum(['user', 'agent', 'system']);
export const JobStatus = z.enum(['queued', 'running', 'succeeded', 'failed']);

// ---------- money ----------
// Integer cents in code, decimal strings ("60.00") on the wire, numeric(14,2) in Postgres.
export const Cents = z.number().int().safe();
export const MoneyString = z.string().regex(/^-?\d{1,12}\.\d{2}$/);
export const centsToMoney = (c: number): string =>
  `${c < 0 ? '-' : ''}${Math.floor(Math.abs(c) / 100)}.${String(Math.abs(c) % 100).padStart(2, '0')}`;
export const moneyToCents = (s: string): number => {
  const m = MoneyString.parse(s).match(/^(-?)(\d+)\.(\d{2})$/)!;
  return (m[1] ? -1 : 1) * (Number(m[2]) * 100 + Number(m[3]));
};

const Id = z.string().uuid();
const Text = (max: number) => z.string().trim().min(1).max(max);
const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

// ---------- uploads ----------
// ponytail: 3 MB because the file travels as base64 in a JSON body and Vercel Functions cap bodies at 4.5 MB.
// Upgrade path: signed upload URLs straight to storage, then raise this.
export const UPLOAD_MAX_BYTES = 3 * 1024 * 1024;
export const UPLOAD_MIME_TYPES = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'application/json', 'text/plain'] as const;

// A field the extractor could not read is `null` with its name in `missing`; never a guess.
export const ExtractedLine = z.object({
  sku: z.string().trim().max(150).nullable(),
  description: z.string().trim().max(500),
  quantity: z.number().positive().max(100000),
  unit_price: MoneyString,
  line_total: MoneyString.nullable(),
  tax_amount: MoneyString.nullable(),
});
export const ExtractedInvoice = z.object({
  supplier_name: Text(150).nullable(),
  invoice_number: Text(150).nullable(),
  invoice_date: IsoDate.nullable(),
  due_date: IsoDate.nullable(),
  po_reference: Text(150).nullable(),
  currency: z.string().length(3).nullable(),
  subtotal: MoneyString.nullable(),
  tax_amount: MoneyString.nullable(),
  total_amount: MoneyString.nullable(),
  lines: z.array(ExtractedLine).max(100),
  source_text: z.string().max(200_000).nullable(),
  extraction: z.object({
    method: z.enum(['json', 'labeled_text', 'pdf_text', 'ocr', 'manual']),
    support_labels: z.record(z.string(),z.unknown()).optional(),
    confidence_meaning: z.string().optional(),
    confidence: z.number().min(0).max(1).nullable(),
    field_confidence: z.record(z.string(), z.number().min(0).max(1)).default({}),
    missing: z.array(z.string()).default([]),
    uncertain: z.array(z.string()).default([]),
    source_refs: z.record(z.string(), z.object({ page: z.number().int().positive().optional(), excerpt: z.string().max(500).optional() })).default({}),
  }),
});
export type ExtractedInvoice = z.infer<typeof ExtractedInvoice>;

export const CreateInvoiceRequest = z.object({
  file: z.object({
    name: Text(255),
    mime_type: z.enum(UPLOAD_MIME_TYPES),
    size_bytes: z.number().int().positive().max(UPLOAD_MAX_BYTES),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    content_base64: z.string().min(1),
  }),
  extracted: ExtractedInvoice,
  supersedes_invoice_id: Id.optional(), // corrected invoice replacing an earlier one
});

export const CreatePurchaseOrderRequest = z.object({
  supplier_name: Text(150),
  purchase_order_number: Text(150),
  currency: z.string().length(3),
  tax_amount: MoneyString,
  total_amount: MoneyString,
  lines: z.array(ExtractedLine).min(1).max(100),
});

// ---------- API DTOs (all money as MoneyString) ----------
export const LineItemDto = z.object({
  id: Id, line_number: z.number().int(), sku: z.string().nullable(), description: z.string(),
  quantity: z.number(), unit_price: MoneyString, line_total: MoneyString, tax_amount: MoneyString.nullable(),
});
export const InvoiceDto = z.object({
  id: Id, supplier_id: Id.nullable(), supplier_name: z.string().nullable(), invoice_number: z.string().nullable(),
  invoice_date: IsoDate.nullable(), due_date: IsoDate.nullable(), po_reference: z.string().nullable(),
  purchase_order_id: Id.nullable(), currency: z.string().nullable(),
  subtotal: MoneyString.nullable(), tax_amount: MoneyString.nullable(), total_amount: MoneyString.nullable(),
  status: InvoiceStatus, extraction_confidence: z.number().nullable(), extraction: ExtractedInvoice.shape.extraction,
  supersedes_invoice_id: Id.nullable(), created_at: z.string(), updated_at: z.string(),
  // list view extras
  open_discrepancy_count: z.number().int(), investigation_status: InvestigationStatus.nullable(),
  lines: z.array(LineItemDto).optional(), document_url: z.string().url().optional(), // signed, short-lived
});
export const DiscrepancyDto = z.object({
  id: Id, invoice_id: Id, purchase_order_id: Id.nullable(), discrepancy_type: DiscrepancyType, severity: Severity,
  expected_value: z.string().nullable(), observed_value: z.string().nullable(), difference_amount: MoneyString.nullable(),
  status: DiscrepancyStatus, deterministic_evidence: z.unknown(), created_at: z.string(),
});

// ---------- evidence ----------
// Every tool result carries evidence items. Findings may cite only ids returned in the same run.
// Id forms: invoice:<uuid> invoice_line:<uuid> po:<uuid> po_line:<uuid> discrepancy:<uuid>
//           duplicate:<uuid>:<uuid> supplier:<uuid> resolution:<uuid> document:<uuid>#<field>
export const EvidenceItem = z.object({
  id: z.string().regex(/^(invoice|invoice_line|po|po_line|discrepancy|duplicate|supplier|resolution|document):[A-Za-z0-9:#_-]+$/),
  label: z.string().max(200),
  value: z.string().max(2000),
  page: z.number().int().positive().optional(), // only when the extractor recorded one
});
export type EvidenceItem = z.infer<typeof EvidenceItem>;
export const ToolResult = z.object({ data: z.unknown(), evidence: z.array(EvidenceItem) });
export type ToolResult = z.infer<typeof ToolResult>;

// ---------- agent tools ----------
export const ToolInputs = {
  get_invoice: z.object({ invoice_id: Id }).strict(),
  get_purchase_order: z.object({ purchase_order_id: Id }).strict(),
  get_supplier: z.object({ supplier_id: Id }).strict(),
  get_discrepancies: z.object({ invoice_id: Id }).strict(),
  find_duplicate_candidates: z.object({ invoice_id: Id }).strict(),
  compare_invoice_to_po: z.object({ invoice_id: Id, purchase_order_id: Id }).strict(),
  get_document_evidence: z.object({ document_id: Id, requested_fields: z.array(z.string().max(60)).min(1).max(20) }).strict(),
  get_resolution_history: z.object({ discrepancy_id: Id.optional(), supplier_id: Id.optional() }).strict()
    .refine((v) => !!v.discrepancy_id !== !!v.supplier_id, 'Provide exactly one of discrepancy_id or supplier_id'),
  draft_supplier_message: z.object({
    discrepancy_id: Id, verified_evidence: z.array(z.string()).min(1).max(20), requested_correction: Text(1000),
  }).strict(),
} as const;
export type ToolName = keyof typeof ToolInputs;
export const TOOL_NAMES = Object.keys(ToolInputs) as ToolName[];

// ---------- investigation output ----------
// What the model returns. No amounts: the server adds verified_financial_impact.
export const AgentOutput = z.object({
  status: z.enum(['completed', 'insufficient_evidence']),
  summary: Text(1200),
  findings: z.array(z.object({ claim: Text(600), evidence_ids: z.array(z.string()).min(1).max(10) })).max(12),
  hypotheses: z.array(Text(300)).max(6), // possible causes; explicitly not confirmed facts
  missing_information: z.array(Text(300)).max(6),
  recommended_action: RecommendedAction,
  confidence: Confidence,
}).strict();
export type AgentOutput = z.infer<typeof AgentOutput>;

// What is stored in ai_investigations.findings and shown to reviewers.
export const InvestigationResult = z.object({
  schema_version: z.literal(SCHEMA_VERSION),
  investigation_id: Id,
  invoice_id: Id,
  discrepancy_id: Id,
  discrepancy_type: DiscrepancyType,
  status: z.enum(['completed', 'insufficient_evidence']),
  summary: z.string(),
  findings: AgentOutput.shape.findings,
  possible_causes: z.array(z.string()),
  missing_information: z.array(z.string()),
  evidence: z.array(EvidenceItem), // the cited items, resolved server-side
  verified_financial_impact: z.object({
    currency: z.string().length(3), amount: MoneyString, source: z.literal('deterministic_engine'),
  }).nullable(), // null when the engine produced no amount (for example a duplicate candidate)
  recommended_action: RecommendedAction,
  confidence: Confidence,
  requires_human_approval: z.literal(true),
});
export type InvestigationResult = z.infer<typeof InvestigationResult>;

export const InvestigationDto = z.object({
  id: Id, discrepancy_id: Id, investigation_status: InvestigationStatus, model_identifier: z.string(),
  prompt_version: z.string(), result: InvestigationResult.nullable(), error: z.string().nullable(),
  usage: z.object({
    input_tokens: z.number().int(), output_tokens: z.number().int(), tool_calls: z.number().int(),
    estimated_cost_usd: z.number(), latency_ms: z.number().int(),
  }).nullable(),
  retry_available: z.boolean(), created_at: z.string(), completed_at: z.string().nullable(),
});

// ---------- resolution ----------
export const ResolveRequest = z.object({
  decision: ApprovalStatus,
  investigation_id: Id.optional(),
  approved_action: RecommendedAction.optional(), // required when decision is 'approved'
  notes: z.string().trim().max(2000).default(''),
}).refine((v) => v.decision !== 'approved' || !!v.approved_action, 'approved_action is required when approving');
export const DraftMessageRequest = z.object({ requested_correction: Text(1000).optional() });
export const ResolutionActionDto = z.object({
  id: Id, discrepancy_id: Id, investigation_id: Id.nullable(), proposed_action: RecommendedAction.nullable(),
  approved_action: RecommendedAction.nullable(), reviewer_id: Id, approval_status: ApprovalStatus,
  reviewer_notes: z.string(), created_at: z.string(),
});
export const AuditEventDto = z.object({
  id: z.string(), actor_type: ActorType, actor_id: z.string().nullable(), event_type: z.string(),
  target_type: z.string(), target_id: z.string(), previous_state: z.unknown(), new_state: z.unknown(), timestamp: z.string(),
});
export const SupplierMessageDraftDto = z.object({
  id: Id, discrepancy_id: Id, body: z.string(), evidence_references: z.array(z.string()), sent: z.literal(false), created_at: z.string(),
});

// ---------- API envelope ----------
// Success: { data }. Failure: { error: { code, message } } with the matching HTTP status.
// Mutating endpoints require an `Idempotency-Key` header (8-128 chars); a replay returns the first response.
export const ErrorCode = z.enum([
  'unauthenticated', // 401
  'forbidden', // 403
  'not_found', // 404 (also used for other organisations' rows; never reveal existence)
  'invalid_request', // 400
  'conflict', // 409 state changed or concurrent action
  'rate_limited', // 429
  'internal', // 500, message is generic
]);
export const ApiError = z.object({ error: z.object({ code: ErrorCode, message: z.string() }) });
export const IdempotencyKey = z.string().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/);

// Minimum role per route. Organisation comes from the caller's membership, never from the request body.
export const ROUTES = {
  'POST /api/invoices': 'reviewer',
  'GET /api/invoices': 'viewer',
  'GET /api/invoices/:id': 'viewer',
  'POST /api/invoices/:id/process': 'reviewer',
  'GET /api/invoices/:id/discrepancies': 'viewer',
  'GET /api/invoices/:id/duplicate-candidates': 'viewer',
  'POST /api/purchase-orders': 'reviewer',
  'GET /api/purchase-orders': 'viewer',
  'POST /api/discrepancies/:id/investigate': 'reviewer',
  'GET /api/investigations/:id': 'viewer',
  'POST /api/discrepancies/:id/resolve': 'reviewer',
  'GET /api/discrepancies/:id/history': 'viewer',
  'POST /api/discrepancies/:id/draft-message': 'reviewer',
  'GET /api/jobs/run': 'system', // same worker; Vercel Cron calls with GET
  'POST /api/jobs/run': 'system', // worker; authenticated by CRON_SECRET, not a user session
  'GET /api/config': 'public', // no auth; returns ConfigDto
} as const satisfies Record<string, z.infer<typeof Role> | 'system' | 'public'>;

// ---------- added after the API package landed ----------
export const PurchaseOrderDto = z.object({
  id: Id, supplier_id: Id, supplier_name: z.string(), purchase_order_number: z.string(), currency: z.string(),
  tax_amount: MoneyString, total_amount: MoneyString, status: z.string(), created_at: z.string(),
  lines: z.array(LineItemDto.omit({ tax_amount: true })),
});
export const HistoryDto = z.object({ resolutions: z.array(ResolutionActionDto), audit: z.array(AuditEventDto) });

// Public client configuration. The anon key is a public value by Supabase's design; nothing secret goes here.
// 'dev' mode exists only in scripts/dev-server.ts (PGlite, fake users). api/index.ts must never return it.
export const ConfigDto = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('supabase'), supabase_url: z.string().url(), supabase_anon_key: z.string() }),
  z.object({ mode: z.literal('dev'), dev_users: z.array(z.object({ label: z.string(), token: z.string(), role: Role })) }),
]);
