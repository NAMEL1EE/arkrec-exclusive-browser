(() => {
  const $ = id => document.getElementById(id)
  const params = new URLSearchParams(location.search)
  const group = window.ARKREC_SNAPSHOT?.groups?.find(entry => entry.id === params.get('group'))
  const stage = group?.stages.find(entry => entry.operation === params.get('operation') && entry.cn_name === params.get('name'))
  if (!stage) {
    $('missing-stage').hidden = false
    return
  }

  const title = stage.operation + ' · ' + stage.cn_name
  $('stage-title').textContent = title
  $('stage-group').textContent = group.episode
  $('return').href = './index.html#' + new URLSearchParams({ group: group.id }).toString()
  document.title = title + ' · 关卡备注'
  $('notes-panel').hidden = false


  const stageKey = JSON.stringify([group.id, stage.operation, stage.cn_name])
  const localPreview = location.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(location.hostname)
  const api = window.ARKREC_SITE_CONFIG?.apiUrl ?? (localPreview ? '/api/notes' : null)
  if (!api || location.protocol === 'file:') {
    $('notes-unavailable').hidden = false
    return
  }

  const endpoint = new URL(api, location.href)
  const form = $('note-form')
  const author = $('note-author')
  const field = $('note-text')
  const submit = form.querySelector('button')
  const status = $('note-status')
  const feedStatus = $('feed-status')
  const list = $('note-list')
  const more = $('note-more')
  const dateFormat = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'short',
  })
  let nextBefore = null
  let pending = null

  async function request(url, options) {
    const response = await fetch(url, {
      ...options, credentials: 'omit', signal: AbortSignal.timeout(12_000),
    })
    const result = await response.json().catch(() => null)
    if (!result || !response.ok) throw new Error(result?.error ?? '备注服务暂时不可用，请稍后再试。')
    return result
  }

  function noteItem(note) {
    const item = document.createElement('li')
    const date = document.createElement('time')
    date.dateTime = note.created_at
    date.textContent = dateFormat.format(new Date(note.created_at))
    const header = document.createElement('div')
    header.className = 'note-meta'
    const name = document.createElement('strong')
    name.textContent = note.author_name ?? '未署名'
    header.append(name, ' · ', date)
    const body = document.createElement('p')
    body.textContent = note.body
    item.append(header, body)
    return item
  }

  async function loadNotes(before = null) {
    submit.disabled = true
    more.disabled = true
    feedStatus.textContent = '正在加载备注…'
    const url = new URL(endpoint)
    url.searchParams.set('stage', stageKey)
    if (before !== null) url.searchParams.set('before', String(before))
    try {
      const { notes, nextBefore: cursor } = await request(url)
      const items = notes.map(noteItem)
      if (before === null) list.replaceChildren(...items)
      else list.append(...items)
      nextBefore = cursor
      more.hidden = cursor === null
      feedStatus.textContent = list.childElementCount ? '' : '这个关卡还没有备注。'
    } catch (error) {
      feedStatus.textContent = error.message
    } finally {
      submit.disabled = false
      more.disabled = false
    }
  }

  form.addEventListener('input', () => { status.textContent = '' })
  more.addEventListener('click', () => { void loadNotes(nextBefore) })
  form.addEventListener('submit', async event => {
    event.preventDefault()
    if (submit.disabled) return
    const authorName = author.value.trim()
    if (!authorName) {
      status.textContent = '请先填写姓名或昵称。'
      author.focus()
      return
    }
    const body = field.value.trim()
    if (!body) {
      status.textContent = '请先填写备注。'
      return
    }
    if (pending?.body !== body || pending.authorName !== authorName) {
      pending = { authorName, body, requestId: crypto.randomUUID() }
    }
    submit.disabled = true
    more.disabled = true
    author.readOnly = true
    field.readOnly = true
    status.textContent = '正在提交…'
    try {
      await request(endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stage: stageKey, ...pending }),
      })
      field.value = ''
      pending = null
      status.textContent = '已提交备注。'
      await loadNotes()
    } catch (error) {
      status.textContent = error.message
    } finally {
      submit.disabled = false
      more.disabled = false
      author.readOnly = false
      field.readOnly = false
    }
  })

  form.hidden = false
  $('notes-feed').hidden = false
  void loadNotes()
})()
