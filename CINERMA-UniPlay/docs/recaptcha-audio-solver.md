# reCAPTCHA Audio Solver — Documentação Técnica

**Arquivo:** `lib/verification.js`  
**Data do fix:** 2026-11-17  
**Versão:** v2 (audio-first)

---

## Visão Geral

O módulo `verification.js` é responsável por resolver automaticamente o reCAPTCHA v2
que aparece na tela de login do painel (`searchdefense.top`).

O fluxo implementado é:

```
Página carrega com login + reCAPTCHA
        │
        ▼
  Token já presente? ──► SIM ──► state: 'ready' (retorna)
        │ NÃO
        ▼
  Widget visível?   ──► NÃO ──► state: 'not_present' (retorna)
        │ SIM
        ▼
  Extrai siteKey
        │
        ▼
  Estratégia A — grecaptcha.execute() [invisible]
        │ falhou ou sem token
        ▼
  Estratégia B — Clica checkbox
        │ token direto? ──► SIM ──► state: 'ready'
        │ NÃO
        ▼
  Clica botão "Áudio"  ◄── FIX-3
        │
        ▼
  .rc-audiochallenge apareceu?
        │ SIM
        ▼
  solveAudioChallenge()
    1. Registra listener HTTP  ◄── FIX-2
    2. Clica Play
    3. Captura .mp3
    4. Whisper transcreve
    5. Fill + Verificar
        │
        ▼
  state: 'ready', method: 'whisper-audio'
```

---

## Funções Públicas

### `observeAndResolve(page, { autoSolve })`

Ponto de entrada principal. Chamada em `worker.js → inspectPage()` toda vez
que a página de login é detectada.

| Retorno `state` | Significado |
|---|---|
| `'ready'` | Token obtido, login pode ser submetido |
| `'not_present'` | Nenhum widget de captcha encontrado |
| `'required'` | Captcha existe mas solver falhou — requer intervenção manual |
| `'error'` | Exceção inesperada — ver campo `reason` |

### `observeVerification(page)`

Wrapper de compatibilidade retroativa. Chama `observeAndResolve` com `autoSolve: false`.
Mantida para não quebrar código legado que espera as strings `'ready'`, `'required'`, etc.

### `getToken(page)`

Lê o valor atual do `textarea[name="g-recaptcha-response"]` na página principal.

---

## Bugs Corrigidos (2026-11-17)

### FIX-1 — Estratégia A engolia o fluxo com `reject()`

**Arquivo:** `observeAndResolve()` — bloco Estratégia A  
**Linha original:** ~53

**Problema:**  
`grecaptcha.execute()` é uma API exclusiva de widgets `type="invisible"`. No painel,
o widget é do tipo **v2 checkbox** padrão. Quando `execute()` era chamado em um
widget v2, o Google disparava o `errorCallback` com um erro interno.

O código anterior passava esse erro para `reject()`, o que jogava toda a execução
no `catch (e)` externo e retornava `{ state: 'error' }` — antes mesmo de tentar
qualquer interação visual (Estratégia B).

**Fix:**
```js
// ANTES — rompia o fluxo
errorCallback: (err) => reject(new Error('grecaptcha_error: ' + err))

// DEPOIS — passa adiante para Estratégia B
errorCallback: () => resolve(null)   // FIX-1
```

Também adicionado `try/catch` em torno de `grecaptcha.execute()` pois em alguns
navegadores com extensões ativas ele lança sincronamente. Qualquer falha na
Estratégia A agora resulta em `token = null` e segue para a Estratégia B.

---

### FIX-2 — Listener de resposta registrado tarde demais

**Arquivo:** `solveAudioChallenge()` — captura do .mp3  
**Linha original:** ~131

**Problema:**  
O listener `page.on('response', listener)` era registrado **depois** de
`playButton.click()`. O Playwright processava o clique de forma síncrona,
o browser disparava a requisição HTTP do `.mp3`, recebia a resposta — e só
então o listener era registrado. A resposta já tinha passado. O `Promise`
ficava pendurado até o timeout de 10 s e sempre rejeitava com
`'Audio capture timeout'`.

**Fix:**  
Registrar o listener **antes** do clique, sem exceção:

```js
// DEPOIS (ordem correta)
const audioPromise = new Promise((resolve, reject) => {
  // listener registrado aqui...
  page.on('response', listener);
});

// clique só depois
await playButton.click();
const audioBuffer = await audioPromise;
```

Adicionalmente:
- Timeout aumentado de 10 s para 12 s (latência de rede variável)
- Filtro `buffer.length > 1000` descarta respostas HTTP de erro (< 1 KB)
  que passavam no filtro de URL mas não continham áudio válido
- URL matcher expandido para cobrir `/payload` além de `/audio` e `.mp3`

---

### FIX-3 — Botão de alternância para áudio nunca era clicado

**Arquivo:** `observeAndResolve()` — Estratégia B, passo 3  
**Linha original:** ~90

**Problema:**  
O reCAPTCHA v2, quando o score do bot é baixo, abre o desafio de **imagem**
(mosaico) como tela inicial. O seletor `.rc-audiochallenge` só aparece
**depois** que o usuário/bot clica no botão de alternar para áudio
(`#recaptcha-audio-button`). O código não clicava nesse botão — verificava
`.rc-audiochallenge` imediatamente após o checkbox, não encontrava, e caia
no fallback de mosaico (`image_challenge_or_failed`).

**Fix:**  
Localizar e clicar o botão de alternância antes de checar `.rc-audiochallenge`:

```js
// FIX-3 — clica no botão de alternância para áudio
const audioSwitchBtn = targetFrame.locator(
  '#recaptcha-audio-button, button[aria-label*="audio" i], button[title*="audio" i]'
).first();

if (await audioSwitchBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
  await audioSwitchBtn.click();
  await targetFrame.waitForSelector('.rc-audiochallenge', { timeout: 5000 }).catch(() => {});
}
```

O frame do desafio (`bframe`) é diferente do frame do widget (`anchor`).
O código agora detecta o frame correto:

```js
const challengeFrame = page.frames().find(f => f.url().includes('recaptcha/api2/bframe'));
const targetFrame = challengeFrame || frame;
```

---

## Dependências

| Módulo | Papel |
|---|---|
| `playwright` | Automação do browser (Chrome via canal estável) |
| `lib/speech.js` | Wrapper do Whisper local (`whisper-cli.exe` + `ggml-tiny-q5_1.bin`) |

O Whisper roda **localmente** — nenhum dado de áudio sai da máquina.
O modelo `tiny-q5_1` é quantizado e cabe em ~32 MB de RAM, latência ~1–3 s
para os ~8 s de áudio do desafio.

---

## Requisitos para o Solver Funcionar

1. `speech/whisper-cli.exe` presente
2. `speech/ggml-tiny-q5_1.bin` presente
3. Chrome instalado (canal estável) — Playwright usa `channel: 'chrome'`
4. Sem extensões que bloqueiem requisições de áudio do reCAPTCHA
5. IP não banido pelo Google (`state: 'blocked'` indica ban de IP)

---

## Estados de Retorno e o que Fazer

| State | `worker.js` define | Ação do usuário |
|---|---|---|
| `ready` | `verification.state = 'ready'` | Login é submetido automaticamente |
| `not_present` | `verification = null` | Normal — sem captcha nesta sessão |
| `required` | `verification.state = 'manual'` | Resolver manualmente no browser aberto |
| `error` | `verification.state = 'manual'` | Ver `reason`, verificar `speech/` |
| `blocked` | `verification.state = 'blocked'` | Trocar IP / aguardar cooldown |
