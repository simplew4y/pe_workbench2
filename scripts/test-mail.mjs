import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createMailNotifier, renderMail } from '../lib/mail-notify.mjs';
const event = { id: 'one', type: 'watch', project: '项目甲', target: '标的甲', title: '利润率下降，需复核', body: '关键内容', severity: 'warning', related: { affected: ['F2'], impact: '估值承压', suggestedAction: '核对财报' }, createdAt: '2026-11-03T01:00:00Z' };
async function fixture(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pe-mail-'));
  const env = { PE_MAIL_CONFIG: path.join(dir, 'mail.json'), PE_MAIL_SECRET: path.join(dir, 'secret.json') };
  // Ephemeral transport-only identities; no deployment addresses or credentials.
  const identity = () => `${crypto.randomUUID()}@${crypto.randomUUID()}.invalid`;
  const config = { host: 'localhost', port: 587, sender: identity(), recipients: [identity()], watch_recipients: [identity()] };
  try { await fn({ dir, env, config }); } finally { await rm(dir, { recursive: true, force: true }); }
}
test('missing config, secret, or dedicated recipients silently skips', () => fixture(async ({dir, env, config}) => {
  const n = createMailNotifier({ env, stateDir: dir, transport: async () => assert.fail('must skip') });
  assert.equal(await n.send(event), 'skipped');
  await writeFile(env.PE_MAIL_CONFIG, JSON.stringify(config));
  assert.equal(await n.send(event), 'skipped');
  await writeFile(env.PE_MAIL_SECRET, JSON.stringify({password: crypto.randomUUID()}));
  delete config.watch_recipients;
  await writeFile(env.PE_MAIL_CONFIG, JSON.stringify(config));
  assert.equal(await n.send(event), 'skipped');
}));
test('dedicated recipients, concurrent and durable message-id deduplication', () => fixture(async ({dir, env, config}) => {
  await writeFile(env.PE_MAIL_CONFIG, JSON.stringify(config));
  await writeFile(env.PE_MAIL_SECRET, JSON.stringify({password: crypto.randomUUID()}));
  const delivered = [];
  const options = { env, stateDir: dir, transport: async (mail) => delivered.push(mail) };
  const n = createMailNotifier(options);
  await Promise.all([n.send(event), n.send(event)]);
  await createMailNotifier(options).send(event);
  assert.equal(delivered.length, 1);
  assert.deepEqual(delivered[0].to, config.watch_recipients);
  assert.ok(!delivered[0].to.includes(config.recipients[0]));
}));
test('card includes conclusion, key points, action, escaped text, Beijing time', () => {
  const mail = renderMail({...event, body: '<script>关键内容</script>'});
  for (const value of [event.title, '重点', 'F2', '估值承压', '核对财报', '09:00', '北京时间']) assert.ok(mail.html.includes(value), value);
  assert.ok(!mail.html.includes('<script>'));
  assert.ok(mail.text.includes(event.title));
});
test('failed delivery can retry without marking sent', () => fixture(async ({dir, env, config}) => {
  await writeFile(env.PE_MAIL_CONFIG, JSON.stringify(config));
  await writeFile(env.PE_MAIL_SECRET, JSON.stringify({password: crypto.randomUUID()}));
  let attempts = 0;
  const n = createMailNotifier({ env, stateDir: dir, logger: {warn(){}}, transport: async () => { if (++attempts === 1) throw Error('offline'); } });
  assert.equal(await n.send(event), 'failed');
  assert.equal(await n.send(event), 'sent');
  assert.equal(await n.send(event), 'duplicate');
  assert.equal(attempts, 2);
}));

test('SMTP refuses plaintext authentication when STARTTLS is unavailable', async () => {
  const { smtpTransport } = await import('../lib/mail-notify.mjs');
  const { EventEmitter } = await import('node:events');
  const commands = [];
  const socket = new EventEmitter();
  socket.setTimeout = () => {};
  socket.destroy = () => {};
  socket.write = command => {
    commands.push(command);
    queueMicrotask(() => socket.emit('data', Buffer.from('250 local hello\r\n')));
  };
  const connect = () => {
    queueMicrotask(() => socket.emit('data', Buffer.from('220 local ready\r\n')));
    return socket;
  };
  const identity = `${crypto.randomUUID()}@${crypto.randomUUID()}.invalid`;
  await assert.rejects(smtpTransport({ ...renderMail(event), key:'test', to:[identity] }, {
    host:'localhost', port:587, sender:identity, password:crypto.randomUUID(),
  }, {connect}), /requires STARTTLS/);
  assert.ok(commands.every(command => !command.includes('AUTH')));
});

test('STARTTLS certificate rejection never sends credentials', async () => {
  const { smtpTransport } = await import('../lib/mail-notify.mjs');
  const { EventEmitter } = await import('node:events');
  const commands = [];
  const makeSocket = () => Object.assign(new EventEmitter(), { setTimeout() {}, destroy() {} });
  const plain = makeSocket();
  plain.write = command => {
    commands.push(command);
    queueMicrotask(() => plain.emit('data', Buffer.from(command.startsWith('STARTTLS') ? '220 upgrade\r\n' : '250-local\r\n250 STARTTLS\r\n')));
  };
  const connect = () => { queueMicrotask(() => plain.emit('data', Buffer.from('220 ready\r\n'))); return plain; };
  const secureConnect = options => {
    assert.equal(options.rejectUnauthorized, true);
    const secure = makeSocket();
    secure.write = command => commands.push(command);
    queueMicrotask(() => secure.emit('error', Error('certificate rejected')));
    return secure;
  };
  const identity = `${crypto.randomUUID()}@${crypto.randomUUID()}.invalid`;
  await assert.rejects(smtpTransport({...renderMail(event), key:'tls', to:[identity]}, {
    host:'localhost', port:587, sender:identity, password:crypto.randomUUID(),
  }, {connect, secureConnect}), /certificate rejected/);
  assert.ok(commands.every(command => !command.includes('AUTH')));
});
