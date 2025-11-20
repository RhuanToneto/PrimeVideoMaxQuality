// Injeta uma função no contexto da página usando atributo onreset para execução no scope da página
const injectScript = (fn) => {
  if (typeof fn !== 'function') return
  const bodyMatch = fn.toString().match(/{.*}/sm)
  if (!bodyMatch) return
  const fnBody = bodyMatch[0].slice(1, bodyMatch[0].length - 1)
  document.documentElement.setAttribute('onreset', fnBody)
  document.documentElement.dispatchEvent(new CustomEvent('reset'))
  document.documentElement.removeAttribute('onreset')
}

let __apv_latestHeight = null
let __apv_resetTimer = null

// Agenda envio de resolução nula após 2s caso não haja altura registrada (reset debounced)
function __apv_resetResolutionDelayed() {
  if (__apv_resetTimer) clearTimeout(__apv_resetTimer)
  __apv_resetTimer = setTimeout(() => {
    if (__apv_latestHeight === null) {
      try { chrome.runtime.sendMessage({ type: 'resolution-update', height: null }) } catch (_) {}
    }
    __apv_resetTimer = null
  }, 2000)
}

// Monitora mudanças no elemento <video> e solicita reset de resolução ao trocar de src
function __apv_monitorVideoChanges() {
  const tryAttach = () => {
    const video = document.querySelector('video')
    if (!video) {
      setTimeout(tryAttach, 1000)
      return
    }
    let lastSrc = video.currentSrc || video.src
    video.addEventListener('loadedmetadata', () => {
      const currentSrc = video.currentSrc || video.src
      if (currentSrc === lastSrc) return
      lastSrc = currentSrc
      __apv_resetResolutionDelayed()
    })
  }
  tryAttach()
}

// Escuta mensagens postMessage vindas do script injetado com info de qualidade do MPD
window.addEventListener('message', (event) => {
  try {
    const data = event && event.data
    if (!data || data.source !== 'apv' || data.type !== 'mpd-quality') return
    if (typeof data.height !== 'number') return
    if (__apv_latestHeight !== data.height) {
      __apv_latestHeight = data.height
      try { chrome.runtime.sendMessage({ type: 'resolution-update', height: __apv_latestHeight }) } catch (_) {}
    }
    if (__apv_resetTimer) {
      clearTimeout(__apv_resetTimer)
      __apv_resetTimer = null
    }
  } catch (_) {}
})

// Responde a mensagens de popup/background solicitando a resolução atual
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'get-resolution') return
  sendResponse({ height: __apv_latestHeight })
  return true
})

// Função principal que inicia monitoramento e injeta o script de reescrita de MPD na página
const main = () => {
  __apv_monitorVideoChanges()

  // Injeta lógica que roda no contexto da página para interceptar MPD e reescrever qualidade
  injectScript(() => {
    (async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

      // Loop de espera até que document.documentElement e document.body estejam disponíveis
      for (;;) {
        if (document.documentElement !== null && document.body !== null) {
          break
        }
        await sleep(100)
      }

      
      // Determina se a URL ou Content-Type indicam um MPD que deve ser reescrito
      const shouldRewrite = (url, contentType) => {
        if (!url) return false
        if (/\.mpd(\?|$)/i.test(url)) return true
        if (contentType && /dash\+xml|application\/xml|text\/xml/i.test(contentType)) return true
        return false
      }

      
      // Reescreve o MPD mantendo apenas a melhor Representation por AdaptationSet e calcula altura máxima
      const rewriteMpd = (mpd) => {
        const parser = new DOMParser()
        const dom = parser.parseFromString(mpd, 'text/xml')
        const periods = Array.from(dom.querySelectorAll('Period'))
        let globalMaxHeight = 0

        // Converte strings de frameRate (incluindo frações) em número flutuante
        const parseFrameRate = (val) => {
          if (!val) return 0
          if (val.includes('/')) {
            const [nStr, dStr] = val.split('/')
            const n = parseFloat(nStr)
            const d = parseFloat(dStr)
            if (n && d) return n / d
          }
          const f = parseFloat(val)
          return isNaN(f) ? 0 : f
        }

        // Extrai métricas relevantes (altura, largura, frameRate e bandwidth) de uma Representation
        const metrics = (r) => ({
          h: parseInt(r.getAttribute('height') || '0', 10) || 0,
          w: parseInt(r.getAttribute('width') || '0', 10) || 0,
          f: parseFrameRate(r.getAttribute('frameRate') || ''),
          b: parseInt(r.getAttribute('bandwidth') || '0', 10) || 0
        })

        // Compara dois objetos de métricas para decidir qual representação é superior
        const compareMetrics = (a, b) => {
          if (a.h !== b.h) return a.h - b.h
          if (a.w !== b.w) return a.w - b.w
          if (a.f !== b.f) return a.f - b.f
          return a.b - b.b
        }

        // Seleciona, dentre as representations fornecidas, a melhor com base nas métricas
        const selectBest = (representations) => {
          let best = null
          representations.forEach((r) => {
            const m = metrics(r)
            if (!best) { best = { r, m }; return }
            if (compareMetrics(m, best.m) > 0) best = { r, m }
          })
          return best
        }

        // Processa cada Period do MPD, filtrando AdaptationSets de vídeo e removendo reps inferiores
        periods.forEach((period) => {
          let videoSets = Array.from(period.querySelectorAll('AdaptationSet[contentType="video"]'))
          // Filtra AdaptationSets buscando marcar como principais aqueles com Role 'main' ou schemeIdUri
          const mainSets = videoSets.filter((s) => {
            const role = s.querySelector('Role')
            return role && (role.getAttribute('value') === 'main' || role.getAttribute('schemeIdUri'))
          })
          if (mainSets.length) videoSets = mainSets

          videoSets.forEach((set) => {
            // Obtem as Representations do AdaptationSet atual
            const reps = Array.from(set.querySelectorAll('Representation'))
            if (!reps.length) return
            const best = selectBest(reps)
            // Remove todas as Representations que não forem a melhor do conjunto
            reps.forEach((r) => {
              if (best && r !== best.r && r.parentNode) r.parentNode.removeChild(r)
            })
            if (best && best.m && best.m.h > globalMaxHeight) globalMaxHeight = best.m.h
          })
        })

        // Se encontrou uma altura máxima global, dispara postMessage para o content script
        if (globalMaxHeight) {
          try { window.postMessage({ source: 'apv', type: 'mpd-quality', height: globalMaxHeight }, '*') } catch (_) {}
        }
        return dom.documentElement.outerHTML
      }

      
      // Substitui window.fetch para interceptar e reescrever respostas MPD em tempo de execução
      const installFetchHook = () => {
        const origFetch = window.fetch
        if (typeof origFetch !== 'function') return

        window.fetch = async function (input, init) {
          const res = await origFetch.apply(this, arguments)
          try {
            const url = typeof input === 'string' ? input : (input && input.url) ? input.url : ''
            const ct = res.headers && res.headers.get ? res.headers.get('content-type') : ''
            // Se a resposta não for um MPD, retorna a Response original
            if (!shouldRewrite(url, ct)) return res
            const txt = await res.clone().text()
            if (!txt) return res
            const mpd_ = rewriteMpd(txt)
            // Corrige headers removendo content-length e assegurando content-type correto
            const headers = new Headers(res.headers)
            if (headers.has('content-length')) headers.delete('content-length')
            if (!headers.has('content-type')) headers.set('content-type', ct || 'application/dash+xml; charset=UTF-8')
            const newRes = new Response(mpd_, { status: res.status, statusText: res.statusText, headers })
            Object.defineProperty(newRes, 'url', { value: res.url })
            return newRes
          } catch (e) {
            return res
          }
        }
      }

      // Sobrescreve XMLHttpRequest para interceptar resposta textual e reescrever MPD
      const installXHRHook = () => {
        const origOpen = XMLHttpRequest.prototype.open
        const origSend = XMLHttpRequest.prototype.send

        // Intercepta open para armazenar a URL requisitada no objeto XHR
        XMLHttpRequest.prototype.open = function (method, url) {
          this.__amzn_mpd_url = url
          return origOpen.apply(this, arguments)
        }

        // Intercepta send para anexar um onDone que reescreve responseText quando aplicável
        XMLHttpRequest.prototype.send = function (body) {
          const self = this
          // Handler chamado quando a requisição termina para reescrever o MPD se necessário
          const onDone = function () {
            try {
              const url = self.__amzn_mpd_url || ''
              const ct = self.getResponseHeader ? self.getResponseHeader('content-type') : ''
              // Valida se a resposta é MPD e que o tipo de resposta é textual antes de reescrever
              if (!shouldRewrite(url, ct)) return
              if (self.responseType && self.responseType !== '' && self.responseType !== 'text') return
              const txt = self.responseText
              if (!txt) return
              const mpd_ = rewriteMpd(txt)
              // Substitui dinamicamente responseText/response para devolver o MPD reescrito
              try { Object.defineProperty(self, 'responseText', { get: () => mpd_, configurable: true }) } catch (_) {}
              try { Object.defineProperty(self, 'response', { get: () => mpd_, configurable: true }) } catch (_) {}
            } catch (e) {}
          }

          // Adiciona listeners que garantem a execução do onDone ao finalizar a requisição
          this.addEventListener('load', onDone)
          this.addEventListener('readystatechange', function () { if (this.readyState === 4) onDone() })
          return origSend.apply(this, arguments)
        }
      }

      // Instala os hooks de fetch e XHR para aplicar a reescrita de MPD na página
      installFetchHook()
      installXHRHook()
    })()
  })
}

main()
