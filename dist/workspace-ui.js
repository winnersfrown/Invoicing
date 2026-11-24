import {ACTION_TEXT, fill, formatMoney, h} from './investigation-ui.js';
import {createServerInbox, warningPresentation} from './server-inbox.js';

const SECTIONS = [
  ['inbox', 'Invoice Inbox', '▤'],
  ['orders', 'Purchase Orders', '▧'],
  ['discrepancies', 'Discrepancy Review', '!'],
  ['activity', 'Activity History', '◷'],
  ['tutorial', 'Tutorial', '?'],
];
const TUTORIAL_STEPS = [
  {title: 'Review the sample invoice', text: 'Open Northstar Paper Co. invoice NS-1068. Check the supplier, PO reference, two line items and $660 invoice total.', target: 'matching'},
  {title: 'Compare the invoice and purchase order', text: 'Compare NS-1068 with PO-2026-042. The order totals $600. For 12 cases of copy paper, a $5 difference per case accounts for the $60 discrepancy.', target: 'matching'},
  {title: 'Investigate the $60 discrepancy', text: 'Open the unit-price finding, select Investigate with AI, and use the evidence links to verify what the invoice and purchase order say.', target: 'finding'},
  {title: 'Record a decision and review the next step', text: 'Record a Reviewer decision on the sample finding. Read the next-step feedback. If a correction is needed, you can draft a supplier request and download it as text.', target: 'finding'},
];
const EVENT_LABELS = {
  'invoice.linked': 'Invoice matched to purchase order',
  'invoice.fields_reviewed': 'Invoice fields reviewed',
  'invoice.purchase_order_unlinked': 'Purchase order unlinked',
  'invoice.line_match_reviewed': 'Line match reviewed',
  'resolution.recorded': 'Reviewer decision recorded',
  'supplier_message.drafted': 'Supplier correction request drafted',
};
const words = value => {
  const phrase = value.replaceAll(/[_.]/g, ' ');
  return phrase[0].toUpperCase() + phrase.slice(1);
};
const money = (amount, currency) => currency ? formatMoney(amount, currency) : (amount ?? '—');
const button = (label, onclick, className = 'button secondary') => h('button', {type: 'button', class: className, onclick}, label);
const table = (headers, rows, empty) => rows.length
  ? h('div', {class: 'table-scroll'}, h('table', {}, h('thead', {}, h('tr', {}, headers.map(label => h('th', {scope: 'col'}, label)))), h('tbody', {}, rows)))
  : h('p', {class: 'workspace-empty'}, empty);
const row = (...cells) => h('tr', {}, cells.map(content => h('td', {}, content)));
const download = (file, label) => h('a', {href: `samples/${file}`, download: file}, label);

export function createWorkspace({api, root, nav, breadcrumb, restoreSection = false}) {
  const inboxHost = h('div');
  const view = h('div');
  const heading = h('h1', {id: 'workspace-title', tabindex: '-1'});
  fill(root, h('div', {class: 'page-heading'}, heading), inboxHost, view);
  let current = '', activeView = null, reloadView = null, orderDialog = null, stopped = false;
  let tutorialStep = 0;
  const inbox = createServerInbox({api, root: inboxHost, onDetailClosed: () => reloadView?.()});

  const links = SECTIONS.map(([key, label, icon]) =>
    h('button', {type: 'button', class: 'nav', onclick: () => navigate(key, true)},
      h('span', {class: 'workspace-nav-icon', 'aria-hidden': 'true'}, icon), label));
  fill(nav, links);
  nav.hidden = false;

  function navigate(key, focus = false) {
    if (stopped) return;
    const previous = current;
    current = key;
    const url = new URL(location.href);
    if (key === 'inbox') url.searchParams.delete('section');
    else url.searchParams.set('section', key);
    history.replaceState(history.state, '', url);
    for (const [index, [id, label]] of SECTIONS.entries()) {
      const selected = id === key;
      links[index].classList.toggle('active', selected);
      if (selected) {
        links[index].setAttribute('aria-current', 'page');
        heading.textContent = breadcrumb.textContent = label;
      } else links[index].removeAttribute('aria-current');
    }
    inboxHost.hidden = key !== 'inbox';
    view.hidden = !inboxHost.hidden;
    if (focus) heading.focus();
    fill(view);
    activeView = null;
    reloadView = null;
    if (key === 'inbox') {
      if (previous) inbox.refresh();
      return;
    }

    const body = h('div');
    const status = h('p', {class: 'match-message', role: 'status'});
    const page = h('section', {class: 'panel workspace-section', 'aria-labelledby': heading.id},
      key === 'orders' && h('div', {class: 'workspace-tools'}, button('Upload purchase order', ev =>
        inbox.choosePurchaseOrder(ev.currentTarget, () => loadPage(page, body, key), message => { status.textContent = message; }), 'button primary')),
      status, body);
    activeView = page;
    reloadView = () => loadPage(page, body, key);
    fill(view, page);
    loadPage(page, body, key);
  }

  async function loadPage(page, body, key) {
    if (page !== activeView) return;
    fill(body, h('p', {class: 'workspace-empty', role: 'status'}, 'Loading workspace records…'));
    try {
      const content = await ({orders, discrepancies, tutorial, activity})[key]();
      if (page === activeView) fill(body, content);
    } catch (error) {
      if (page === activeView) fill(body, h('div', {class: 'workspace-empty'}, h('p', {role: 'alert'}, error.message),
        button('Try again', () => loadPage(page, body, key))));
    }
  }

  const invoiceButton = (id, label, target) => button(label, () => inbox.openDetail(id, target), 'row-action');

  async function orders() {
    const data = await api.get('/api/purchase-orders');
    return table(['Purchase order', 'Supplier', 'Total', 'Status', 'Details'], data.map(po =>
      row(po.purchase_order_number, po.supplier_name, money(po.total_amount, po.currency), words(po.status),
        button('View order', () => openOrder(po.id), 'row-action'))), 'Upload a purchase order to see it here.');
  }

  async function openOrder(id) {
    orderDialog?.close();
    const content = h('div', {class: 'workspace-order-body'}, h('p', {role: 'status'}, 'Loading purchase order…'));
    const title = h('h2', {id: 'workspace-order-title'}, 'Purchase order');
    const dialog = h('dialog', {class: 'server-detail', 'aria-labelledby': title.id},
      h('div', {class: 'dialog-top'}, title, h('button', {type: 'button', class: 'icon-button', 'aria-label': 'Close purchase order', onclick: () => dialog.close()}, '×')), content);
    orderDialog = dialog;
    dialog.addEventListener('close', () => {
      if (orderDialog === dialog) orderDialog = null;
      dialog.remove();
    }, {once: true});
    document.body.append(dialog);
    dialog.showModal();
    try {
      const [po, active, archived] = await Promise.all([
        api.get(`/api/purchase-orders/${id}`), api.get('/api/invoices'), api.get('/api/invoices/archived'),
      ]);
      const associated = [...active, ...archived].filter(inv => inv.purchase_order_id === po.id);
      if (!dialog.open) return;
      title.textContent = po.purchase_order_number;
      fill(content, h('p', {}, `${po.supplier_name} · ${words(po.status)} · ${po.currency}`),
        table(['Item', 'SKU', 'Quantity', 'Unit price', 'Amount'], po.lines.map(line =>
          row(line.description, line.sku ?? '—', String(line.quantity), money(line.unit_price, po.currency), money(line.line_total, po.currency))),
        'No line items recorded.'),
        h('p', {}, `Tax ${money(po.tax_amount, po.currency)}`), h('strong', {}, `Total ${money(po.total_amount, po.currency)}`),
        h('h3', {}, 'Associated invoices'),
        table(['Invoice', 'Supplier', 'Total', 'Status', 'Details'], associated.map(inv =>
          row(inv.invoice_number ?? 'Invoice', inv.supplier_name ?? '—', money(inv.total_amount, inv.currency),
            inv.archived_at ? 'Archived' : words(inv.status),
            button('Open invoice', () => { dialog.close(); inbox.openDetail(inv.id, 'matching'); }, 'row-action'))),
        'No listed invoices are linked to this purchase order.'));
    } catch (error) {
      if (dialog.open) fill(content, h('p', {role: 'alert'}, error.message), button('Try again', () => openOrder(id)));
    }
  }

  async function discrepancies() {
    const [findings, duplicates] = await Promise.all([
      api.get('/api/workspace/findings?kind=discrepancies'),
      api.get('/api/workspace/findings?kind=duplicates'),
    ]);
    const findingTable = (data, duplicate) => table(
      ['Invoice', 'Supplier', 'Finding', duplicate ? 'Suspected duplicate' : 'Difference', 'Status', 'Details'],
      data.map(finding => row(finding.invoice_number ?? 'Invoice', finding.supplier_name ?? '—',
        warningPresentation(finding).title,
        duplicate ? (finding.observed_value ?? 'Reference unavailable') : money(finding.difference_amount, finding.currency),
        words(finding.status), invoiceButton(finding.invoice_id, 'Review finding', `discrepancy:${finding.id}`))),
      duplicate ? 'No open duplicate findings in your active invoices.' : 'No open discrepancies in your active invoices.');
    return [findingTable(findings, false), h('h2', {class: 'workspace-subheading'}, 'Suspected duplicates'), findingTable(duplicates, true)];
  }

  async function tutorial() {
    const [active, archived] = await Promise.all([api.get('/api/invoices'), api.get('/api/invoices/archived')]);
    const sample = [...active, ...archived].filter(inv =>
      inv.invoice_number === 'NS-1068' && inv.supplier_name === 'Northstar Paper Co.' &&
      inv.po_reference === 'PO-2026-042' && inv.invoice_date === '2026-11-13' &&
      inv.currency === 'USD' && inv.total_amount === '660.00')
      .sort((a, b) => a.created_at.localeCompare(b.created_at))[0];
    const panel = h('div', {class: 'workspace-guide'});
    const alert = h('p', {role: 'alert'});

    async function openFinding(ev) {
      const trigger = ev.currentTarget;
      const step = tutorialStep;
      trigger.disabled = true;
      alert.textContent = '';
      try {
        const findings = await api.get(`/api/invoices/${sample.id}/discrepancies`);
        if (!panel.isConnected || tutorialStep !== step) return;
        const matches = findings.filter(f => f.discrepancy_type === 'unit_price_mismatch' && Number(f.difference_amount) === 60);
        const finding = matches.find(f => !['dismissed', 'resolved'].includes(f.status)) ?? matches.at(-1);
        if (finding) await inbox.openDetail(sample.id, `discrepancy:${finding.id}`);
        else alert.textContent = 'The $60 finding is unavailable. You can still open the original sample invoice.';
      } catch (error) { alert.textContent = error.message; }
      finally { trigger.disabled = false; }
    }

    function showStep(focus = false) {
      const step = TUTORIAL_STEPS[tutorialStep];
      const title = h('h2', {tabindex: '-1'}, step?.title ?? 'Walkthrough complete');
      alert.textContent = '';
      const move = (index, label, className) => button(label, () => { tutorialStep = index; showStep(true); }, className);
      fill(panel, h('p', {class: 'workspace-tutorial-progress'}, step
        ? `$60 discrepancy walkthrough · Step ${tutorialStep + 1} of ${TUTORIAL_STEPS.length}` : '$60 discrepancy walkthrough'),
      title, h('p', {}, step?.text ?? 'Return to the inbox to review invoices, or open Activity History to find your recorded decisions.'),
      sample && step && h('div', {class: 'actions'},
        invoiceButton(sample.id, sample.archived_at ? 'Open archived sample invoice' : 'Open sample invoice', 'matching'),
        step.target === 'finding' && button('Open the $60 finding', openFinding)),
      !sample && step && h('p', {class: 'hint'}, 'The seeded sample invoice is unavailable in your current workspace list. You can still follow the guide and download the fictional originals.'),
      alert,
      h('div', {class: 'actions'},
        step && tutorialStep > 0 && move(tutorialStep - 1, 'Previous step'),
        step && move(tutorialStep + 1, tutorialStep === TUTORIAL_STEPS.length - 1 ? 'Finish tutorial' : 'Next step', 'button primary'),
        !step && move(0, 'Restart tutorial'),
        !step && button('Open Invoice Inbox', () => navigate('inbox', true), 'button primary')),
      h('details', {}, h('summary', {}, 'Download fictional sample files'),
        h('ul', {class: 'workspace-sample-files'}, [
          ['matching-invoice.json', 'Invoice JSON'], ['matching-invoice.pdf', 'Invoice PDF'], ['matching-invoice.png', 'Invoice image'],
          ['matching-po.json', 'Purchase order JSON'], ['matching-po.pdf', 'Purchase order PDF'],
        ].map(([file, label]) => h('li', {}, download(file, label))))));
      if (focus) title.focus();
    }

    showStep();
    return panel;
  }

  async function activity() {
    const path = '/api/workspace/activity';
    const {events, next_before} = await api.get(path);
    const list = h('div');
    const controls = h('div', {class: 'workspace-tools'});
    function append(entries, next) {
      list.append(...entries.map(event => h('article', {class: 'activity-item workspace-event'},
        h('div', {},
          h('strong', {}, EVENT_LABELS[event.event_type] ?? words(event.event_type)),
          h('small', {}, `${new Date(event.timestamp).toLocaleString()} · ${event.actor_type === 'user' ? 'Reviewer' : words(event.actor_type)}`),
          event.approval_status && h('p', {}, words(event.approval_status),
            event.approved_action ? ` · ${ACTION_TEXT[event.approved_action] ?? words(event.approved_action)}` : ''),
          event.reviewer_notes && h('p', {}, event.reviewer_notes)),
        event.invoice_id && invoiceButton(event.invoice_id, event.invoice_number ?? 'Open invoice',
          event.discrepancy_id ? `discrepancy:${event.discrepancy_id}` : 'invoice-history'),
        event.purchase_order_id && button(event.purchase_order_number, () => openOrder(event.purchase_order_id), 'row-action'))));
      if (!next) { fill(controls); return; }
      const error = h('p', {role: 'alert'});
      fill(controls, button('Load older activity', async ev => {
        const more = ev.currentTarget;
        more.disabled = true;
        error.textContent = '';
        try {
          const page = await api.get(`${path}?before=${encodeURIComponent(next)}`);
          append(page.events, page.next_before);
        } catch (e) { error.textContent = e.message; }
        finally { more.disabled = false; }
      }), error);
    }
    append(events, next_before);
    return events.length ? [list, controls] : h('p', {class: 'workspace-empty'}, 'No activity recorded yet.');
  }

  const savedSection = new URLSearchParams(location.search).get('section');
  navigate(restoreSection && SECTIONS.some(([key]) => key === savedSection) ? savedSection : 'inbox');
  return {stop() {
    stopped = true;
    activeView = null;
    reloadView = null;
    orderDialog?.close();
    inbox.stop();
    fill(nav);
    nav.hidden = true;
    fill(root);
    breadcrumb.textContent = 'Invoice workspace';
  }};
}
