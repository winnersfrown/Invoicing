import {ACTION_TEXT, fill, formatMoney, h} from './investigation-ui.js';
import {createServerInbox, warningPresentation} from './server-inbox.js';

const SECTIONS = [
  ['inbox', 'Invoice Inbox'],
  ['orders', 'Purchase Orders'],
  ['duplicates', 'Duplicate Review'],
  ['matching', 'Invoice & PO Matching'],
  ['discrepancies', 'Discrepancy Resolution'],
  ['samples', 'Sample Documents & Tutorial'],
  ['activity', 'Activity History'],
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

export function createWorkspace({api, root, nav, breadcrumb}) {
  const inboxHost = h('div');
  const view = h('div');
  const heading = h('h1', {id: 'workspace-title', tabindex: '-1'});
  fill(root, h('div', {class: 'page-heading'}, heading), inboxHost, view);
  let current = '', activeView = null, reloadView = null, orderDialog = null, stopped = false;
  const inbox = createServerInbox({api, root: inboxHost, onDetailClosed: () => reloadView?.()});

  const links = SECTIONS.map(([key, label]) => button(label, () => navigate(key, true), 'nav'));
  fill(nav, links);
  nav.hidden = false;

  function navigate(key, focus = false) {
    if (stopped) return;
    const previous = current;
    current = key;
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
      const content = await ({orders, duplicates: () => findings('duplicates'), matching,
        discrepancies: () => findings('discrepancies'), samples, activity})[key]();
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
      const po = await api.get(`/api/purchase-orders/${id}`);
      if (!dialog.open) return;
      title.textContent = po.purchase_order_number;
      fill(content, h('p', {}, `${po.supplier_name} · ${words(po.status)} · ${po.currency}`),
        table(['Item', 'SKU', 'Quantity', 'Unit price', 'Amount'], po.lines.map(line =>
          row(line.description, line.sku ?? '—', String(line.quantity), money(line.unit_price, po.currency), money(line.line_total, po.currency))),
        'No line items recorded.'),
        h('p', {}, `Tax ${money(po.tax_amount, po.currency)}`), h('strong', {}, `Total ${money(po.total_amount, po.currency)}`));
    } catch (error) {
      if (dialog.open) fill(content, h('p', {role: 'alert'}, error.message), button('Try again', () => openOrder(id)));
    }
  }

  async function findings(kind) {
    const data = await api.get(`/api/workspace/findings?kind=${kind}`);
    const duplicates = kind === 'duplicates';
    return table(['Invoice', 'Supplier', 'Finding', duplicates ? 'Suspected duplicate' : 'Difference', 'Status', 'Details'], data.map(finding =>
      row(finding.invoice_number ?? 'Invoice', finding.supplier_name ?? '—', warningPresentation(finding).title,
        duplicates ? finding.observed_value ?? 'Reference unavailable' : money(finding.difference_amount, finding.currency),
        words(finding.status), invoiceButton(finding.invoice_id, 'Review finding', `discrepancy:${finding.id}`))),
    duplicates ? 'No open duplicate findings in your active invoices.' : 'No open discrepancies in your active invoices.');
  }

  async function matching() {
    const invoices = await api.get('/api/invoices');
    return table(['Invoice', 'Supplier', 'PO reference', 'Match', 'Details'],
      invoices.filter(inv => !['rejected', 'superseded'].includes(inv.status)).map(inv =>
        row(inv.invoice_number ?? 'Invoice', inv.supplier_name ?? '—', inv.po_reference ?? '—',
          inv.purchase_order_id ? 'PO linked' : 'No linked PO', invoiceButton(inv.id, 'Open comparison', 'matching'))),
      'Upload an invoice to compare it with a purchase order.');
  }

  async function samples() {
    const [active, archived] = await Promise.all([api.get('/api/invoices'), api.get('/api/invoices/archived')]);
    const sample = [...active, ...archived].find(inv =>
      inv.invoice_number === 'NS-1068' && inv.po_reference === 'PO-2026-042' && inv.total_amount === '660.00');
    return h('div', {class: 'workspace-guide'},
      h('h2', {}, 'Investigate a $60 price discrepancy'),
      h('p', {}, 'Northstar Paper Co. billed 12 cases at $45 each. The purchase order lists $40 per case. Both documents are fictional.'),
      h('ol', {},
        h('li', {}, 'Open invoice NS-1068 and compare it with purchase order PO-2026-042. If you are importing the samples, upload the purchase order first.'),
        h('li', {}, 'Open the $60 unit-price finding, investigate it with AI, and use the evidence links to check the invoice and purchase order.'),
        h('li', {}, 'Record a Reviewer decision, review the next step, and draft a supplier correction request. The draft can be downloaded as text.'),
        h('li', {}, 'If the supplier sends a revised invoice, upload it as a correction. Use Activity History to revisit decisions and document changes.')),
      h('div', {class: 'actions'}, sample ? invoiceButton(sample.id, sample.archived_at ? 'Open archived sample invoice' : 'Open sample invoice', 'matching')
        : button('Open Invoice Inbox', () => navigate('inbox', true)),
      button('Open Purchase Orders', () => navigate('orders', true))),
      h('h3', {}, 'Sample files'),
      h('ul', {class: 'workspace-sample-files'}, [
        ['matching-invoice.json', 'Invoice JSON'], ['matching-invoice.pdf', 'Invoice PDF'], ['matching-invoice.png', 'Invoice image'],
        ['matching-po.json', 'Purchase order JSON'], ['matching-po.pdf', 'Purchase order PDF'],
      ].map(([file, label]) => h('li', {}, download(file, label)))));
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
          event.discrepancy_id ? `discrepancy:${event.discrepancy_id}` : undefined),
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

  navigate('inbox');
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
