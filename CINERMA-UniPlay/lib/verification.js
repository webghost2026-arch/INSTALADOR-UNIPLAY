'use strict';

const path = require('node:path');
const { Speech } = require('./speech');

// Instância única do transcritor
// O dataRoot deve ser o mesmo usado pelo Worker para manter a consistência dos temporários
const transcriber = new Speech({
  directory: path.join(__dirname, '..', 'speech'),
  dataRoot: path.join(__dirname, '..', 'speech-temp')
});

async function observeAndResolve(page, { autoSolve = true } = {}) {
  // 1. Verifica se o reCAPTCHA já foi resolvido (token presente no textarea)
  const ready = await page.locator('textarea[name="g-recaptcha-response"]').evaluateAll(
    els => els.some(el => Boolean(el.value && el.value.trim()))
  );
  if (ready) {
    const token = await getToken(page);
    return { state: 'ready', token };
  }

  // 2. Verifica se o widget do reCAPTCHA está visível
  const captchaWidget = page.locator('iframe[title="reCAPTCHA"], .g-recaptcha').first();
  if (!(await captchaWidget.isVisible())) {
    return { state: 'not_present' };
  }

  // 3. Extrai a SiteKey dinamicamente
  let siteKey = await page.locator('.g-recaptcha').first().getAttribute('data-sitekey').catch(() => null);
  if (!siteKey) {
    const html = await page.content();
    const match = html.match(/data-sitekey="([^"]+)"/);
    if (match) siteKey = match[1];
  }
  if (!siteKey) return { state: 'error', reason: 'sitekey_not_found' };

  if (!autoSolve) {
    return { state: 'required', reason: 'human_required' };
  }

  try {
    // FIX-1 + FIX-4 — ESTRATÉGIA A com timeout de 2s
    // grecaptcha.execute() é para widgets invisible; em widgets v2 checkbox ele nunca chama
    // callback rapidamente — sem timeout ficava pendurado até o limite do Playwright (12s),
    // bloqueando a Estratégia B e causando o backoff de 2 minutos no monitor.
    // Agora: resolve(null) em até 2s, garantindo queda rápida para a Estratégia B.
    const tokenPromise = page.evaluate((key) => {
      return new Promise((resolve) => {
        if (typeof grecaptcha !== 'undefined') {
          const existing = grecaptcha.getResponse();
          if (existing && existing.length > 10) {
            resolve(existing);
          } else {
            try {
              grecaptcha.execute(key, {
                callback: (response) => resolve(response || null),
                errorCallback: () => resolve(null)
              });
            } catch {
              resolve(null);
            }
          }
        } else {
          resolve(null);
        }
      });
    }, siteKey);

    // FIX-4: timeout de 2s para a Estratégia A não pendurar o fluxo
    const token = await Promise.race([
      tokenPromise,
      new Promise(resolve => setTimeout(() => resolve(null), 2000))
    ]).catch(() => null);

    if (token && token.length > 20) {
      return { state: 'ready', token };
    }

    // ESTRATÉGIA B: Interação Visual (Checkbox → Áudio → Submit)
    const frame = page.frames().find(f => f.url().includes('recaptcha'));
    if (frame) {
      // 1. Tenta clicar no checkbox principal
      const checkbox = frame.locator('#recaptcha-anchor, input[type="checkbox"]').first();
      if (await checkbox.isVisible()) {
        await checkbox.click({ timeout: 3000 });
      }

      // 2. Aguarda resolução rápida (bot score baixo → token direto)
      await page.waitForFunction(() => {
        const ta = document.querySelector('textarea[name="g-recaptcha-response"]');
        return ta && ta.value && ta.value.length > 10;
      }, { timeout: 5000 }).catch(() => {});

      // Verifica se resolveu após o clique
      const resolvedAfterClick = await page.locator('textarea[name="g-recaptcha-response"]').evaluateAll(
        els => els.some(el => Boolean(el.value && el.value.trim()))
      );
      if (resolvedAfterClick) {
        return { state: 'ready', token: await getToken(page) };
      }

      // FIX-3 — Clica no botão de alternar para desafio de ÁUDIO antes de checar .rc-audiochallenge.
      // O fluxo correto é: checkbox → modal de imagem aparece → clicar no botão de áudio
      // → .rc-audiochallenge aparece. Sem este clique o código nunca chegava ao áudio.
      const challengeFrame = page.frames().find(f => f.url().includes('recaptcha/api2/bframe'));
      const targetFrame = challengeFrame || frame;

      const audioSwitchBtn = targetFrame.locator(
        '#recaptcha-audio-button, button[aria-label*="audio" i], button[title*="audio" i]'
      ).first();

      if (await audioSwitchBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
        await audioSwitchBtn.click();
        // Aguarda o painel de áudio aparecer
        await targetFrame.waitForSelector('.rc-audiochallenge', { timeout: 5000 }).catch(() => {});
      }

      // 3. Verifica se agora há desafio de áudio (após a troca ou se já veio direto)
      const hasAudioChallenge = await targetFrame.evaluate(() => {
        return document.querySelector('.rc-audiochallenge') !== null;
      });

      if (hasAudioChallenge) {
        return await solveAudioChallenge(page, targetFrame);
      }

      // 4. Fallback: mosaico — tenta Verificar se o botão estiver visível
      const verifyButton = targetFrame.locator('button[aria-label="Verificar"], button[aria-label="Verify"]').first();
      if (await verifyButton.isVisible().catch(() => false)) {
        await verifyButton.click().catch(() => {});
        await page.waitForTimeout(2000);
        const resolvedAfterVerify = await page.locator('textarea[name="g-recaptcha-response"]').evaluateAll(
          els => els.some(el => Boolean(el.value && el.value.trim()))
        );
        if (resolvedAfterVerify) {
          return { state: 'ready', token: await getToken(page) };
        }
      }

      return { state: 'required', reason: 'image_challenge_or_failed' };
    }

    return { state: 'required', reason: 'auto_solve_failed' };

  } catch (e) {
    return { state: 'error', reason: e.message };
  }
}

async function solveAudioChallenge(page, frame) {
  try {
    // FIX-2 — Registra o listener de resposta ANTES de clicar em Play.
    // Antes o listener era registrado após o clique: a resposta HTTP do .mp3 já tinha passado
    // e o Promise ficava preso até o timeout de 10 s, sempre rejeitando.
    const audioPromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        page.off('response', listener);
        reject(new Error('Audio capture timeout'));
      }, 12000);

      async function listener(response) {
        const url = response.url();
        if (
          url.includes('/recaptcha/api2/audio') ||
          url.includes('recaptcha') && url.includes('.mp3') ||
          url.includes('recaptcha') && url.includes('/payload')
        ) {
          try {
            const buffer = await response.body();
            if (buffer && buffer.length > 1000) {   // descarta respostas de erro (< 1 KB)
              clearTimeout(timeout);
              page.off('response', listener);
              resolve(buffer);
            }
          } catch (err) {
            clearTimeout(timeout);
            page.off('response', listener);
            reject(err);
          }
        }
      }

      page.on('response', listener);
    });

    // Clica Play somente depois que o listener já está ativo
    const playButton = frame.locator(
      'button[aria-label="Play audio"], button[aria-label="Reproduzir áudio"], .rc-audiochallenge-play-button button'
    ).first();
    if (await playButton.isVisible({ timeout: 4000 }).catch(() => false)) {
      await playButton.click();
    }

    const audioBuffer = await audioPromise;

    // 3. Transcreve o áudio com Whisper local
    const transcription = await transcriber.transcribe(audioBuffer);

    if (!transcription || transcription.length < 3) {
      return { state: 'required', reason: 'transcription_failed' };
    }

    // 4. Normaliza a transcrição
    const cleanText = transcription
      .normalize('NFKC')
      .replace(/[^\p{L}\p{N}\s'-]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();

    // 5. Preenche o campo de resposta de áudio
    const inputField = frame.locator(
      'input[type="text"][name="audio-response"], .rc-audiochallenge-response-field input'
    ).first();

    if (await inputField.isVisible({ timeout: 3000 }).catch(() => false)) {
      await inputField.fill(cleanText);

      // 6. Clica em Verificar
      const verifyButton = frame.locator(
        'button[aria-label="Verificar"], button[aria-label="Verify"], #recaptcha-verify-button'
      ).first();
      if (await verifyButton.isVisible().catch(() => false)) {
        await verifyButton.click();
      }

      // 7. Aguarda a resolução
      await page.waitForFunction(() => {
        const ta = document.querySelector('textarea[name="g-recaptcha-response"]');
        return ta && ta.value && ta.value.length > 10;
      }, { timeout: 10000 }).catch(() => {});

      const resolved = await page.locator('textarea[name="g-recaptcha-response"]').evaluateAll(
        els => els.some(el => Boolean(el.value && el.value.trim()))
      );

      if (resolved) {
        return { state: 'ready', token: await getToken(page), method: 'whisper-audio' };
      }
    }

    return { state: 'required', reason: 'audio_challenge_verification_failed' };

  } catch (e) {
    return { state: 'error', reason: 'audio_challenge_error: ' + e.message };
  }
}

async function getToken(page) {
  return page.locator('textarea[name="g-recaptcha-response"]').evaluateAll(
    els => els.find(el => el.value.trim())?.value || null
  );
}

// Mantém a função antiga para compatibilidade
async function observeVerification(page) {
  const result = await observeAndResolve(page, { autoSolve: false });
  if (result.state === 'ready') return 'ready';
  if (result.state === 'blocked') return 'blocked';
  if (result.state === 'expired') return 'expired';
  if (result.state === 'required') return 'required';
  return 'required';
}

module.exports = { observeAndResolve, observeVerification, getToken };