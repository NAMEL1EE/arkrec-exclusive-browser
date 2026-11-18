(() => {
  const data = window.ARKREC_SNAPSHOT
  const $ = id => document.getElementById(id)
  if (data?.schema !== 1 || data.flow !== '解手流' || !Array.isArray(data.groups) || !data.groups.length) {
    $('error').hidden = false
    return
  }

  const ACTIVITY = '活动关卡'
  const MAIN = '主线关卡'
  const groupSearch = $('group-search')
  const recordSearch = $('record-search')
  const difficulty = $('difficulty')
  const tabButtons = [...document.querySelectorAll('[data-story]')]
  const params = new URLSearchParams(location.hash.slice(1))
  const normalize = value => value.normalize('NFKC').toLowerCase().replace(/[\s-]+/g, '')
  const format = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  })
  const formatYear = new Intl.DateTimeFormat('en', { timeZone: 'Asia/Shanghai', year: 'numeric' })
  const sourceLink = 'https://wiki.arkrec.com/operation/'
  const label = group => group.chapter === null ? group.episode : '第 ' + group.chapter + ' 章 · ' + group.episode
  const eventCode = group => group.story === ACTIVITY
    ? group.eventCode ?? group.stages.map(stage => stage.operation.match(/^([A-Z]{2})-/)?.[1]).find(Boolean)
    : null
  const yearOf = group => Number.isFinite(Date.parse(group.release)) ? formatYear.format(new Date(group.release)) : ''
  const yearLabel = year => year ? year + ' 年' : '年份待定'
  const activityYears = new Map()
  for (const group of data.groups.filter(group => group.story === ACTIVITY && group.stages.length > 0)) {
    const year = yearOf(group)
    if (!activityYears.has(year)) activityYears.set(year, [])
    activityYears.get(year).push(group)
  }
  const years = [...activityYears.keys()].sort((left, right) => right.localeCompare(left))
  const mainGroups = data.groups.filter(group => group.story === MAIN)
  const preferredGroup = groups => groups?.find(group => group.stages.length) ?? groups?.[0] ?? null
  const savedGroup = data.groups.find(group => group.id === params.get('group') && (group.story !== ACTIVITY || group.stages.length > 0))
  const savedYear = params.get('year')
  let selected = savedGroup ?? (activityYears.has(savedYear) ? null : preferredGroup(activityYears.get(years[0])))
  let story = selected?.story ?? ACTIVITY
  let year = story === ACTIVITY && selected ? yearOf(selected) : activityYears.has(savedYear) ? savedYear : years[0]

  $('snapshot').textContent = '快照更新于 ' + format.format(new Date(data.syncedAt)) + '（北京时间）'
  $('layout').hidden = false

  function makeElement(tag, text, className) {
    const element = document.createElement(tag)
    element.textContent = text
    if (className) element.className = className
    return element
  }

  function saveSelection() {
    const url = new URL(location.href)
    const selection = selected ? { group: selected.id } : { year }
    url.hash = new URLSearchParams(selection).toString()
    history.replaceState(null, '', url)
  }

  function showSelection() {
    const results = $('results')
    const prompt = $('selection-prompt')
    results.hidden = !selected
    prompt.hidden = Boolean(selected)
    if (selected) {
      recordSearch.value = ''
      difficulty.value = 'all'
      renderRecords()
    } else {
      prompt.textContent = year ? '请选择 ' + yearLabel(year) + '的活动查看独享。' : '请选择活动查看独享。'
    }
    for (const button of $('groups').querySelectorAll('[data-group]')) {
      if (button.dataset.group === selected?.id) button.setAttribute('aria-current', 'true')
      else button.removeAttribute('aria-current')
    }
  }

  function updatePicker() {
    const isActivity = story === ACTIVITY
    $('years').hidden = !isActivity
    for (const button of tabButtons) button.setAttribute('aria-pressed', String(button.dataset.story === story))
    for (const button of $('years').querySelectorAll('[data-year]')) {
      button.setAttribute('aria-pressed', String(button.dataset.year === year))
    }
    $('picker-title').textContent = isActivity ? '选择活动' : '选择主线章节'
    groupSearch.setAttribute('aria-label', isActivity ? '筛选活动' : '筛选主线章节')
    groupSearch.placeholder = isActivity ? '活动名称或关卡代号' : '章节号、名称或关卡代号'
    renderGroups()
    showSelection()
  }

  function renderGroups() {
    const query = normalize(groupSearch.value)
    const groups = story === ACTIVITY ? activityYears.get(year) ?? [] : mainGroups
    const matches = groups.filter(group =>
      normalize(label(group)).includes(query)
      || Boolean(eventCode(group)?.toLowerCase().includes(query))
      || (group.chapter !== null && String(group.chapter) === query)
      || group.stages.some(stage => normalize(stage.operation).includes(query))
    )
    const fragment = document.createDocumentFragment()
    for (const group of matches) {
      const button = makeElement('button', '', 'group-button')
      button.type = 'button'
      button.dataset.group = group.id
      if (group.id === selected?.id) button.setAttribute('aria-current', 'true')
      const count = makeElement('span', String(group.stages.length), 'group-count')
      count.setAttribute('aria-label', group.stages.length + ' 个独享关卡')
      const name = makeElement('span', '', 'group-label')
      const code = eventCode(group)
      if (code) name.append(makeElement('span', code, 'event-code'))
      name.append(makeElement('span', label(group)))
      button.append(name, count)
      button.addEventListener('click', () => {
        if (selected?.id === group.id) return
        selected = group
        saveSelection()
        showSelection()
      })
      fragment.append(button)
    }
    if (!matches.length) fragment.append(makeElement('p', '没有匹配的活动或章节。', 'empty'))
    $('groups').replaceChildren(fragment)
  }

  function renderRecords() {
    $('group-type').textContent = selected.story
    const code = eventCode(selected)
    $('group-title').textContent = code ? code + ' ' + label(selected) : label(selected)
    $('total').textContent = selected.stages.length
    const query = normalize(recordSearch.value)
    const modes = ['normal', 'challenge'].filter(mode => difficulty.value === 'all' || mode === difficulty.value)
    for (const header of document.querySelectorAll('thead [data-mode]')) header.hidden = !modes.includes(header.dataset.mode)
    const matches = selected.stages.filter(stage =>
      modes.some(mode => stage[mode].length) &&
      [stage.operation, stage.cn_name, ...modes.flatMap(mode => stage[mode])].some(value => normalize(value).includes(query))
    )
    $('result-count').textContent = '显示 ' + matches.length + ' / ' + selected.stages.length + ' 个关卡'
    const fragment = document.createDocumentFragment()
    for (const stage of matches) {
      const row = document.createElement('tr')
      const heading = document.createElement('th')
      heading.scope = 'row'
      const link = makeElement('a', stage.operation + ' ↗', 'stage-code')
      link.href = sourceLink + encodeURIComponent(stage.operation + '+' + stage.cn_name)
      link.target = '_blank'
      link.rel = 'noopener'
      const note = makeElement('a', '备注', 'stage-note')
      note.href = './notes.html?' + new URLSearchParams({ group: selected.id, operation: stage.operation, name: stage.cn_name })
      note.setAttribute('aria-label', stage.operation + ' 备注')
      link.title = stage.cn_name
      const stepValues = modes.filter(mode => stage[mode].length).map(mode => [mode, stage.steps?.[mode] ?? null])
      const sameSteps = stepValues.length && stepValues.every(([, steps]) => steps === stepValues[0][1])
      let stepsText = '步数未注明'
      if (sameSteps && stepValues[0][1] !== null) stepsText = stepValues[0][1] + '步'
      if (!sameSteps && stepValues.length > 1) {
        const names = { normal: '普通', challenge: '突袭' }
        stepsText = stepValues.filter(([, steps]) => steps !== null).map(([mode, steps]) => names[mode] + ' ' + steps + '步').join(' · ')
          || stepsText
      }
      heading.append(link, makeElement('span', stepsText, 'stage-steps'), note)
      row.append(heading)
      for (const mode of modes) {
        const cell = document.createElement('td')
        cell.dataset.mode = mode
        if (!stage[mode].length) cell.append(makeElement('span', '—', 'no-operator'))
        for (const operator of stage[mode]) cell.append(makeElement('span', operator, 'chip'))
        row.append(cell)
      }
      fragment.append(row)
    }
    $('records').replaceChildren(fragment)
    $('table-wrap').hidden = matches.length === 0
    $('empty').hidden = matches.length !== 0
    $('empty').textContent = selected.stages.length ? '没有符合当前筛选条件的关卡。' : '该活动或章节暂无解手流独享。'
  }

  const lastGroup = new Map()
  for (const button of tabButtons) {
    button.addEventListener('click', () => {
      const nextStory = button.dataset.story
      if (story === nextStory) return
      lastGroup.set(story, selected)
      story = nextStory
      selected = lastGroup.has(story) ? lastGroup.get(story) : preferredGroup(story === ACTIVITY ? activityYears.get(year) : mainGroups)
      groupSearch.value = ''
      saveSelection()
      updatePicker()
    })
  }
  for (const value of years) {
    const button = makeElement('button', yearLabel(value), 'year-button')
    button.type = 'button'
    button.dataset.year = value
    button.addEventListener('click', () => {
      if (value === year) return
      year = value
      selected = null
      groupSearch.value = ''
      saveSelection()
      updatePicker()
    })
    $('years').append(button)
  }
  groupSearch.addEventListener('input', renderGroups)
  recordSearch.addEventListener('input', renderRecords)
  difficulty.addEventListener('change', renderRecords)
  updatePicker()
})()
