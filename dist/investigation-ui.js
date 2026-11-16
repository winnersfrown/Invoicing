// AI investigation panel. investigationView() is pure (unit-tested); renderInvestigation() only maps it to DOM.
// All server and document text goes through textContent via h(); never innerHTML.

export const ACTION_TEXT = {
  approve_review_completion: 'Close the discrepancy as reviewed; no correction is needed.',
  request_corrected_invoice: 'Ask the supplier for a corrected invoice.',
  request_supplier_clarification: 'Ask the supplier to explain the difference.',
  investigate_duplicate: 'Check whether this invoice duplicates an earlier one before it is paid.',
  verify_po_amendment: 'Check whether the purchase order was amended to the invoiced terms.',
  correct_extraction_error: 'Correct the misread field against the original document.',
  escalate_to_reviewer: 'Escalate to a senior reviewer.',
  insufficient_evidence: 'Gather the missing information before deciding.',
};
const STATES = {
  none: ['Not investigated', 'No AI investigation has run for this discrepancy yet.'],
  queued: ['Queued', 'Waiting for an investigation worker. This panel updates on its own.'],
  in_progress: ['In progress', 'The AI is reading the deterministic evidence for this discrepancy. This panel updates on its own.'],
  completed: ['Completed', 'Investigation finished. Review the findings and their evidence before deciding.'],
  insufficient_evidence: ['Insufficient evidence', 'The AI could not confirm a cause from the available evidence. See what is missing below.'],
  failed: ['Failed', 'The investigation did not finish.'],
};
const cap = s => s ? s[0].toUpperCase() + s.slice(1) : '';

/** Decimal string to display text without converting through floating point. */
export function formatMoney(amount, currency = 'USD') {
  if (amount == null || !/^-?\d+\.\d{2}$/.test(amount)) return amount ?? '—';
  const neg = amount.startsWith('-'), [int, frac] = amount.replace('-', '').split('.');
  return `${neg ? '-' : ''}${currency === 'USD' ? '$' : `${currency} `}${int.replace(/\B(?=(\d{3})+$)/g, ',')}.${frac}`;
}

export function investigationView(dto) {
  if (!dto) return {state: 'none', label: STATES.none[0], message: STATES.none[1], polling: false, canRetry: false, result: null};
  const known = STATES[dto.investigation_status] && dto.investigation_status !== 'none';
  const state = known ? dto.investigation_status : 'failed';
  const [label, message] = STATES[state];
  const view = {state, label, message, polling: state === 'queued' || state === 'in_progress', canRetry: false, result: null, id: dto.id};
  if (state === 'failed') {
    view.canRetry = known ? dto.retry_available !== false : true;
    view.message = known ? (dto.error ? `${message} ${dto.error}` : `${message} No error detail was recorded.`) : `Unrecognised investigation status "${dto.investigation_status}". Treat it as failed.`;
  }
  const r = dto.result;
  if (r && (state === 'completed' || state === 'insufficient_evidence')) {
    const byId = new Map((r.evidence ?? []).map(e => [e.id, e]));
    view.result = {
      summary: r.summary,
      findings: (r.findings ?? []).map(f => ({claim: f.claim, evidence: f.evidence_ids.map(id => byId.get(id) ?? {id, label: id, value: 'This evidence item was not returned with the result.', missing: true})})),
      possibleCauses: r.possible_causes ?? [],
      missingInformation: r.missing_information ?? [],
      action: {code: r.recommended_action, text: ACTION_TEXT[r.recommended_action] ?? r.recommended_action},
      confidence: cap(r.confidence),
      impact: r.verified_financial_impact ? {text: formatMoney(r.verified_financial_impact.amount, r.verified_financial_impact.currency),
        source: 'From deterministic validation (matching engine), not from the AI.'} : null,
      approvalRequired: true, // the contract fixes requires_human_approval to true
    };
  }
  return view;
}

// ---------- DOM ----------
export function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (typeof v === 'boolean' || k === 'value') el[k] = v;
    else el.setAttribute(k, v);
  }
  return fill(el, ...kids);
}
/** replaceChildren that skips null/false and flattens arrays, as h() does. */
export function fill(el, ...kids) {
  el.replaceChildren(...kids.flat(Infinity).filter(c => c != null && c !== false));
  return el;
}

export const evidenceText = e => `${e.label}${e.page ? ` · page ${e.page}` : ''}`;

/** Panel element for a view. canAct: the caller may retry (not a viewer). onEvidence(item) opens the evidence viewer. */
export function renderInvestigation(view, {canAct = false, onRetry, onEvidence = () => {}} = {}) {
  const r = view.result;
  const list = (items, empty) => items.length ? h('ul', {}, items.map(t => h('li', {}, t))) : h('p', {}, empty);
  return h('section', {class: `ai-panel ai-${view.state}`, 'aria-label': 'AI investigation'},
    h('div', {class: 'ai-head'}, h('span', {class: 'eyebrow'}, 'AI INVESTIGATION'), h('span', {class: `ai-state ai-state-${view.state}`}, view.label)),
    h('p', {class: 'ai-message'}, view.message),
    view.state === 'failed' && view.canRetry && canAct && onRetry && h('button', {type: 'button', class: 'button secondary', onclick: onRetry}, 'Retry investigation'),
    r && [
      h('h4', {}, 'Summary'), h('p', {}, r.summary),
      h('h4', {}, 'Confirmed findings'),
      r.findings.length ? h('ol', {class: 'ai-findings'}, r.findings.map(f => h('li', {}, h('span', {}, f.claim),
        h('div', {class: 'evidence-refs'}, f.evidence.map(e => h('button', {type: 'button', class: 'evidence-ref', 'data-ref': e.id, title: e.value, onclick: () => onEvidence(e)},
          h('strong', {}, evidenceText(e)), h('small', {}, e.value))))))) : h('p', {}, 'No finding could be confirmed from the evidence.'),
      h('h4', {}, 'Possible causes ', h('span', {class: 'demo-badge'}, 'UNCONFIRMED')),
      h('p', {class: 'hint'}, 'Leads to check, not established facts.'),
      list(r.possibleCauses, 'None suggested.'),
      h('h4', {}, 'Missing information'), list(r.missingInformation, 'Nothing reported missing.'),
      h('div', {class: 'ai-facts'},
        h('div', {}, h('small', {}, 'RECOMMENDED ACTION'), h('strong', {}, r.action.text)),
        h('div', {}, h('small', {}, 'CONFIDENCE'), h('strong', {}, r.confidence)),
        h('div', {}, h('small', {}, 'VERIFIED DIFFERENCE'), h('strong', {}, r.impact ? r.impact.text : 'No amount'),
          h('small', {}, r.impact ? r.impact.source : 'Deterministic validation produced no amount for this discrepancy.'))),
      h('p', {class: 'check'}, 'Approval required. The recommendation changes nothing until a reviewer approves it.'),
    ]);
}
