(() => {
  const data = window.ARKREC_SNAPSHOT
  const $ = id => document.getElementById(id)
  if (data?.schema !== 1 || data.flow !== '解手流' || !Array.isArray(data.groups) || !data.groups.length) {
    $('error').hidden = false
    return
  }

  const ACTIVITY = '活动关卡'
  const MAIN = '主线关卡'
  const modeNames = { normal: '普通', challenge: '突袭', sandbox: '沙盘 2 级' }
  const groupSearch = $('group-search')
  const stepsToggle = $('steps-toggle')
  const overview = $('group-steps')
  const compactPicker = matchMedia('(max-width: 760px)')
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
  const displayLabel = group => [eventCode(group), label(group)].filter(Boolean).join(' ')
  const yearOf = group => Number.isFinite(Date.parse(group.release)) ? formatYear.format(new Date(group.release)) : ''
  const yearLabel = year => year ? year + ' 年' : '年份待定'
  const formatDeadline = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  })
  const activities = data.groups.filter(group => group.story === ACTIVITY && group.stages.length > 0)
  const activityYears = new Map()
  for (const group of activities) {
    const year = yearOf(group)
    if (!activityYears.has(year)) activityYears.set(year, [])
    activityYears.get(year).push(group)
  }
  const years = [...activityYears.keys()].sort((left, right) => right.localeCompare(left))
  const mainGroups = data.groups.filter(group => group.story === MAIN)
  const searchGroups = [...activities, ...mainGroups]
  const preferredGroup = groups => groups?.find(group => group.stages.length) ?? groups?.[0] ?? null
  const savedGroup = data.groups.find(group => group.id === params.get('group'))
  const savedYear = params.get('year')
  let selected = savedGroup ?? (activityYears.has(savedYear) ? null : preferredGroup(activityYears.get(years[0])))
  let pickerExpanded = !selected
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

  function renderActiveActivities() {
    const schedule = window.ARKREC_EVENT_SCHEDULE ?? []
    const byName = new Map(data.groups.filter(group => group.story === ACTIVITY)
      .map(group => [normalize(group.episode), group]))
    const open = document.createDocumentFragment()
    const upcoming = document.createDocumentFragment()
    const shown = new Set()
    const now = Date.now()
    let nextChange = Infinity
    const entries = schedule.filter(event => (event.end + 1) * 1000 > now)
      .sort((a, b) => Number(a.start * 1000 > now) - Number(b.start * 1000 > now) || a.start - b.start)
    for (const { name, start, end, rerun, noticeId } of entries) {
      const group = byName.get(normalize(name))
      const future = start * 1000 > now
      if (!group || (future && !(rerun && noticeId))) continue
      nextChange = Math.min(nextChange, (future ? start : end + 1) * 1000)
      if (shown.has(group.id)) continue
      shown.add(group.id)

      const link = makeElement('a', '', 'active-activity-link')
      link.href = '#' + new URLSearchParams({ group: group.id })
      const title = makeElement('span', '', 'group-label')
      const code = eventCode(group)
      if (code) title.append(makeElement('span', code, 'event-code'))
      title.append(makeElement('strong', group.episode + (rerun && !group.episode.endsWith('复刻') ? '·复刻' : '')))
      const time = (future ? start : end) * 1000
      const date = makeElement('time', (future ? '关卡预计开放 ' : '关卡开放至 ') + formatDeadline.format(time), 'active-activity-deadline')
      date.dateTime = new Date(time).toISOString()
      const arrow = makeElement('span', '→', 'active-activity-arrow')
      arrow.setAttribute('aria-hidden', 'true')
      link.append(title, date, arrow)
      link.addEventListener('click', event => {
        if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return
        event.preventDefault()
        groupSearch.value = ''
        selectGroup(group, null, true)
      })
      const list = future ? upcoming : open
      list.append(link)
    }
    $('active-activities').hidden = !open.childElementCount
    $('upcoming-activities').hidden = !upcoming.childElementCount
    $('active-activity-list').replaceChildren(open)
    $('upcoming-activity-list').replaceChildren(upcoming)
    if (Number.isFinite(nextChange)) setTimeout(renderActiveActivities, Math.min(nextChange - now, 2_147_483_647))
  }

  function renderOverview(group) {
    const stages = group.overview ?? []
    stepsToggle.hidden = !stages.length
    setOverviewExpanded(false)
    if (!stages.length) return

    const modes = Object.keys(modeNames).filter(mode => stages.some(stage => appliesTo(stage, mode)))
    const headers = ['关卡', ...modes.map(mode => modeNames[mode])].map(label => {
      const heading = makeElement('th', label)
      heading.scope = 'col'
      return heading
    })
    $('overview-head').replaceChildren(...headers)

    const fragment = document.createDocumentFragment()
    for (const stage of stages) {
      const row = makeStageRow(stage)
      const heading = document.createElement('th')
      heading.scope = 'row'
      heading.append(makeStageLink(stage))
      row.append(heading)
      for (const mode of modes) {
        const count = stage.steps?.[mode]
        const applies = appliesTo(stage, mode)
        const cell = makeElement('td', Number.isInteger(count) ? count + '步' : applies ? '暂无' : '—')
        if (!applies) cell.setAttribute('aria-label', '无' + modeNames[mode] + '难度')
        markSharedStep(cell, stage, mode)
        row.append(cell)
      }
      fragment.append(row)
    }
    $('overview-body').replaceChildren(fragment)
  }

  function setOverviewExpanded(expanded) {
    overview.hidden = !expanded
    stepsToggle.setAttribute('aria-expanded', String(expanded))
  }

  function makeStageRow(stage) {
    const row = document.createElement('tr')
    row.dataset.operation = stage.operation
    row.dataset.stageName = stage.cn_name
    return row
  }

  function makeStageLink(stage) {
    const link = makeElement('a', stage.operation + ' ↗', 'stage-code')
    link.href = sourceLink + encodeURIComponent(stage.operation + '+' + stage.cn_name)
    link.target = '_blank'
    link.rel = 'noopener'
    link.title = stage.cn_name
    link.setAttribute('aria-label', stage.operation + ' ' + stage.cn_name + '（少人 Wiki）')
    return link
  }

  function markSharedStep(element, stage, mode) {
    const source = stage.steps?.[mode + 'Shared']
    if (source) element.title = '采用' + modeNames[source] + '通用解'
  }

  function appliesTo(stage, mode) {
    if (mode === 'normal' || Number.isInteger(stage.steps?.[mode])) return true
    return mode === 'challenge' ? stage.hasChallenge : stage.hasSandbox
  }

  function updatePickerDisclosure() {
    const body = $('picker-body')
    const toggle = $('picker-toggle')
    body.hidden = compactPicker.matches && !pickerExpanded
    toggle.setAttribute('aria-expanded', String(!body.hidden))
    $('picker-current').textContent = selected ? displayLabel(selected) : story === ACTIVITY ? '选择活动' : '选择主线章节'
    $('picker-action').textContent = body.hidden ? '切换 ▾' : '收起 ▴'
  }

  function showSelection() {
    updatePickerDisclosure()
    for (const button of $('years').querySelectorAll('[data-year]')) {
      button.setAttribute('aria-pressed', String(button.dataset.year === year))
    }
    const results = $('results')
    const prompt = $('selection-prompt')
    results.hidden = !selected
    prompt.hidden = Boolean(selected)
    if (selected) {
      renderOverview(selected)
      renderRecords()
    } else {
      prompt.textContent = '请选择活动查看独享。'
    }
    for (const button of $('groups').querySelectorAll('[data-group]')) {
      if (button.dataset.group === selected?.id) button.setAttribute('aria-current', 'true')
      else button.removeAttribute('aria-current')
    }
  }

  function updatePicker() {
    for (const button of tabButtons) button.setAttribute('aria-pressed', String(button.dataset.story === story))
    renderGroups()
    showSelection()
  }

  function renderGroups() {
    const input = groupSearch.value.normalize('NFKC').toLowerCase().replace(/\s+/g, '')
    const query = normalize(input)
    $('years').hidden = story !== ACTIVITY || Boolean(query)
    const groups = query ? searchGroups : story === ACTIVITY ? activityYears.get(year) ?? [] : mainGroups
    const matches = groups.filter(group =>
      normalize(label(group)).includes(query)
      || Boolean(eventCode(group)?.toLowerCase().includes(query))
      || (group.chapter !== null && String(group.chapter) === query)
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
      button.addEventListener('click', () => selectGroup(group, null, Boolean(query)))
      fragment.append(button)
    }
    if (query) {
      const stages = stageMatches(groups, input, query)
      for (const { group, stage } of stages) {
        const button = makeElement('button', '', 'group-button stage-choice')
        button.type = 'button'
        const name = makeElement('span', '', 'group-label')
        name.append(makeElement('span', stage.operation, 'event-code'), makeElement('span', stage.cn_name))
        const location = group.story === ACTIVITY ? group.episode + ' · ' + yearLabel(yearOf(group)) : label(group)
        button.append(name, makeElement('span', location, 'stage-location'))
        button.addEventListener('click', () => selectGroup(group, stage))
        fragment.append(button)
      }
    }
    if (!fragment.childElementCount) {
      fragment.append(makeElement('p', '没有匹配的活动、章节或关卡。', 'empty'))
    }
    $('groups').replaceChildren(fragment)
  }

  function stageMatches(groups, input, query) {
    const separated = /^[a-z]*\d+-\d*$/u.test(input)
    const matches = groups.flatMap(group => {
      const main = group.story === MAIN
      const prefix = main && separated ? input : query
      const anchored = main && (separated || /^\d/.test(query))
      return (group.overview ?? group.stages).flatMap(stage => {
        const code = main && separated ? stage.operation.toLowerCase() : normalize(stage.operation)
        const codeMatches = anchored ? code.startsWith(prefix) : code.includes(prefix)
        const nameMatches = !separated && normalize(stage.cn_name).includes(query)
        return codeMatches || nameMatches ? [{ group, stage, exact: code === prefix }] : []
      })
    })
    const exact = matches.filter(match => match.exact)
    return exact.length ? exact : matches
  }

  function selectGroup(group, stage, reveal = false) {
    const previousYear = year
    const previousStory = story
    if (previousStory !== group.story) lastGroup.set(previousStory, selected)
    selected = group
    story = group.story
    if (story === ACTIVITY) year = yearOf(group)
    saveSelection()
    if (compactPicker.matches) pickerExpanded = false
    if (reveal || previousStory !== story || previousYear !== year) updatePicker()
    else showSelection()
    if (stage) focusStage(stage)
    else if (reveal) {
      $('group-title').focus({ preventScroll: true })
      $('results').scrollIntoView({ block: 'start' })
    } else if (compactPicker.matches) $('picker-toggle').focus({ preventScroll: true })
  }

  function focusStage(stage) {
    const isStage = row => row.dataset.operation === stage.operation && row.dataset.stageName === stage.cn_name
    let row = [...$('records').rows].find(isStage)
    if (!row) {
      row = [...$('overview-body').rows].find(isStage)
      if (!row) return
      setOverviewExpanded(true)
    }
    row.tabIndex = -1
    row.focus({ preventScroll: true })
    row.scrollIntoView({ block: 'nearest' })
  }

  function renderRecords() {
    $('group-type').textContent = selected.story
    $('group-title').textContent = displayLabel(selected)
    $('total').textContent = selected.stages.length
    const modes = Object.keys(modeNames).filter(mode => mode !== 'sandbox' || selected.runeStages?.length)
    for (const header of document.querySelectorAll('#table-wrap thead [data-mode]')) header.hidden = !modes.includes(header.dataset.mode)
    const fragment = document.createDocumentFragment()
    for (const stage of selected.stages) {
      const row = makeStageRow(stage)
      const heading = document.createElement('th')
      heading.scope = 'row'
      const link = makeStageLink(stage)
      const note = makeElement('a', '备注', 'stage-note')
      note.href = './notes.html?' + new URLSearchParams({ group: selected.id, operation: stage.operation, name: stage.cn_name })
      note.setAttribute('aria-label', stage.operation + ' 备注')
      heading.append(link, note)
      row.append(heading)
      for (const mode of modes) {
        const cell = document.createElement('td')
        cell.dataset.mode = mode
        const entries = stage[mode] ?? []
        if (!entries.length) cell.append(makeElement('span', '—', 'no-operator'))
        for (const operator of entries) cell.append(makeElement('span', operator, 'chip'))
        row.append(cell)
      }
      fragment.append(row)
    }
    $('records').replaceChildren(fragment)
    $('table-wrap').hidden = !selected.stages.length
    $('empty').hidden = Boolean(selected.stages.length)
  }

  const lastGroup = new Map()
  for (const button of tabButtons) {
    button.addEventListener('click', () => {
      const nextStory = button.dataset.story
      if (story === nextStory) return
      lastGroup.set(story, selected)
      story = nextStory
      selected = lastGroup.has(story) ? lastGroup.get(story) : preferredGroup(story === ACTIVITY ? activityYears.get(year) : mainGroups)
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
      pickerExpanded = true
      groupSearch.value = ''
      saveSelection()
      updatePicker()
    })
    $('years').append(button)
  }
  compactPicker.addEventListener('change', updatePickerDisclosure)
  $('picker-toggle').addEventListener('click', () => {
    pickerExpanded = !pickerExpanded
    updatePickerDisclosure()
  })
  stepsToggle.addEventListener('click', () => setOverviewExpanded(overview.hidden))
  groupSearch.addEventListener('input', renderGroups)
  updatePicker()
  renderActiveActivities()
})()
