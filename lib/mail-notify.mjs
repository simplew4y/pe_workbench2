import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import tls from 'node:tls';
import crypto from 'node:crypto';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const describe = value => typeof value === 'string' ? value : Array.isArray(value) ? value.map(describe).join('\n') : value && typeof value === 'object' ? Object.entries(value).map(([k,v]) => `${k}: ${describe(v)}`).join('；') : String(value ?? '');
const clean = s => String(s ?? '').replace(/[\r\n]/g, ' ').trim();
export function renderMail(e) {
  const category = e.type === 'watch' ? '盯盘' : '跟踪';
  const title = e.title || '跟踪运行完成';
  const subject = `【PE Workbench·${category}】${clean(e.target || e.project)} ${clean(e.severity)}：${clean(title)}`;
  const time = new Intl.DateTimeFormat('zh-CN', {timeZone:'Asia/Shanghai', dateStyle:'short', timeStyle:'medium', hour12:false}).format(new Date(e.createdAt || Date.now()));
  const r = e.related || {};
  const sections = [['重点', e.body], ['涉及项', r.affected || e.changes], ['影响', r.impact || r.materialReason], ['建议动作', r.suggestedAction || e.actions], ['来源', e.citations]];
  const text = [`结论：${title}`, ...sections.filter(([,v]) => describe(v)).map(([k,v]) => `${k}\n${describe(v)}`), `项目：${e.project || ''} · 标的：${e.target || ''} · ${e.severity || ''}`, `${time}（北京时间） · 消息 ${e.id}`].join('\n\n');
  const block = (k,v) => `<div style="padding:12px;margin-top:12px;${k === '建议动作' ? 'background:#eff6ff;border-left:4px solid #2563eb' : ''}"><b style="background:#fef3c7">${k}</b><div style="white-space:pre-wrap">${esc(describe(v)).replace(/已触发|triggered/g, word => `<span style="color:#b91c1c;font-weight:700">${word}</span>`)}</div></div>`;
  const links = (e.citations || []).filter(c => /^https?:\/\//i.test(c.url || '')).map(c => `<li><a href="${esc(c.url)}">${esc(c.title || c.url)}</a></li>`).join('');
  const html = `<div style="font-family:Arial,'Microsoft YaHei',sans-serif;max-width:640px;margin:auto;color:#1f2937;line-height:1.6"><div style="background:${/warning|action|failed|needs_review/.test(e.severity) ? '#b45309' : '#2563eb'};color:white;padding:18px;border-radius:8px 8px 0 0"><div>PE Workbench · ${category} · ${esc(e.target || e.project)}</div><div style="font-size:20px;font-weight:700">${esc(title)}</div></div><div style="border:1px solid #e5e7eb;padding:18px"><table style="width:100%;text-align:center;background:#f3f4f6"><tr><td>状态<br><b style="color:#b91c1c">${esc(e.severity)}</b></td><td>置信度<br><b>${esc(r.confidence || '—')}</b></td><td>涉及项<br><b>${esc(Array.isArray(r.affected || e.changes) ? (r.affected || e.changes).length : '—')}</b></td></tr></table>${sections.filter(([,v]) => describe(v)).map(([k,v]) => block(k,v)).join('')}${links ? `<ul>${links}</ul>` : ''}<div style="font-size:12px;color:#6b7280;margin-top:16px">项目：${esc(e.project)} · 标的：${esc(e.target)}<br>${esc(time)}（北京时间） · 消息 ${esc(e.id)}</div></div></div>`;
  return {subject, text, html};
}

// Parse complete multiline SMTP replies; never include replies in errors (may contain identities).
function channel(socket) {
  let buffer = '', lines = [], replies = [], pending;
  const data = chunk => { buffer += chunk.toString(); let at; while ((at = buffer.indexOf('\r\n')) >= 0) { const line = buffer.slice(0, at); buffer = buffer.slice(at + 2); lines.push(line); if (/^\d{3} /.test(line)) { const reply = {code:Number(line.slice(0,3)), lines}; lines = []; if (pending) { const p = pending; pending = null; p.resolve(reply); } else replies.push(reply); } } };
  let failure;
  const fail = () => { failure = Error('SMTP connection closed'); if (pending) { pending.reject(failure); pending = null; } };
  socket.on('data', data); socket.on('error', fail); socket.on('close', fail);
  socket.setTimeout(20000, () => socket.destroy(Error('SMTP timeout')));
  return { read: () => failure ? Promise.reject(failure) : replies.length ? Promise.resolve(replies.shift()) : new Promise((resolve,reject) => {pending={resolve,reject};}), detach: () => {socket.off('data',data);socket.off('error',fail);socket.off('close',fail);} };
}
function address(value) {
  const s = clean(value);
  const match = s.match(/<([^<>]+)>$/);
  const a = match ? match[1] : s;
  if (/[\r\n<>\s]/.test(a) || !/^[^@]+@[^@]+$/.test(a) || /[\r\n]/.test(String(value))) throw Error('Invalid mail identity');
  return a;
}
export async function smtpTransport(mail, config, { connect = net.connect, secureConnect = tls.connect } = {}) {
  const from = address(config.sender), to = mail.to.map(address);
  let socket = Number(config.port) === 465 ? secureConnect({host:config.host, port:465, servername:config.host, rejectUnauthorized:true}) : connect({host:config.host, port:Number(config.port) || 587});
  let io = channel(socket);
  const expect = async codes => { const r = await io.read(); if (!codes.includes(r.code)) throw Error(`SMTP status ${r.code}`); return r; };
  const command = async (s, codes) => {socket.write(s + '\r\n');return expect(codes);};
  try {
    await expect([220]);
    let hello = await command('EHLO pe-workbench', [250]);
    if (!socket.encrypted) {
      if (!hello.lines.some(l => /STARTTLS/i.test(l))) throw Error('SMTP requires STARTTLS');
      await command('STARTTLS', [220]); io.detach();
      socket = secureConnect({socket, servername:config.host, rejectUnauthorized:true}); io = channel(socket);
      await new Promise((resolve,reject) => {socket.once('secureConnect',resolve);socket.once('error',reject);});
      hello = await command('EHLO pe-workbench', [250]);
    }
    if (!socket.authorized) throw Error('SMTP TLS verification failed');
    await command('AUTH LOGIN', [334]);
    await command(Buffer.from(config.username || from).toString('base64'), [334]);
    await command(Buffer.from(config.password).toString('base64'), [235]);
    await command(`MAIL FROM:<${from}>`, [250]);
    for (const recipient of to) await command(`RCPT TO:<${recipient}>`, [250,251]);
    await command('DATA', [354]);
    const boundary = `pe-${crypto.randomUUID()}`;
    const b64 = s => Buffer.from(s).toString('base64').match(/.{1,76}/g)?.join('\r\n') || '';
    const mime = [`From: <${from}>`, `To: ${to.map(a=>`<${a}>`).join(', ')}`, `Subject: =?UTF-8?B?${Buffer.from(mail.subject).toString('base64')}?=`, `Date: ${new Date().toUTCString()}`, `Message-ID: <${crypto.createHash('sha256').update(mail.key).digest('hex')}@pe-workbench>`, 'MIME-Version: 1.0', `Content-Type: multipart/alternative; boundary="${boundary}"`, '', ...[['plain',mail.text],['html',mail.html]].flatMap(([type,body]) => [`--${boundary}`, `Content-Type: text/${type}; charset=UTF-8`, 'Content-Transfer-Encoding: base64', '', b64(body)]), `--${boundary}--`, ''].join('\r\n');
    socket.write(mime.replace(/^\./gm, '..') + '\r\n.\r\n');
    await expect([250]);
    // Acceptance after DATA is the delivery boundary; QUIT errors must not resend.
    socket.write('QUIT\r\n');
  } finally {socket.destroy();}
}

export function createMailNotifier({env = process.env, stateDir, transport = smtpTransport, logger = console} = {}) {
  const active = new Map();
  async function sendOnce(event) {
    let config;
    try {
      if (!env.PE_MAIL_CONFIG || !env.PE_MAIL_SECRET) return 'skipped';
      config = JSON.parse(await fs.readFile(env.PE_MAIL_CONFIG, 'utf8'));
      const secret = JSON.parse(await fs.readFile(env.PE_MAIL_SECRET, 'utf8'));
      if (!Array.isArray(config.watch_recipients) || !config.watch_recipients.length || !secret.password || !config.host || !config.sender) return 'skipped';
      config = {...config, password:secret.password};
    } catch {return 'skipped';}
    const key = `${event.type}:${event.id}`;
    const file = path.join(stateDir, 'mail-notify', crypto.createHash('sha256').update(key).digest('hex') + '.json');
    try {
      await fs.mkdir(path.dirname(file), {recursive:true, mode:0o700});
      try {if (JSON.parse(await fs.readFile(file,'utf8')).sent) return 'duplicate';} catch (e) {if (e.code !== 'ENOENT') throw e;}
      await fs.writeFile(file, JSON.stringify({event, sent:false}), {mode:0o600});
      await transport({...renderMail(event), to:config.watch_recipients, key}, config);
      await fs.writeFile(file, JSON.stringify({sent:true}), {mode:0o600});
      return 'sent';
    } catch {logger.warn?.(`[mail] delivery failed (${event.type}/${event.id}); pending retry`);return 'failed';}
  }
  function send(event) {
    const key = `${event.type}:${event.id}`;
    if (active.has(key)) return active.get(key);
    const task = sendOnce(event).finally(() => active.delete(key)); active.set(key,task);return task;
  }
  async function retry() {
    const dir = path.join(stateDir,'mail-notify');
    try {for (const name of await fs.readdir(dir)) { try {const row = JSON.parse(await fs.readFile(path.join(dir,name),'utf8')); if (!row.sent && row.event) await send(row.event);} catch { /* next retry */ } }} catch { /* no queue yet */ }
  }
  return {send, retry};
}
const notifiers = new Map();
export function startMailNotifier(stateDir) {
  if (!process.env.PE_MAIL_CONFIG || !process.env.PE_MAIL_SECRET) return;
  getNotifier(stateDir);
}
function getNotifier(stateDir) {
  try {
    if (!notifiers.has(stateDir)) {
      const notifier = createMailNotifier({stateDir}); notifiers.set(stateDir,notifier);
      const timer = setInterval(() => {void notifier.retry();}, 60000); timer.unref();
      void notifier.retry();
    }
    return notifiers.get(stateDir);
  } catch {console.warn('[mail] enqueue failed');}
}
export function enqueueMail(event, stateDir) {
  try { void getNotifier(stateDir)?.send(event); }
  catch { console.warn('[mail] enqueue failed'); }
}
