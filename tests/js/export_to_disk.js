'use strict';
// Runs the project export script against the mock claude.ai and writes what
// it exported to a real folder: one Claude Code project and one regular
// project. tests/test_project_move_scripts.py then has the Python side of
// `cswap project-move check` read that folder, so that the two languages are
// held to the same idea of what an export looks like on disk.
// Usage: node tests/js/export_to_disk.js OUTDIR

const fs = require('fs');
const path = require('path');
const { run } = require('./harness');
const { makeServer, CHANNEL } = require('./mock_claude_ai');

const SCRIPT = path.join(__dirname, '..', '..', 'src', 'claude_swap', 'browser', 'project-export.js');
const TABS = [`/code/project/${CHANNEL}`, '/project/aaaaaaaa-0000-4000-8000-000000000001'];

// A small workspace: the checks are about files and names, not volume.
const SIZES = { roots: 12, replies: [2, 3], hiddenReplies: [1], events: [4, 0, 7] };

(async () => {
  const out = process.argv[2];
  if (!out) throw new Error('usage: node export_to_disk.js OUTDIR');

  const summary = [];
  for (const pathname of TABS) {
    const r = await run({ script: SCRIPT, pathname, server: makeServer({}, SIZES).server });
    if (r.loadError) throw r.loadError;
    if (!/^Done/.test(r.statusText)) throw new Error(`the export did not finish: ${r.statusText}`);

    // export.json goes last, as the script itself writes it: its presence
    // is what tells a reader that the rest is there.
    const names = Object.keys(r.bytes).sort((a, b) => a.endsWith('/export.json') - b.endsWith('/export.json'));
    for (const name of names) {
      const target = path.join(out, ...name.split('/'));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, r.bytes[name]);
    }

    const folder = names[0].split('/')[0];
    const manifest = JSON.parse(r.files[`${folder}/export.json`]);
    // A regular project's memory is one saved file with a path; a Claude
    // Code project's is a record of its store, its files among the files.
    const memoryFile = typeof manifest.memory?.path === 'string' ? [manifest.memory] : [];
    summary.push({
      folder,
      name: manifest.name,
      kind: manifest.kind,
      files: manifest.files.length,
      conversations: manifest.history.length + memoryFile.length,
      bytes: [...manifest.files, ...manifest.history, ...memoryFile]
        .reduce((n, row) => n + r.bytes[`${folder}/${row.path}`].length, 0),
      written: names.length,
    });
  }
  console.log(JSON.stringify(summary));
})().catch(e => {
  console.error(e);
  process.exit(1);
});
