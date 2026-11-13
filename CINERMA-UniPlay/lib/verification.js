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
    // ESTRATÉGIA A: Execução Invisível via JS
    const token = await page.evaluate((key) => {
      return new Promise((resolve, reject) => {
        if (typeof grecaptcha !== 'undefined') {
          const existing = grecaptcha.getResponse();
          if (existing && existing.length > 10) {
            resolve(existing);
          } else {
            grecaptcha.execute(key, {
              callback: (response) => resolve(response),
              errorCallback: (err) => reject(new Error('grecaptcha_error: ' + err))
            });
          }
        } else {
          reject(new Error('grecaptcha library not loaded'));
        }
      });
    }, siteKey);

    if (token && token.length > 20) {
      return { state: 'ready', token };
    }

    // ESTRATÉGIA B: Interação Visual (Checkbox e Desafios)
    const frame = page.frames().find(f => f.url().includes('recaptcha'));
    if (frame) {
      // 1. Tenta clicar no checkbox principal
      const checkbox = frame.locator('input[type="checkbox"]').first();
      if (await checkbox.isVisible()) {
        await checkbox.click({ timeout: 3000 });
      }

      // 2. Aguarda a resolução ou a mudança para um desafio
      await page.waitForFunction(() => {
        const ta = document.querySelector('textarea[name="g-recaptcha-response"]');
        return ta && ta.value && ta.value.length > 10;
      }, { timeout: 15000 }).catch(() => {});

      // Verifica se resolveu após o clique
      const resolvedAfterClick = await page.locator('textarea[name="g-recaptcha-response"]').evaluateAll(
        els => els.some(el => Boolean(el.value && el.value.trim()))
      );
      if (resolvedAfterClick) {
        return { state: 'ready', token: await getToken(page) };
      }

      // 3. Se não resolveu, verifica se há um desafio de áudio
      const hasAudioChallenge = await frame.evaluate(() => {
        return document.querySelector('.rc-audiochallenge') !== null;
      });

      if (hasAudioChallenge) {
        return await solveAudioChallenge(page, frame);
      }

      // 4. Se não resolveu e não é áudio, provavelmente é mosaico
      // Tenta verificar se há um botão "Verificar"
      const verifyButton = frame.locator('button[aria-label="Verificar"]').first();
      if (await verifyButton.isVisible()) {
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
    // 1. Dispara a reprodução do áudio
    const playButton = frame.locator('button[aria-label="Play audio"]').first();
    if (await playButton.isVisible()) {
      await playButton.click();
    }

    // 2. Captura o áudio
    const audioPromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Audio capture timeout')), 10000);
      const listener = async (response) => {
        const url = response.url();
        if (url.includes('/recaptcha/api2/audio') || url.includes('.mp3')) {
          try {
            const buffer = await response.body();
            clearTimeout(timeout);
            page.off('response', listener);
            resolve(buffer);
          } catch (e) {
            clearTimeout(timeout);
            reject(e);
          }
        }
      };
      page.on('response', listener);
    });

    const audioBuffer = await audioPromise;

    // 3. Transcreve o áudio usando o speech.js
    const transcription = await transcriber.transcribe(audioBuffer);
    
    if (!transcription || transcription.length < 3) {
      return { state: 'required', reason: 'transcription_failed' };
    }

    // 4. Limpa a transcrição (remove pontuação e normaliza)
    const cleanText = transcription.replace(/[^\p{L}\p{N}\s'-]/gu, ' ').replace(/\s+/g, ' ').trim().toLowerCase();

    // 5. Preenche o campo de resposta
    const inputField = frame.locator('input[type="text"][name="audio-response"]').first();
    if (await inputField.isVisible()) {
      await inputField.fill(cleanText);
      
      // 6. Clica em Verificar
      const verifyButton = frame.locator('button[aria-label="Verificar"]').first();
      if (await verifyButton.isVisible()) {
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