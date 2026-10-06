// setup.js: the checklist the side panel shows for what this computer
// still needs, with the command for each missing piece.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..', '..', '..', 'extension', 'src');
const setup = await import(pathToFileURL(path.join(SRC, 'setup.js')).href);
const native = await import(pathToFileURL(path.join(SRC, 'native.js')).href);

const ID = 'abcdefghijklmnopabcdefghijklmnop';
const titles = steps => steps.map(s => `${s.key}:${s.state}`);

test('the register line carries this copy\'s own id, and only a real one', () => {
  assert.equal(setup.registerLine(ID), `cswap bridge install --register --extension-id ${ID}`);
  assert.equal(setup.registerLine(''), 'cswap bridge install --register');
  assert.equal(setup.registerLine('not-an-id'), 'cswap bridge install --register');
  assert.equal(setup.registerLine(undefined), 'cswap bridge install --register');
});

test('without Allow User Scripts nothing else is judged', () => {
  const steps = setup.setupSteps({ bridge: { userScripts: false, userScriptsError: 'turn it on' }, extensionId: ID });
  assert.deepEqual(titles(steps), ['user-scripts:todo', 'cswap:unknown', 'job:unknown']);
  assert.equal(steps[0].detail, 'turn it on');
  assert.match(steps[0].after, /Allow User Scripts/);
  assert.deepEqual(steps[0].commands, []);
  assert.match(setup.setupSummary(steps), /^Next: allow user scripts in chrome\.$/);
});

test('no native host: install cswap, then register the bridge for this id', () => {
  const steps = setup.setupSteps({ bridge: { userScripts: true, connected: false, lastErrorCode: 'no-host', lastError: native.INSTALL_HINT }, extensionId: ID });
  assert.deepEqual(titles(steps), ['user-scripts:ok', 'cswap:todo', 'job:unknown']);
  assert.deepEqual(steps[1].commands, [...setup.INSTALL_LINES, setup.registerLine(ID)]);
  assert.match(steps[1].after, /reload the extension/);
  assert.equal(steps[2].commands[0], setup.QUEUE_LINE);
});

test('a bridge registered for another id needs only the register line', () => {
  const steps = setup.setupSteps({ bridge: { userScripts: true, connected: false, lastErrorCode: 'no-host', lastError: native.FORBIDDEN_HINT }, extensionId: ID });
  assert.equal(steps[1].state, 'todo');
  assert.deepEqual(steps[1].commands, [setup.registerLine(ID)]);
  assert.match(steps[1].title, /Register the bridge/);
});

test('a protocol mismatch says to upgrade cswap, a dropped bridge says to ask it', () => {
  const proto = setup.setupSteps({ bridge: { userScripts: true, connected: false, lastErrorCode: 'protocol', lastError: 'speaks 2' }, extensionId: ID });
  assert.deepEqual(proto[1].commands, [...setup.UPGRADE_LINES]);
  assert.equal(proto[1].detail, 'speaks 2');
  for (const code of ['disconnected', 'timeout']) {
    const dropped = setup.setupSteps({ bridge: { userScripts: true, connected: false, lastErrorCode: code, lastError: 'gone' }, extensionId: ID });
    assert.deepEqual(dropped[1].commands, ['cswap bridge status']);
    assert.equal(dropped[1].state, 'todo');
    // Once the bridge has answered, a dropped port is a reconnect, not a missing piece.
    const seen = setup.setupSteps({ bridge: { userScripts: true, connected: false, lastErrorCode: code, lastError: 'The cswap bridge exited: Native host has exited.', lastHello: { cswap: '0.27.0' } }, extensionId: ID });
    assert.equal(seen[1].state, 'ok');
    assert.match(seen[1].detail, /Last seen: cswap 0\.27\.0 \(The cswap bridge exited/);
    assert.deepEqual(seen[1].commands, []);
  }
});

test('nothing tried yet shows the lines without claiming anything is missing', () => {
  const steps = setup.setupSteps({ bridge: { userScripts: true }, extensionId: ID });
  assert.deepEqual(titles(steps), ['user-scripts:ok', 'cswap:unknown', 'job:unknown']);
  assert.match(steps[1].detail, /Not checked yet/);
  assert.deepEqual(steps[1].commands, [...setup.INSTALL_LINES, setup.registerLine(ID)]);
  assert.match(setup.setupSummary(steps), /not checked yet/);
  const seen = setup.setupSteps({ bridge: { userScripts: true, connected: false, lastHello: { cswap: '0.27.0' } }, extensionId: ID });
  assert.equal(seen[1].state, 'ok');
  assert.match(seen[1].detail, /0\.27\.0/);
});

test('connected and queued: everything is in place', () => {
  const noJob = setup.setupSteps({ bridge: { userScripts: true, connected: true, lastHello: { cswap: '0.27.0' } }, extensionId: ID });
  assert.deepEqual(titles(noJob), ['user-scripts:ok', 'cswap:ok', 'job:todo']);
  assert.deepEqual(noJob[2].commands, [setup.QUEUE_LINE]);
  assert.equal(setup.setupSummary(noJob), 'Next: queue an import from the command line.');
  const all = setup.setupSteps({ bridge: { userScripts: true, connected: true, lastHello: { cswap: '0.27.0' } }, job: { id: 'job_1', phase: 'running' }, extensionId: ID });
  assert.deepEqual(titles(all), ['user-scripts:ok', 'cswap:ok', 'job:ok']);
  assert.equal(setup.setupSummary(all), 'Everything is in place.');
  assert.match(all[2].detail, /job_1 is running/);
});

test('every command is plain text a shell takes as typed', () => {
  for (const bridge of [{ userScripts: true }, { userScripts: true, lastErrorCode: 'no-host' }, { userScripts: true, lastErrorCode: 'protocol' }]) {
    for (const s of setup.setupSteps({ bridge, extensionId: ID })) {
      for (const c of s.commands) assert.match(c, /^[a-zA-Z][a-zA-Z0-9 .\-+:\/]*$/, c);
    }
  }
});

test('the install lines name this repository, which the manifest also names', () => {
  const manifest = JSON.parse(fs.readFileSync(path.resolve(SRC, '..', 'manifest.json'), 'utf8'));
  assert.equal(setup.SOURCE_REPO, manifest.homepage_url, 'one address for the source, in the manifest');
  for (const line of setup.INSTALL_LINES) assert.ok(line.endsWith(`git+${setup.SOURCE_REPO}`), line);
  assert.ok(setup.INSTALL_LINES.every(l => !/^(uv tool|pipx) install claude-swap$/.test(l)), 'never the PyPI claude-swap, which has no bridge');
});
