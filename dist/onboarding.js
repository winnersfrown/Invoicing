import {compareDocuments, correctionDraft} from './matching-engine.js';
import {money} from './engine.js';

const key='rekono-guided-start-v1';
let complete=true;
const nav=document.querySelector('.sidebar nav');const content=document.querySelector('.content');
const guide=document.createElement('section');guide.className='panel guided-start';guide.setAttribute('aria-label','Getting started');
guide.innerHTML='<span class="eyebrow">START HERE · ABOUT TWO MINUTES</span><h2>Try one invoice first.</h2><p>Upload an invoice, check what Sorikano read, then compare it with a purchase order. Missing fields can be finished later.</p><ol><li>1. Add an invoice</li><li>2. Review the extracted details</li><li>3. Match its purchase order</li></ol><div class="actions"><button class="button primary" data-import>Upload your first invoice</button><button class="button secondary" data-example>Try the $60 example</button></div><p data-next role="status"></p>';
content.prepend(guide);
const explore=document.createElement('button');explore.className='text-button explore-features';explore.textContent='Explore all features';nav.after(explore);
function render(){document.body.classList.toggle('guided-mode',!complete);explore.hidden=complete;guide.hidden=complete;}
function finish(){complete=true;try{localStorage.setItem(key,'done');}catch{}render();}
guide.querySelector('[data-import]').onclick=()=>document.querySelector('#upload').click();
guide.querySelector('[data-example]').onclick=()=>document.querySelector('#load-workflow').click();
explore.onclick=finish;
window.addEventListener('rekono-document-added',()=>{if(complete)return;finish();const note=document.createElement('div');note.className='notice';note.textContent='Invoice added. Next: process the invoice, review any missing details, then choose Match purchase order. All workspace tools are now available.';content.prepend(note);});
const dialog = document.querySelector('#tutorial');
const replay = document.querySelector('#open-tutorial');
const title = dialog.querySelector('#tutorial-title');
const description = dialog.querySelector('#tutorial-description');
const welcome = [title.textContent, description.textContent];
const next = dialog.querySelector('#tutorial-next');
const back = dialog.querySelector('#tutorial-back');
const exit = dialog.querySelector('#tutorial-exit');
const evidence = dialog.querySelector('#tutorial-evidence');
const draft = dialog.querySelector('#tutorial-draft');
const status = dialog.querySelector('#tutorial-status');
let step = 0;
let example;
let session = 0;

function row(label, amount) {
  const line = document.createElement('div');
  line.className = 'tutorial-row';
  const name = document.createElement('span');
  name.textContent = label;
  const value = document.createElement('strong');
  value.textContent = amount;
  line.append(name, value);
  return line;
}

function showStep(number) {
  step = number;
  status.textContent = '';
  next.disabled = false;
  evidence.replaceChildren();
  evidence.hidden = step !== 1 && step !== 2;
  dialog.querySelector('#tutorial-message').hidden = step !== 3;
  dialog.querySelector('.tutorial-art').hidden = step !== 0;
  const progress = dialog.querySelector('.tutorial-step');
  progress.hidden = step === 0;
  progress.textContent = step ? `Step ${step} of 3` : '';
  exit.hidden = step === 0;
  back.textContent = step ? 'Back' : 'Skip for now';

  if (step === 0) {
    [title.textContent, description.textContent] = welcome;
    next.textContent = 'Start tutorial';
  } else if (step === 1) {
    const {invoice, po} = example;
    title.textContent = 'Compare the documents';
    description.textContent = `Compare what ${invoice.vendor} billed with what the purchase order authorized.`;
    evidence.append(row(invoice.number, money(invoice.total)), row(po.number, money(po.total)));
    next.textContent = 'Compare line items';
  } else if (step === 2) {
    const {result} = example;
    const line = result.lines.find(item => item.changed);
    title.textContent = `Find the ${money(result.differenceCents / 100)} difference`;
    description.textContent = line.description;
    evidence.append(
      row('Invoiced', `${line.invoice.quantity} × ${money(line.invoice.unitPrice)}`),
      row('Ordered', `${line.po.quantity} × ${money(line.po.unitPrice)}`),
      row('Overcharge', money(line.differenceCents / 100))
    );
    next.textContent = 'Draft correction request';
  } else {
    title.textContent = 'Review the correction request';
    description.textContent = 'Edit this practice message before finishing. Your edits stay in the tutorial.';
    next.textContent = 'Finish tutorial';
  }
  if (dialog.open) title.focus();
}

function openTutorial() {
  session++;
  draft.value = '';
  showStep(0);
  dialog.showModal();
  title.focus();
}

function dismiss() {
  session++;
  finish();
  dialog.close();
  replay.focus();
}

async function startTutorial() {
  const active = session;
  next.disabled = true;
  status.textContent = 'Opening the sample documents…';
  try {
    if (!example) {
      const [invoice, po] = await Promise.all(['invoice', 'po'].map(async kind => {
        const response = await fetch(`samples/matching-${kind}.json`);
        if (!response.ok) throw Error('Sample unavailable');
        return response.json();
      }));
      example = {invoice, po, result: compareDocuments(invoice, po)};
    }
    if (active !== session) return;
    draft.value = correctionDraft(example.invoice, example.po, example.result);
    // Remember the choice even if the visitor leaves during the tour.
    finish();
    showStep(1);
  } catch {
    if (active !== session) return;
    status.textContent = 'The sample documents could not load. Try again or skip to the workspace.';
    next.disabled = false;
    next.focus();
  }
}

next.onclick = () => {
  if (step === 0) return startTutorial();
  if (step < 3) return showStep(step + 1);
  dismiss();
  if (!document.body.classList.contains('server-mode')) {
    document.querySelector('[data-page=invoices]').click();
    complete = false;
    render();
    guide.querySelector('[data-import]').focus();
  }
};
back.onclick = () => {
  if (step === 0) dismiss();
  else showStep(step - 1);
};
exit.onclick = dismiss;
dialog.addEventListener('cancel', event => {
  event.preventDefault();
  dismiss();
});
replay.onclick = openTutorial;
window.addEventListener('invoicing-reset', () => {
  if (!dialog.open) openTutorial();
});
render();
let seen = false;
try { seen = localStorage.getItem(key) === 'done'; } catch {}
if (!seen) openTutorial();
