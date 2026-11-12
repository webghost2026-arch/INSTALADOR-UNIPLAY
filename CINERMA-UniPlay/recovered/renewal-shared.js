'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const PLANS = Object.freeze({
  1: { credits: 1, label: /^1 m[eê]s\s*-\s*1 Cr[eé]dito$/i },
  3: { credits: 3, label: /^3 meses\s*-\s*3 Cr[eé]ditos$/i },
  6: { credits: 5, label: /^6 meses\s*-\s*5 Cr[eé]ditos\s*\(Promo[cç][aã]o\)$/i },
  12: { credits: 10, label: /^12 meses\s*-\s*10 Cr[eé]ditos\s*\(Promo[cç][aã]o\)$/i }
});
function expiry(value) {
  const match = String(value).match(/\b(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2}):(\d{2})\b/);
  if (!match) throw Error('Vencimento não reconhecido.');
  const [, day, month, year, hour, minute, second] = match;
  const timestamp = Date.UTC(+year, +month - 1, +day, +hour, +minute, +second);
  const date = new Date(timestamp);
  if (date.getUTCFullYear() !== +year || date.getUTCMonth() !== +month - 1 || date.getUTCDate() !== +day || +hour > 23 || +minute > 59 || +second > 59) throw Error('Data de vencimento inválida.');
  return { br: match[0], sql: `${year}-${month}-${day} ${hour}:${minute}:${second}`, timestamp };
}
function validAdvance(before, after, months, now = Date.now()) {
  const base = Math.max(before.timestamp, now);
  const days = (after.timestamp - base) / 86400000;
  return days >= months * 28 - 1 && days <= months * 32 + 1;
}
function validate(input) {
  if (!input || !/^[a-zA-Z0-9:_-]{1,160}$/.test(input.id || '') || input.mode !== 'iptv'
    || !/^[a-zA-Z0-9_.@-]{1,128}$/.test(input.username || '') || !PLANS[input.months]
    || input.confirmed !== true || typeof input.panelUsername !== 'string' || !input.panelUsername.trim()) throw Error('Pedido de renovação inválido ou não confirmado.');
  return PLANS[input.months];
}
async function visible(locator) {
  const found = [];
  for (let index = 0; index < await locator.count(); index++) if (await locator.nth(index).isVisible()) found.push(locator.nth(index));
  if (found.length !== 1) throw Error('O painel não apresentou um único controle esperado.');
  return found[0];
}
class Renewal {
  constructor(worker, options = {}) {
    this.worker = worker;
    this.origin = options.origin || 'https://searchdefense.top';
    this.journal = options.journal || path.resolve(__dirname, '../.runtime/renewals');
    this.now = options.now || Date.now;
  }
  async save(file, value) {
    const temp = file + '.tmp';
    await fs.writeFile(temp, JSON.stringify(value), { mode: 0o600 }); await fs.rename(temp, file);
  }
  async pendingResult() {
    await fs.mkdir(this.journal,{recursive:true});
    for(const name of await fs.readdir(this.journal)) {
      if(!/^[a-f0-9]{64}\.json$/.test(name))continue;
      const entry=JSON.parse(await fs.readFile(path.join(this.journal,name),'utf8'));
      if(entry.acknowledged)continue;
      if(entry.result)return entry.result;
      if(entry.state==='submitting')return {id:entry.id,ok:false,state:'review_required',message:'O aplicativo reiniciou durante a renovação. Confira o vencimento; não repetir.'};
    }
    return null;
  }
  async acknowledge(id) {
    const file=path.join(this.journal,crypto.createHash('sha256').update(id).digest('hex')+'.json');
    const entry=JSON.parse(await fs.readFile(file,'utf8'));entry.acknowledged=true;await this.save(file,entry);
  }
  async row(frame, username) {
    const search = frame.locator('#iptv-search');
    await search.fill(username); await search.press('Enter');
    const exact = frame.locator('tbody tr').filter({ has: frame.locator('td:first-child').getByText(username, { exact: true }) });
    await exact.first().waitFor({ state: 'visible', timeout: 15000 });
    // Debounced searches can briefly leave stale rows visible.
    await new Promise(resolve => setTimeout(resolve, 700));
    if (await exact.count() !== 1) throw Error('Usuário não encontrado de forma única.');
    const row = exact.first();
    if ((await row.locator('td').first().innerText()).trim() !== username) throw Error('Usuário da linha não corresponde ao pedido.');
    return { row, expiration: await this.readExpiration(row, username) };
  }
  async readExpiration(row, username) {
    // The UI column order changes. Use the fresh provider response captured
    // by this same executor, and match the exact account already seen in the row.
    if(this.worker.snapshots){
      for(let attempt=0;attempt<25;attempt++){
        const snapshot=this.worker.snapshots.entries.get('users-iptv');
        if(snapshot && snapshot.at>=this.snapshotSince && Array.isArray(snapshot.data)){
          const matches=snapshot.data.filter(item=>String(item.username)===username);
          if(matches.length!==1)throw Error('Conta sem vencimento unico na resposta do painel.');
          return expiry(matches[0].exp_date);
        }
        await new Promise(resolve=>setTimeout(resolve,200));
      }
      throw Error('Resposta atualizada de vencimento indisponivel.');
    }
    return expiry(await row.locator('td').nth(5).innerText());
  }
  async execute(input) {
    const plan = validate(input);
    await fs.mkdir(this.journal, { recursive: true });
    const file = path.join(this.journal, crypto.createHash('sha256').update(input.id).digest('hex') + '.json');
    const signature = JSON.stringify({ username: input.username, months: input.months, mode: input.mode, panelUsername: input.panelUsername.toLowerCase() });
    let existing;
    try { existing = JSON.parse(await fs.readFile(file, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (existing) {
      if (existing.signature !== signature) throw Error('Identificador já usado para outra operação.');
      return existing.result || { id: input.id, ok: false, state: 'review_required', message: 'Operação anterior precisa de conferência. Não será repetida.' };
    }
    const state = { signature, id: input.id, state: 'received' };
    await fs.writeFile(file, JSON.stringify(state), { mode: 0o600, flag: 'wx' });
    let submitted = false;
    const page = this.worker.page;
    try {
      if (!page || this.worker.mode !== 'background' || this.worker.paused) throw Error('Inicie o navegador conectado em segundo plano antes de renovar.');
      await page.goto(this.origin + '/#/dashboard', { waitUntil: 'domcontentloaded' });
      const identity = new RegExp('^ID\\s*:\\s*\\d+\\s*-\\s*' + input.panelUsername.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i');
      // The responsive header keeps the account label hidden at some viewport sizes.
      // Read its identity without clicking it; all matching labels must name the same account ID.
      const accountLabels=page.getByText(identity);
      await accountLabels.first().waitFor({ state: 'attached', timeout: 15000 });
      const accountIds=(await accountLabels.allTextContents()).map(text=>text.match(/ID\s*:\s*(\d+)/i)?.[1]);
      if(!accountIds.length||accountIds.some(id=>!id)||new Set(accountIds).size!==1)throw Error('Não foi possível confirmar a conta do painel UniPlay.');
      this.snapshotSince=Date.now();
      await page.goto(this.origin + '/#/users-iptv', { waitUntil: 'domcontentloaded' });
      if (new URL(page.url()).origin !== this.origin) throw Error('Destino do painel inesperado.');
      let frame;
      for (let attempt = 0; attempt < 30 && !frame; attempt++) {
        for (const candidate of page.frames()) {
          try { if (new URL(candidate.url()).origin === this.origin && await candidate.locator('#iptv-search').isVisible()) { frame = candidate; break; } } catch {}
        }
        if (!frame) await new Promise(resolve => setTimeout(resolve, 300));
      }
      if (!frame) throw Error('Lista IPTV indisponível.');
      const before = await this.row(frame, input.username);
      const menuButton = before.row.locator('td').last().locator('button').filter({ has: frame.locator('.fa-ellipsis-v, .fa-ellipsis-h, .bi-three-dots-vertical, [data-icon="ellipsis-v"]') });
      // A dropdown toggle is the alternative used by the current UniPlay layout.
      const toggle = await menuButton.count() ? menuButton : before.row.locator('td').last().locator('[data-toggle="dropdown"], [data-bs-toggle="dropdown"], .dropdown-toggle');
      await (await visible(toggle)).click();
      await (await visible(frame.getByRole('button', { name: 'Estender', exact: true }))).click();
      const modal = await visible(frame.locator('.modal.show, .modal.fade.show.d-block').filter({ hasText: 'Estender Usuário' }));
      if (!await modal.getByText(input.username, { exact: true }).isVisible()) throw Error('Usuário do modal não corresponde ao pedido.');
      const select = modal.locator('select');
      const options = await select.locator('option').evaluateAll(nodes => nodes.map(node => ({ value: node.value, label: node.textContent.trim() })));
      const chosen = options.filter(option => plan.label.test(option.label));
      if (chosen.length !== 1 || Number(chosen[0].value) !== plan.credits) throw Error('Plano ou custo no painel diferente do esperado.');
      await select.selectOption(chosen[0].value);
      const currentExpiry = await this.readExpiration(before.row, input.username);
      if (currentExpiry.br !== before.expiration.br) throw Error('O vencimento mudou durante a preparação.');
      state.state = 'submitting'; state.before = before.expiration.br; await this.save(file, state);
      submitted = true; // Persist BEFORE the only credit-consuming click.
      await modal.getByRole('button', { name: 'Estender', exact: true }).click();
      await modal.waitFor({ state: 'hidden', timeout: 20000 });
      let after;
      for (let attempt = 0; attempt < 5; attempt++) {
        this.snapshotSince=Date.now();
        await page.reload({ waitUntil: 'domcontentloaded' });
        const candidate = page.frames().find(item => item.url() === frame.url()) || page.mainFrame();
        await candidate.locator('#iptv-search').waitFor({ state: 'visible', timeout: 15000 });
        after = await this.row(candidate, input.username);
        if (after.expiration.timestamp > before.expiration.timestamp) break;
      }
      if (!after || !validAdvance(before.expiration, after.expiration, input.months, this.now())) throw Error('O novo vencimento não confirmou o período solicitado.');
      const result = { id: input.id, ok: true, state: 'completed', username: input.username, mode: input.mode, months: input.months,
        credits: plan.credits, before: before.expiration.br, after: after.expiration.br, expiresSql: after.expiration.sql };
      state.result = result; state.state = 'completed'; await this.save(file, state); return result;
    } catch (error) {
      const result = { id: input.id, ok: false, state: submitted ? 'review_required' : 'failed_before_submission', message: error.message };
      state.result = result; state.state = result.state; await this.save(file, state); return result;
    } finally {
      if (page && !page.isClosed()) await page.goto(this.origin + '/#/dashboard', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    }
  }
}
module.exports = { Renewal, PLANS, expiry, validAdvance, validate };
