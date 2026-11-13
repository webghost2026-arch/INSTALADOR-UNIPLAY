'use strict';
const path = require('node:path'), fs = require('node:fs/promises');
const { chromium } = require('playwright');
const { observeAndResolve } = require('./verification');
const { PanelSnapshots } = require('./panel-snapshots');
const PANEL = 'https://searchdefense.top';

class Worker {
  constructor(root, { headless = process.env.CINERMA_BROWSER_VISIBLE === '0', browser = chromium } = {}) {
    this.headless = headless;
    this.browser = browser;
    this.root = root;
    this.context = null;
    this.page = null;
    this.credits = null;
    this.creditsReadAt = null;
    this.credentials = null;
    this.prepared = false;
    this.verification = null;
    this.verificationController = null;
    this.snapshots = null;
  }

  setCredentials(value) {
    this.cancelVerification();
    this.verification = null;
    this.credentials = value;
    this.prepared = false;
  }

  hasCredentials() {
    return Boolean(this.credentials?.username && this.credentials?.password);
  }

  resetVerification() {
    if (this.verification?.state !== 'working') this.verification = null;
  }

  cancelVerification() {
    this.verificationController?.abort();
    this.verification = { state: 'manual', reason: 'cancelled' };
  }

  async startVerification() {
    return this.verification = { state: 'manual', reason: 'human_required' };
  }

  async launch() {
    if (!this.context) {
      await fs.mkdir(this.root, { recursive: true });
      const context = await this.browser.launchPersistentContext(path.join(this.root, 'chrome-profile'), {
        channel: 'chrome',
        chromiumSandbox: true,
        headless: this.headless,
        locale: 'pt-BR',
        timezoneId: 'America/Sao_Paulo',
        viewport: { width: 1440, height: 1000 }
      });
      this.snapshots = new PanelSnapshots();
      context.on('response', response => void this.snapshots.capture(response));
      this.context = context;
      context.on('close', () => {
        if (this.context === context) {
          this.cancelVerification();
          this.verification = null;
          this.context = null;
          this.page = null;
          this.credits = null;
          this.prepared = false;
          this.snapshots = null;
        }
      });
    }
    if (!this.page || this.page.isClosed()) {
      this.page = this.context.pages().find(p => { try { return new URL(p.url()).origin === PANEL; } catch { return false; } }) || this.context.pages()[0] || await this.context.newPage();
      this.page.setDefaultTimeout(12000);
      this.page.on('framenavigated', frame => { if (frame === this.page?.mainFrame()) this.prepared = false; });
    }
    if (this.page.url() === 'about:blank' || new URL(this.page.url()).origin !== PANEL) {
      await this.page.goto(PANEL + '/#/dashboard', { waitUntil: 'domcontentloaded', timeout: 15000 });
    }
  }

  async inspectPage(page) {
    if (!page || page.isClosed()) return 'no_browser';
    try {
      if (new URL(page.url()).origin !== PANEL) return 'loading';
      if (await page.getByPlaceholder(/c[oó]digo\s*2\s*fatores/i).first().isVisible()) return 'two_factor';

      const password = page.locator('input[placeholder="Senha" i]:visible');
      if (await password.count()) {
        // Integração com o novo Solver
        const captchaResult = await observeAndResolve(page, { autoSolve: true });

        if (captchaResult.state === 'ready') {
          // Garante que o token está no textarea para o form enviar
          // Usa a token retornada pelo solver para garantir consistência
          await page.evaluate((token) => {
            const ta = document.querySelector('textarea[name="g-recaptcha-response"]');
            if (ta && ta.value !== token) ta.value = token;
          }, captchaResult.token).catch(() => {});
          this.verification = { state: 'ready' };
          return 'login';
        } else if (captchaResult.state === 'required') {
          this.verification = { state: 'manual', reason: captchaResult.reason };
          return 'captcha_manual';
        } else if (captchaResult.state === 'blocked') {
          this.verification = { state: 'blocked', reason: 'ip_banned' };
          return 'captcha_blocked';
        } else if (captchaResult.state === 'expired') {
          this.verification = { state: 'expired', reason: 'challenge_expired' };
          return 'captcha_expired';
        }
        // Se não houver captcha visível ou não seja aplicável
        this.verification = null;
        return 'login';
      }

      if (/#\/(?:login|signin)(?:[/?]|$)/i.test(page.url())) return 'loading';
      if (await page.getByText(/^cr[eé]ditos$/i).first().isVisible()) return 'connected';
      const routes = await page.locator('a[href*="#/users-iptv"]:visible,a[href*="#/users-p2p"]:visible').evaluateAll(nodes => [...new Set(nodes.map(node => node.getAttribute('href')))]);
      if (routes.length >= 2) return 'connected';
      return 'loading';
    } catch { return 'loading'; }
  }

  async inspect() {
    const pages = this.context ? this.context.pages() : [];
    const candidates = [...new Set([this.page, ...pages])].filter(page => page && !page.isClosed());
    if (!candidates.length) return 'no_browser';
    let fallback = null;
    for (const page of candidates) {
      try {
        if (new URL(page.url()).origin !== PANEL) continue;
      } catch { continue; }
      const state = await this.inspectPage(page);
      if (state === 'connected') { this.page = page; return state; }
      if (!fallback || (state !== 'loading' && fallback.state === 'loading')) fallback = { page, state };
    }
    if (fallback) { this.page = fallback.page; return fallback.state; }
    return 'loading';
  }

  async prepareLogin() {
    if (!this.hasCredentials()) return;
    const state = await this.inspect();
    
    // Se está em modo manual, não preenche automaticamente para não interferir no usuário
    if (state === 'captcha_manual') return;
    if (state !== 'login') return;

    const username = this.page.locator('input[placeholder="Usuário"]:visible');
    await username.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
    if (await username.isVisible() && await username.inputValue() !== this.credentials.username) {
      await username.fill(this.credentials.username);
    }

    const password = this.page.locator('input[placeholder="Senha"]:visible');
    if (await password.isVisible() && await password.inputValue() !== this.credentials.password) {
      await password.fill(this.credentials.password);
    }
    this.prepared = true;
  }

  async submitLogin() {
    // Verifica se é seguro submeter
    const state = await this.inspect();
    if (state !== 'login') return;
    if (!this.prepared) {
      await this.prepareLogin();
      if (!this.prepared) return;
    }
    this.resetVerification();
    await this.page.getByRole('button', { name: 'Logar', exact: true }).click();
  }

  async open(credentials) {
    if (credentials) this.setCredentials(credentials);
    await this.launch();
    await this.prepareLogin();
    if (!this.headless) await this.page.bringToFront();
  }

  async recover() {
    if (!this.page || this.page.isClosed()) return this.launch();
    if (await this.inspect() === 'loading') {
      await this.page.goto(PANEL + '/#/dashboard', { waitUntil: 'domcontentloaded', timeout: 15000 });
    }
  }

  async authenticated() {
    return await this.inspect() === 'connected';
  }

  invalidateCredits() {
    this.credits = null;
    this.creditsReadAt = null;
  }

  async refreshCredits() {
    this.invalidateCredits();
    if (this.verification?.state === 'working') throw Error('Aguarde a verificacao do login.');
    if (!await this.authenticated()) throw Error('Sessao desconectada.');
    if (this.page.url() === PANEL + '/#/dashboard') {
      await this.page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 });
    } else {
      await this.page.goto(PANEL + '/#/dashboard', { waitUntil: 'domcontentloaded', timeout: 15000 });
    }
    const label = this.page.getByText(/^cr[eé]ditos$/i).first();
    await label.waitFor({ state: 'visible' });
    const text = await label.evaluate(el => {
      const card = el.closest('.card');
      if (!card) return null;
      const values = [...card.querySelectorAll('.h2,h2')].filter(x => x.getClientRects().length && x !== el).map(x => x.textContent.trim());
      return values.length === 1 ? values[0] : null;
    });
    this.credits = text !== null && /^\d+(?:[.,]\d{1,2})?$/.test(text) ? Number(text.replace(',', '.')) : null;
    if (!require('./credit-sync').validBalance(this.credits)) this.credits = null;
    this.creditsReadAt = typeof this.credits === 'number' ? new Date().toISOString() : null;
    return this.credits;
  }

  async report() {
    const authenticated = await this.authenticated();
    return {
      authenticated,
      panelData: authenticated ? this.snapshots?.report() : undefined,
      credits: authenticated ? this.credits : null,
      creditsReadAt: authenticated ? this.creditsReadAt : null,
      verificationState: this.verification?.state || 'idle',
      panelRoute: this.page ? this.page.url().split('?')[0] : null
    };
  }

  async close() {
    this.cancelVerification();
    await this.context?.close();
  }
}
module.exports = { Worker };