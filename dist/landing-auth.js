// Email confirmation links already use the site root. Pass auth callbacks to the workspace.
const authQuery = new URLSearchParams(location.search);
const authFragment = new URLSearchParams(location.hash.slice(1));
if (authQuery.has('code') || authQuery.has('error_code') ||
    authFragment.has('access_token') || authFragment.has('error_code')) {
  const workspace = new URL('demo.html', location.href);
  workspace.search = location.search;
  workspace.hash = location.hash;
  location.replace(workspace);
}
