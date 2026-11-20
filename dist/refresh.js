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
  const updateLabel = button.textContent
  let checkTimer
  let action = 'GET'

  function render(result, pendingChecks, unconfirmed) {
    const notes = []
    if (result.preview) notes.push('本地演示')
    if (result.state === 'ready') {
      if (unconfirmed) notes.push('暂未确认上次更新请求。')
      notes.push('全站每 ' + result.cooldownMinutes + ' 分钟可更新一次。')
    }
    if (result.state === 'queued') notes.push(result.preview ? '已模拟提交。' : '已提交更新，发布完成后重新载入即可。')
    if (result.state === 'dispatching') notes.push('更新请求正在提交。')
    if (result.state === 'failed') notes.push('更新请求发送失败。')
    if (result.nextAt) {
      notes.push(date.format(result.nextAt) + '（北京时间）可再次更新。')
      const untilReady = Math.max(1000, result.nextAt - Date.now() + 1000)
      const checking = result.state === 'dispatching' && pendingChecks > 0
      checkTimer = setTimeout(() => {
        void request('GET', { pendingChecks: checking ? pendingChecks - 1 : 3 })
      }, checking ? Math.min(2500, untilReady) : untilReady)
    }
    status.textContent = notes.join(' ')
    action = 'POST'
    button.textContent = updateLabel
    button.disabled = result.state !== 'ready'
    run.hidden = !result.runUrl
    if (result.runUrl) run.href = result.runUrl
  }

  async function request(method, { retries = 2, pendingChecks = 3, unconfirmed = false } = {}) {
    clearTimeout(checkTimer)
    button.disabled = true
    if (method === 'GET' && !unconfirmed) status.textContent = '正在检查更新状态…'
    if (method === 'POST') status.textContent = '正在提交更新请求…'
    try {
      const response = await fetch(endpoint, {
        method, credentials: 'omit', signal: AbortSignal.timeout(16_000),
        ...(method === 'POST' ? { headers: { 'Content-Type': 'application/json' }, body: '{}' } : {}),
      })
      const result = await response.json()
      if (!result || !('nextAt' in result)) throw new Error('更新接口未返回状态')
      render(result, pendingChecks, unconfirmed)
    } catch {
      if (method === 'POST') {
        status.textContent = '暂未收到提交回执，正在核对更新状态…'
        checkTimer = setTimeout(() => { void request('GET', { unconfirmed: true }) }, 2000)
        return
      }
      if (retries > 0) {
        status.textContent = '更新服务响应较慢，正在重新检查…'
        checkTimer = setTimeout(() => { void request('GET', { retries: retries - 1, pendingChecks, unconfirmed }) }, 2000)
        return
      }
      status.textContent = '暂时无法确认更新状态，请重查状态。'
      action = 'GET'
      button.textContent = '重查状态'
      button.disabled = false
    }
  }

  button.addEventListener('click', () => { void request(action) })
  void request('GET')
})()
