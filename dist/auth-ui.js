// Account entry and mode switch. The signed-out demo runs in the browser.
// The browser holds only the Supabase anon key (public by design) and the user's own session token.
import {createApiClient} from './api-client.js';
import {createServerInbox} from './server-inbox.js';
import {fill, h} from './investigation-ui.js';

const SUPABASE_ESM = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.119.0/+esm'; // pinned, like PDF.js in extraction.js
const DEV_KEY = 'rekono-dev-session';
const ROLE = {admin: 'Admin', reviewer: 'Reviewer', viewer: 'Viewer'};
const area = document.querySelector('#auth-area');
let config = null, supabase = null, user = null, inbox = null;

const api = createApiClient({
  getToken: async () => (config?.mode === 'supabase' ? (await supabase?.auth.getSession())?.data.session?.access_token : user?.token) ?? null,
  onUnauthenticated: () => { if (user) signOut('Your session has ended. Sign in again.'); },
});

function renderArea(message = '') {
  const note = h('span', {class: 'auth-label', role: 'status'}, message);
  if (user) {
    fill(area, h('span', {class: 'auth-label'}, user.label), h('span', {class: 'demo-badge'}, `${ROLE[user.role] ?? user.role}`.toUpperCase()),
      h('button', {type: 'button', class: 'button secondary', onclick: () => signOut()}, 'Sign out'), note);
  } else {
    fill(area, h('span', {class: 'demo-badge'}, 'DEMO MODE'), h('span', {class: 'auth-label'}, 'Local demo, data stays in this browser'),
      config && h('button', {type: 'button', class: 'button secondary', onclick: () => openAuth()}, 'Sign in'),
      config?.public_signup && h('button', {type: 'button', class: 'button primary', onclick: () => openAuth(true)}, 'Sign up'), note);
  }
}

function enter(next) {
  user = next;
  document.body.classList.add('server-mode');
  document.querySelector('[data-page=invoices]')?.click();
  inbox?.stop();
  inbox = createServerInbox({api, root: document.querySelector('#invoices-page'), user});
  renderArea(`Signed in. ${ROLE[user.role] ?? user.role} access.${config.mode==='dev'?' Scripted demo — no OpenAI calls.':''}`);
}

async function signOut(message = 'Signed out. Back to the local demo.') {
  inbox?.stop();
  inbox = null;
  user = null;
  sessionStorage.removeItem(DEV_KEY);
  document.body.classList.remove('server-mode');
  if (supabase) await supabase.auth.signOut().catch(() => {});
  renderArea(message);
}

async function loadSupabase() {
  if (!supabase) {
    const {createClient} = await import(SUPABASE_ESM).catch(() => { throw Error('Sign-in library could not load. Check your internet connection and retry.'); });
    supabase = createClient(config.supabase_url, config.supabase_anon_key);
  }
  return supabase;
}

/** Role for display and hiding controls only; the server enforces roles on every call. Mirrors server/services/auth.ts (oldest membership). */
async function supabaseUser(session) {
  const {data, error} = await supabase.from('organization_memberships').select('role').eq('user_id', session.user.id)
    .order('created_at', {ascending: true}).order('organization_id', {ascending: true}).limit(1);
  if (error) throw Error('Could not load your workspace. Try signing in again.');
  const membership = data?.[0] ?? (config.public_signup ? await api.send('POST', '/api/workspace') : null);
  if (!membership) throw Error('Your account has no workspace yet. Ask an admin to add you.');
  return {label: session.user.email ?? 'Signed in', role: membership.role};
}

function openAuth(signup = false) {
  const title = signup ? 'Create your Sorikano account' : 'Sign in';
  const error = h('p', {class: 'ocr-error', role: 'alert'});
  const submit = h('button', {type: 'submit', class: 'button primary'}, signup ? 'Create account' : 'Sign in');
  const fields = config.mode === 'dev'
    ? [h('p', {}, 'Local development server. Choose a seeded user.'), h('label', {}, 'User', h('select', {name: 'user', required: true}, config.dev_users.map((u, i) => h('option', {value: String(i)}, `${u.label} (${ROLE[u.role] ?? u.role})`))))]
    : [h('label', {}, 'Email', h('input', {name: 'email', type: 'email', autocomplete: 'username', required: true})),
      h('label', {}, signup ? 'Password (8 or more characters)' : 'Password',
        h('input', {name: 'password', type: 'password', autocomplete: signup ? 'new-password' : 'current-password', required: true, ...(signup && {minlength: '8'})}))];
  const form = h('form', {class: 'auth-form'}, signup && h('p', {}, 'Confirm your email to open a private workspace with a sample invoice and purchase order.'),
    fields, error, h('div', {class: 'actions'}, submit));
  const dialog = h('dialog', {class: 'auth-dialog', 'aria-labelledby': 'auth-title'},
    h('div', {class: 'dialog-top'}, h('h2', {id: 'auth-title'}, title),
      h('button', {type: 'button', class: 'icon-button', 'aria-label': 'Close', onclick: () => dialog.close()}, '×')), form);
  dialog.addEventListener('close', () => dialog.remove());
  form.onsubmit = async e => {
    e.preventDefault();
    if (submit.disabled) return;
    submit.disabled = true;
    error.textContent = '';
    try {
      const f = new FormData(form);
      if (config.mode === 'dev') {
        const u = config.dev_users[Number(f.get('user'))];
        sessionStorage.setItem(DEV_KEY, JSON.stringify(u));
        dialog.close();
        enter(u);
      } else {
        await loadSupabase();
        const credentials = {email: String(f.get('email')).trim(), password: String(f.get('password'))};
        if (signup) {
          const {data, error: err} = await supabase.auth.signUp({
            ...credentials, options: {emailRedirectTo: new URL('./', location.href).href},
          });
          if (err) {
            if (err.code === 'weak_password') throw Error('Choose a stronger password and try again.');
            if (err.status === 429) throw Error('Too many attempts. Wait a few minutes and try again.');
            throw Error('Could not send a confirmation email. Try again or sign in if you already have an account.');
          }
          if (data.session) {
            await supabase.auth.signOut();
            throw Error('Email verification is temporarily unavailable. Try again later.');
          }
          dialog.close();
          renderArea('If the address is eligible, you’ll receive a confirmation link. Open it to start your workspace.');
          return;
        }
        const {data, error: err} = await supabase.auth.signInWithPassword(credentials);
        if (err) throw Error(err.code === 'email_not_confirmed' ? 'Confirm your email using the link in your inbox first.' : 'Email or password was not accepted.');
        const next = await supabaseUser(data.session).catch(async x => { await supabase.auth.signOut(); throw x; });
        dialog.close();
        enter(next);
      }
    } catch (x) { error.textContent = x.message; } finally { submit.disabled = false; }
  };
  document.body.append(dialog);
  dialog.showModal();
}

async function start() {
  const account = new URLSearchParams(location.search).get('account');
  const wantsAccount = account === 'login' || account === 'signup';
  renderArea(wantsAccount ? 'Loading account access…' : '');
  config = await api.loadConfig();
  if (!config) {
    if (wantsAccount) renderArea('Account access is unavailable right now. You can still use the demo.');
    return;
  }
  renderArea();
  try {
    if (config.mode === 'dev') {
      const saved = JSON.parse(sessionStorage.getItem(DEV_KEY) ?? 'null');
      const u = saved && config.dev_users.find(x => x.token === saved.token);
      if (u) enter(u);
    } else {
      await loadSupabase();
      const {data} = await supabase.auth.getSession();
      if (data.session) enter(await supabaseUser(data.session));
    }
  } catch (e) {
    renderArea(e.message);
    return;
  }
  if (user || !wantsAccount) return;
  if (account === 'signup' && !config.public_signup) {
    renderArea('Sign up is unavailable right now. You can still use the demo or sign in to an existing account.');
    return;
  }
  openAuth(account === 'signup');
}
start();
