'use strict';
// The mock claude.ai of mock_claude_ai.js, served over HTTP on 127.0.0.1, so
// that a real browser can run the export and import scripts against it.
// tests/test_project_move_auto.py starts two of these (one per account) and
// drives a real Chromium through `cswap project-move auto` against them.
//
// Usage: node tests/js/mock_http_server.js [--small] [--signed-out] [--login-as EMAIL] [--stay-open]
// --small gives the mock the small workspace export_to_disk.js uses, so the
// two exports can be compared file by file. --signed-out refuses every API
// call (401) until the browser has visited /login, which signs it in with a
// cookie named as the real site's, the way a person signing in on the real
// site would. --login-as says which account /login signs the browser in as
// (by default the site does not say whose the sign-in is, as a site without
// an account route). --stay-open leaves the window open after /login, for
// the code that closes it itself; otherwise the page closes its own window,
// as the person would.
// Prints "listening <port>" once it is ready. Besides the mock's own routes:
//   GET /__mock/made   what imports created: channels and projects, by name,
//                      and how many times /login was visited
//   GET /login[?as=EMAIL]  signs the browser in (a cookie) and shows a blank page
//   GET /api/auth/current_account  the signed-in account's email, when it has one
//   any other non-API path is a blank page, standing in for the site's pages

const http = require('http');
const { makeServer } = require('./mock_claude_ai');

// The same small workspace as export_to_disk.js.
const SMALL = { roots: 12, replies: [2, 3], hiddenReplies: [1], events: [4, 0, 7] };
const mock = makeServer({}, process.argv.includes('--small') ? SMALL : {});
const signedOut = process.argv.includes('--signed-out');
const loginAs = process.argv[process.argv.indexOf('--login-as') + 1] || '';
const stayOpen = process.argv.includes('--stay-open');
// Named as the real site's session cookie, which project-move auto looks
// for in the profile. Persistent, as that one is: a cookie with no expiry
// would not survive the browser being closed and opened again. Its value
// is the signed-in account's email, or 1 when the site does not say.
const SESSION = 'sessionKey';
let logins = 0;

function session(headers) {
  const m = (headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${SESSION}=([^;]*)`));
  return m ? decodeURIComponent(m[1]) : '';
}

function made() {
  const channels = [...mock.state.channels.values()]
    .filter(c => c.created)
    .map(c => ({
      id: c.record.id,
      name: c.record.name || c.record.topic || '',
      files: c.files ? [...c.files.keys()].sort() : [],
    }));
  const projects = [...mock.state.projects.values()].map(p => ({
    name: (p.project && p.project.name) || '',
  }));
  return { channels, projects, logins };
}

const BLANK = '<!doctype html><html><head><title>mock claude.ai</title></head><body></body></html>';

const server = http.createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const origin = `http://${req.headers.host}`;
    const url = new URL(req.url, origin);

    if (url.pathname === '/__mock/made') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(made()));
      return;
    }

    if (url.pathname === '/login') {
      // Signed in, and then the page closes its own window: what a person
      // does once they have signed in, which is how `project-move auto`
      // learns that the one-time sign-in is over.
      logins++;
      const as = url.searchParams.get('as') || (process.argv.includes('--login-as') && loginAs) || '1';
      const cookie = `${SESSION}=${encodeURIComponent(as)}; Path=/; Max-Age=86400`;
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'set-cookie': cookie });
      res.end(stayOpen ? BLANK : BLANK.replace('</body>', '<script>setTimeout(() => window.close(), 500)</script></body>'));
      return;
    }

    if (!url.pathname.startsWith('/api/') && !url.pathname.startsWith('/v1/')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(BLANK);
      return;
    }

    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = String(v);

    if (signedOut && !session(headers)) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { type: 'authentication_error', message: 'Not signed in' } }));
      return;
    }
    if (url.pathname === '/api/auth/current_account') {
      const who = session(headers);
      if (!who.includes('@')) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { type: 'not_found_error', message: 'Not found' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ account: { uuid: 'acct-' + who, email_address: who } }));
      return;
    }
    const init = { method: req.method, headers };
    if (body.length) {
      const type = headers['content-type'] || '';
      init.body = type.startsWith('multipart/form-data')
        ? await new Request(url, { method: req.method, headers: { 'content-type': type }, body }).formData()
        : body.toString('utf8');
    }

    const reply = await mock.server(url, headers, init);
    const out = Buffer.from(await reply.arrayBuffer());
    const replyHeaders = {};
    reply.headers.forEach((v, k) => {
      if (k !== 'content-length' && k !== 'content-encoding') replyHeaders[k] = v;
    });
    res.writeHead(reply.status, replyHeaders);
    res.end(out);
  } catch (e) {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end(String(e && e.stack || e));
  }
});

server.listen(0, '127.0.0.1', () => {
  console.log(`listening ${server.address().port}`);
});
