const key='rekono-guided-start-v1';
let complete=false;try{complete=localStorage.getItem(key)==='done';}catch{}
const nav=document.querySelector('.sidebar nav');const content=document.querySelector('.content');
const guide=document.createElement('section');guide.className='panel guided-start';guide.setAttribute('aria-label','Getting started');
guide.innerHTML='<span class="eyebrow">START HERE · ABOUT TWO MINUTES</span><h2>Try one invoice first.</h2><p>Upload an invoice, check what Rekono read, then compare it with a purchase order. Missing fields can be finished later.</p><ol><li>1. Add an invoice</li><li>2. Review the extracted details</li><li>3. Match its purchase order</li></ol><div class="actions"><button class="button primary" data-import>Upload your first invoice</button><button class="button secondary" data-example>Try the $60 example</button></div><p data-next role="status"></p>';
content.prepend(guide);
const explore=document.createElement('button');explore.className='text-button explore-features';explore.textContent='Explore all features';nav.after(explore);
function render(){document.body.classList.toggle('guided-mode',!complete);explore.hidden=complete;guide.hidden=complete;}
function finish(){complete=true;try{localStorage.setItem(key,'done');}catch{}render();}
guide.querySelector('[data-import]').onclick=()=>document.querySelector('#upload').click();
guide.querySelector('[data-example]').onclick=()=>document.querySelector('#load-workflow').click();
explore.onclick=finish;
const restart=document.createElement('button');restart.className='text-button';restart.textContent='Guided start';nav.after(restart);restart.onclick=()=>{complete=false;try{localStorage.removeItem(key);}catch{}document.querySelector('[data-page=invoices]').click();render();};
window.addEventListener('rekono-document-added',()=>{finish();const note=document.createElement('div');note.className='notice';note.textContent='Invoice added. Next: process the invoice, review any missing details, then choose Match purchase order. All workspace tools are now available.';content.prepend(note);});
window.addEventListener('invoicing-reset',()=>{complete=false;try{localStorage.removeItem(key);}catch{}render();});
render();
