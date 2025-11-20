// IIFE que inicializa o popup e solicita a resolução ao content script
;(async () => {
  const DEFAULT_HINT = 'Reproduza um filme ou uma série no Prime Video'

  const query = (sel) => document.querySelector(sel)
  const resolutionEl = query('#resolution')
  const titleEl = document.getElementById('title')
  const hintEl = document.getElementById('hint')

  // Mostra o texto de instrução padrão quando não há resolução disponível
  const showHintDefault = () => {
    if (!hintEl) return
    hintEl.style.display = ''
    hintEl.textContent = DEFAULT_HINT
  }

  // Exibe a resolução (ex: 1080p) ou restaura o hint e altera classes CSS
  const showResolution = (height) => {
    const valid = typeof height === 'number' && height > 0
    if (!resolutionEl) return
    if (valid) {
      resolutionEl.textContent = `${height}p`
      resolutionEl.style.display = ''
      if (titleEl) titleEl.style.display = ''
      if (hintEl) hintEl.style.display = 'none'
      document.body.classList.add('resolution-visible')
      return
    }
    resolutionEl.textContent = ''
    resolutionEl.style.display = 'none'
    if (titleEl) titleEl.style.display = 'none'
    showHintDefault()
    document.body.classList.remove('resolution-visible')
  }

  let activeTabId = null

  try {
    // Obtém a aba ativa para enviar/receber mensagens do seu content script
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    // Caso não exista aba ativa, exibe estado sem resolução e finaliza
    if (!tab || !tab.id) { showResolution(null); return }
    activeTabId = tab.id

    // Solicita ao content script da aba ativa a resolução detectada
    const response = await chrome.tabs.sendMessage(activeTabId, { type: 'get-resolution' })
    const initialHeight = response && typeof response.height === 'number' ? response.height : null
    showResolution(initialHeight)

    // Se não obteve resolução na primeira tentativa, tenta obter novamente após um pequeno atraso
    if (!initialHeight) {
      setTimeout(async () => {
        const next = await chrome.tabs.sendMessage(activeTabId, { type: 'get-resolution' })
        const secondHeight = next && typeof next.height === 'number' ? next.height : null
        if (secondHeight) showResolution(secondHeight)
      }, 300)
    }

    // Escuta atualizações de resolução vindas do content script, assegurando que pertençam à aba ativa
    chrome.runtime.onMessage.addListener((msg, sender) => {
      if (!msg || msg.type !== 'resolution-update') return
      if (!sender || !sender.tab || sender.tab.id !== activeTabId) return
      const hh = typeof msg.height === 'number' ? msg.height : null
      showResolution(hh)
    })
  } catch (_) {
    // Em caso de erro na comunicação, assume estado sem resolução
    showResolution(null)
  }
})()
