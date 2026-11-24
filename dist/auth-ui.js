// The account gateway opens a private workspace after authentication.
// The browser holds only the Supabase anon key (public by design) and the user's own session token.
import {createApiClient} from './api-client.js';
import {createWorkspace} from './workspace-ui.js';
import {fill, h} from './investigation-ui.js';

const SUPABASE_ESM = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.119.0/+esm'; // pinned, like PDF.js in extraction.js
const DEV_KEY = 'rekono-dev-session';
const area = document.querySelector('#auth-area');
const gateway = document.querySelector('#account-gateway');
const workspace = document.querySelector('#workspace');
const nav = document.querySelector('#workspace-nav');
const breadcrumb = document.querySelector('#workspace-breadcrumb');
let config = null, supabase = null, user = null, app = null;

const api = createApiClient({
  getToken: async () => (config?.mode === 'supabase' ? (await supabase?.auth.getSession())?.data.session?.access_token : user?.token) ?? null,
  onUnauthenticated: () => { if (user) signOut('Your session has ended. Sign in again.'); },
});

function renderArea(message = '') {
  const note = h('span', {class: 'auth-label', role: 'status'}, message);
  if (user) {
    fill(area, h('span', {class: 'auth-label'}, user.label), h('span', {class: 'demo-badge'}, 'Reviewer'),
      h('button', {type: 'button', class: 'button secondary', onclick: () => signOut()}, 'Sign out'), note);
  } else {
    fill(area, config && h('button', {type: 'button', class: 'button secondary', onclick: () => openAuth()}, 'Sign in'),
      config?.public_signup && h('button', {type: 'button', class: 'button primary', onclick: () => openAuth(true)}, 'Sign up'), note);
  }
}

function enter(next, restoreSection = false) {
  user = next;
  document.body.classList.add('server-mode');
  gateway.hidden = true;
  workspace.hidden = false;
  app?.stop();
  const workspaceApi = createApiClient({
    getToken: async () => {
      if (user !== next) throw Error('This workspace session has ended.');
      const session = config.mode === 'supabase' ? (await supabase.auth.getSession()).data.session : null;
      if (user !== next || (session && session.user.id !== next.id)) throw Error('This workspace session has ended.');
      return session?.access_token ?? next.token;
    },
    onUnauthenticated: () => { if (user === next) signOut('Your session has ended. Sign in again.'); },
  });
  app = createWorkspace({api: workspaceApi, root: workspace, nav, breadcrumb, restoreSection});
  renderArea('Signed in to your workspace.');
}

async function signOut(message = 'Signed out.') {
  app?.stop();
  app = null;
  user = null;
  sessionStorage.removeItem(DEV_KEY);
  document.body.classList.remove('server-mode');
  workspace.hidden = true;
  gateway.hidden = false;
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

async function supabaseUser(session) {
  if (config.public_signup) {
    // Server verifies the email and checks or provisions the membership atomically.
    await api.send('POST', '/api/workspace');
  } else {
    // Existing reviewers can still sign in when signup is disabled.
    await api.get('/api/invoices');
  }
  return {id: session.user.id, label: session.user.email ?? 'Signed in'};
}

function openAuth(signup = false) {
  const title = signup ? 'Create your Sorikano account' : 'Sign in';
  const error = h('p', {class: 'ocr-error', role: 'alert'});
  const submit = h('button', {type: 'submit', class: 'button primary'}, signup ? 'Create account' : 'Sign in');
  const fields = config.mode === 'dev'
    ? [h('p', {}, 'Use the local test reviewer to open the sample workspace.')]
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
      if (config.mode === 'dev') {
        const [u] = config.dev_users;
        sessionStorage.setItem(DEV_KEY, JSON.stringify(u));
        dialog.close();
        enter(u);
      } else {
        await loadSupabase();
        const f = new FormData(form);
        const credentials = {email: String(f.get('email')).trim(), password: String(f.get('password'))};
        if (signup) {
          const {data, error: err} = await supabase.auth.signUp({
            ...credentials, options: {emailRedirectTo: new URL('demo.html', location.href).href},
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
    renderArea('Workspace sign-in is unavailable right now.');
    return;
  }
  renderArea();
  try {
    if (config.mode === 'dev') {
      const saved = JSON.parse(sessionStorage.getItem(DEV_KEY) ?? 'null');
      const u = saved && config.dev_users.find(x => x.token === saved.token);
      if (u) enter(u, true);
    } else {
      await loadSupabase();
      const {data} = await supabase.auth.getSession();
      if (data.session) enter(await supabaseUser(data.session), true);
    }
  } catch (e) {
    renderArea(e.message);
    return;
  }
  if (user || !wantsAccount) return;
  if (account === 'signup' && !config.public_signup) {
    renderArea('Sign up is unavailable right now. You can sign in to an existing account.');
    return;
  }
  openAuth(account === 'signup');
}
start();
