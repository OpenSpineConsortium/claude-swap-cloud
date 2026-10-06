// The three moments the store screenshots show, as the side panel's own
// storage state. The panel renders them with its real code; only
// chrome.storage.local and the port are stand-ins (build_assets.mjs). The
// texts of an interruption come from interrupt.js's describe(), so a changed
// wording there shows up in the next build of the images.
//
// Times are offsets from the moment the page is drawn, so a countdown reads
// the same on every build. The account and the project are made up.

import { describe } from '../../src/interrupt.js';
import { DEFAULTS } from '../../src/config.js';

const EXTENSION_ID = 'jhplijnbeejmlgmephlhckpggocpmefp';
const ACCOUNT = { slot: 3, email: 'you@example.com', org: 'org_example' };
const EXPORT = { name: 'Thesis notes', kind: 'folder', files: 41, conversations: 12, path: 'Thesis notes' };
const BRIDGE = {
  connected: true,
  userScripts: true,
  extensionVersion: '0.2.0',
  chromeVersion: '141.0.7390.54',
  lastHello: { cswap: '0.27.0', protocol: 1, backup_dir: '~/.claude-swap-backup' },
};

function counters(over = {}) {
  return { requests: 0, ok: 0, slowDowns: 0, serverErrors: 0, networkErrors: 0, interruptions: 0, held: 0, probes: 2, waitedMs: 0, ...over };
}

// One log record per line; `at` is seconds before the drawing.
function log(lines) {
  return { records: lines.map(([at, level, event, msg]) => ({ at, level, event, msg, data: {} })) };
}

const challenge = describe('challenge', { status: 403 });

export const SCENES = {
  importing: {
    headline: 'Moves a claude.ai Project between your accounts.',
    line: 'cswap exports it from one account; this extension imports it into the other, in the tab you are signed in to.',
    terminal: [
      '$ cswap project-move import --to 3',
      'Chrome picked the job up (extension 0.2.0, Chrome 141.0.7390.54).',
      'Checking the claude.ai tab and who is signed in...',
      'Loading the export and the import script into the tab...',
      'Importing...',
      '  Adding file 18 of 41: chapter-3-methods.md',
    ],
    state: {
      job: { id: 'job_example', phase: 'running', export: EXPORT, account: ACCOUNT, lastStatusText: 'Adding file 18 of 41: chapter-3-methods.md' },
      gate: { phase: 'waiting', wait: { reason: 'spacing', since: -100, until: 400 }, counters: counters({ requests: 57, ok: 57, waitedMs: 28000 }) },
      bridge: BRIDGE,
      log: log([
        [64, 'info', 'job', 'claimed by this browser profile'],
        [63, 'info', 'identity', 'signed in as the destination account'],
        [61, 'info', 'phase', 'running'],
        [1, 'info', 'script', 'Adding file 18 of 41: chapter-3-methods.md'],
      ]),
    },
  },
  stopped: {
    headline: 'Stops and tells you. Never retries on its own.',
    line: 'One request at a time, a fixed spacing, every wait shown. A check or a sign-out holds the import until you press Resume.',
    terminal: [
      '$ cswap project-move import --to 3',
      'Importing...',
      '  Adding file 23 of 41: figures/table-2.csv',
      'Stopped: ' + challenge.what,
      '  ' + challenge.todo,
    ],
    state: {
      job: { id: 'job_example', phase: 'held', heldReason: 'interrupted', export: EXPORT, account: ACCOUNT, lastStatusText: 'Adding file 23 of 41: figures/table-2.csv' },
      gate: { phase: 'held', wait: { reason: 'paused', since: -5000, until: null }, pausedBy: 'interrupt', counters: counters({ requests: 66, ok: 65, interruptions: 1, waitedMs: 33000 }) },
      interrupt: { current: { kind: 'challenge', what: challenge.what, todo: challenge.todo, evidence: { status: 403, headers: { 'cf-mitigated': 'challenge' }, path: '/api/organizations/{org}/projects/{project}/docs' } } },
      bridge: BRIDGE,
      log: log([
        [70, 'info', 'phase', 'running'],
        [6, 'info', 'script', 'Adding file 23 of 41: figures/table-2.csv'],
        [5, 'warn', 'interrupt', 'challenge: the import is held until you press Resume'],
      ]),
    },
  },
  done: {
    headline: 'Nothing to paste. Nothing leaves your computer but the project.',
    line: 'The export stays on disk and is read file by file. No cookies, no tokens, no analytics; the log keeps no request bodies.',
    terminal: [
      '$ cswap project-move import --to 3',
      'Importing...',
      'Created "Thesis notes": https://claude.ai/project/0198f2c4-example',
      '  Import finished.',
      'The new project is at https://claude.ai/project/0198f2c4-example',
    ],
    state: {
      job: {
        id: 'job_example', phase: 'done', export: EXPORT, account: ACCOUNT, lastStatusText: 'Import finished.',
        created_project: { url: 'https://claude.ai/project/0198f2c4-example' },
        result: { counts: { added: 41, moved: 12, leftOut: 0, notAdded: 0, notSet: 0, toCheck: 0 } },
      },
      gate: { phase: 'idle', counters: counters({ requests: 112, ok: 112, waitedMs: 61000 }) },
      bridge: BRIDGE,
      log: log([
        [3, 'info', 'phase', 'done'],
        [3, 'info', 'result', '41 added, 12 moved, 0 left out'],
      ]),
    },
  },
};

export { EXTENSION_ID };

// The storage the panel reads, with the offsets turned into times. Runs in
// the browser (it is handed over as source), so it uses nothing from here.
export function storageFor(scene, nowMs, keys, config) {
  const at = ms => (ms == null ? null : nowMs + ms);
  const s = JSON.parse(JSON.stringify(scene.state));
  if (s.gate && s.gate.wait) { s.gate.wait.since = at(s.gate.wait.since); s.gate.wait.until = at(s.gate.wait.until); }
  if (s.log) {
    for (const r of s.log.records) { r.ts = new Date(nowMs - r.at * 1000).toISOString(); delete r.at; }
  }
  const out = {};
  for (const [name, key] of Object.entries(keys)) if (s[name] !== undefined) out[key] = s[name];
  out[keys.config] = config;
  out[keys.instance] = { id: 'inst_example' };
  return out;
}

export const CONFIG = { ...DEFAULTS };
