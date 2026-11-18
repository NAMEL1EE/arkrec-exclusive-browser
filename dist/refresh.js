(() => {
  const button = document.getElementById('refresh-button')
  const status = document.getElementById('refresh-status')
  const run = document.getElementById('refresh-run')
  const localPreview = location.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(location.hostname)
  const endpoint = window.ARKREC_SITE_CONFIG?.refreshUrl ?? (localPreview ? '/api/refresh' : null)
  if (!endpoint || location.protocol === 'file:') {
    status.textContent = '在线更新尚未启用。'
    return
  }

  const date = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  })
  let cooldownTimer

  function render(result) {
    clearTimeout(cooldownTimer)
    const notes = []
    if (result.preview) notes.push('本地演示')
    if (result.state === 'ready') notes.push('全站每 ' + result.cooldownMinutes + ' 分钟可更新一次。')
    if (result.state === 'queued') notes.push(result.preview ? '已模拟提交。' : '已提交更新，发布完成后重新载入即可。')
    if (result.state === 'dispatching') notes.push('更新请求正在提交。')
    if (result.state === 'failed') notes.push('更新请求发送失败。')
    if (result.nextAt) {
      notes.push(date.format(result.nextAt) + '（北京时间）可再次更新。')
      cooldownTimer = setTimeout(() => { void request('GET') }, Math.max(1000, result.nextAt - Date.now() + 1000))
    }
    status.textContent = notes.join(' ')
    button.disabled = result.state !== 'ready'
    run.hidden = !result.runUrl
    if (result.runUrl) run.href = result.runUrl
  }

  async function request(method) {
    button.disabled = true
    if (method === 'POST') status.textContent = '正在提交更新请求…'
    try {
      const response = await fetch(endpoint, {
        method, credentials: 'omit', signal: AbortSignal.timeout(16_000),
        ...(method === 'POST' ? { headers: { 'Content-Type': 'application/json' }, body: '{}' } : {}),
      })
      const result = await response.json()
      if (!('nextAt' in result)) throw new Error(result.error || '暂时无法连接更新服务。')
      render(result)
    } catch (error) {
      status.textContent = method === 'POST'
        ? '暂未确认更新请求，请重新载入查看状态。'
        : error.message
    }
  }

  button.addEventListener('click', () => { void request('POST') })
  void request('GET')
})()
