'use strict';
// The mock claude.ai of mock_claude_ai.js, served over HTTP on 127.0.0.1, so
// that a real browser can run the export and import scripts against it.
// tests/test_project_move_auto.py starts two of these (one per account) and
// drives a real Chromium through `cswap project-move auto` against them.
//
// Usage: node tests/js/mock_http_server.js [--small]
// --small gives the mock the small workspace export_to_disk.js uses, so the
// two exports can be compared file by file.
// Prints "listening <port>" once it is ready. Besides the mock's own routes:
//   GET /__mock/made   what imports created: channels and projects, by name
//   any other non-API path is a blank page, standing in for the site's pages

const http = require('http');
const { makeServer } = require('./mock_claude_ai');

// The same small workspace as export_to_disk.js.
const SMALL = { roots: 12, replies: [2, 3], hiddenReplies: [1], events: [4, 0, 7] };
const mock = makeServer({}, process.argv.includes('--small') ? SMALL : {});

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
  return { channels, projects };
}

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

    if (!url.pathname.startsWith('/api/') && !url.pathname.startsWith('/v1/')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><html><head><title>mock claude.ai</title></head><body></body></html>');
      return;
    }

    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = String(v);
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
