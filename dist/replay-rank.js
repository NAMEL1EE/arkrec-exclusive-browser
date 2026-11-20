(() => {
  const $ = id => document.getElementById(id)
  const archive = window.ARKREC_REPLAY_HISTORY
  const replay = window.ARKREC_REPLAY_DAYS
  if (!replay) return
  const toggle = $('trend-replay')
  const scope = $('trend-scope')
  const closed = $('trend-include-closed')
  const race = $('trend-race')
  const rows = $('race-rows')
  const empty = $('race-empty')
  const dateLabel = $('race-date')
  const sourceLabel = $('race-source')
  const current = $('race-day')
  const start = $('race-start')
  const end = $('race-end')
  const previous = $('race-previous')
  const next = $('race-next')
  const play = $('race-play')
  const speed = $('race-speed')
  const speedValue = $('race-speed-value')
  const limit = $('race-limit')
  const reset = $('race-reset')
  const scale = $('race-scale')
  const eventScroll = $('race-event-scroll')
  const eventTrack = $('race-event-track')
  const eventLine = $('race-event-line')
  const eventProgress = $('race-event-progress')
  const eventCursor = $('race-event-cursor')
  const currentEvent = $('race-event-current')
  const defaultLimit = limit.defaultValue
  const defaultSpeed = speed.defaultValue

  const { first: archiveFirst, last: lastDay, isoDay } = replay
  const fromInput = value => Math.round(Date.parse(value) / 86_400_000)
  const number = new Intl.NumberFormat('zh-CN')
  const byName = new Intl.Collator('zh-CN')
  const firstDay = isoDay(archiveFirst)
  const finalDay = isoDay(lastDay)
  const sourceNames = { estimate: '历史估算', measured: '实测快照', carried: '沿用上一份实测快照' }

  const portraits = window.ARKREC_TREND_PORTRAITS
  const portraitIndices = new Map(portraits?.names.map((name, index) => [name, index]))
  const mounted = new Map()
  let frame
  let playing = false
  let canResume = false
  let lastTick = null
  let fraction = 0
  let selectedDay = archiveFirst
  let axisMaximum
  const axisIncrement = 50
  let cursorDay
  let activeEvent
  let scrubPointer
  let eventPoints = []
  const banners = window.ARKREC_REPLAY_BANNERS
  const events = (window.ARKREC_REPLAY_EVENTS ?? [])
    .map(([date, name, kind, banner]) => ({ date, day: fromInput(date), name, kind, banner }))
    .filter(({ day }) => day >= archiveFirst && day <= lastDay)

  function axisCeiling(value) {
    return Math.max(axisIncrement, Math.ceil(value / axisIncrement) * axisIncrement)
  }

  function updateScale(maximum) {
    if (axisMaximum === maximum) return
    axisMaximum = maximum
    const ticks = []
    for (let value = 0; value <= maximum; value += axisIncrement) {
      const label = make('span', '', number.format(value))
      label.style.left = value / maximum * 100 + '%'
      ticks.push(label)
    }
    scale.replaceChildren(...ticks)
    scale.setAttribute('aria-label', '独享数刻度，0 到 ' + maximum)
  }

  function setupEventAxis() {
    for (const event of events) {
      const button = make('button', 'trend-event-mark')
      button.type = 'button'
      button.title = event.date + ' · ' + event.kind + ' · ' + event.name
      button.setAttribute('aria-label', button.title)
      const art = make('span', 'trend-event-art')
      if (banners && event.banner !== undefined) {
        const column = event.banner % banners.columns
        const row = Math.floor(event.banner / banners.columns)
        art.style.backgroundImage = 'url(' + JSON.stringify(banners.file) + ')'
        art.style.backgroundSize = banners.columns * 100 + '% ' + banners.rows * 100 + '%'
        art.style.backgroundPosition = column / (banners.columns - 1) * 100 + '% ' + row / (banners.rows - 1) * 100 + '%'
      }
      button.append(art, make('span', 'trend-event-name', event.name))
      button.addEventListener('click', () => seek(event.day))
      event.button = button
      eventTrack.append(button)
    }
    eventLine.setAttribute('aria-valuemin', archiveFirst)
    eventLine.setAttribute('aria-valuemax', lastDay)
    function scrub(event) {
      const x = event.clientX - eventLine.getBoundingClientRect().left
      seek(Math.round(eventAxisValue(x, 'x', 'day')))
    }

    eventLine.addEventListener('pointerdown', event => {
      if (event.button !== 0 || !event.isPrimary || !eventPoints.length) return
      scrubPointer = event.pointerId
      eventLine.setPointerCapture(scrubPointer)
      scrub(event)
    })
    eventLine.addEventListener('pointermove', event => {
      if (event.pointerId === scrubPointer) scrub(event)
    })
    eventLine.addEventListener('lostpointercapture', event => {
      if (event.pointerId !== scrubPointer) return
      scrubPointer = undefined
      cursorDay = undefined
      updateEventAxis()
    })
    eventLine.addEventListener('keydown', event => {
      const day = {
        ArrowLeft: selectedDay - 1,
        ArrowDown: selectedDay - 1,
        ArrowRight: selectedDay + 1,
        ArrowUp: selectedDay + 1,
        Home: archiveFirst,
        End: lastDay
      }[event.key]
      if (day === undefined) return
      event.preventDefault()
      seek(day)
    })
    eventScroll.addEventListener('scroll', placeEventCursor)
    new ResizeObserver(layoutEventAxis).observe(eventScroll)
  }

  function layoutEventAxis() {
    const viewport = eventScroll.clientWidth
    if (!viewport) return
    const cardWidth = events[0]?.button.offsetWidth ?? 0
    const pixelsPerDay = 3.5
    const origin = viewport / 3
    let previous = { day: archiveFirst, x: origin }
    eventPoints = [previous]
    for (const [index, event] of events.entries()) {
      const gap = Math.max(index === 0 ? 0 : cardWidth + 24, (event.day - previous.day) * pixelsPerDay)
      const x = previous.x + gap
      event.button.style.left = x + 'px'
      previous = { day: event.day, x }
      if (event.day > eventPoints.at(-1).day) eventPoints.push(previous)
    }

    // Stop the track at the last banner. Dates after that use the remaining space inside the viewport.
    const edge = previous.x + cardWidth / 2
    if (previous.day < lastDay) {
      eventPoints.push({ day: lastDay, x: cardWidth ? edge : origin + (lastDay - archiveFirst) * pixelsPerDay })
    }
    eventTrack.style.width = Math.ceil(Math.max(edge, eventPoints.at(-1).x) + 5) + 'px'
    cursorDay = undefined
    updateEventAxis()
  }

  function eventAxisValue(value, input, output) {
    const first = eventPoints[0]
    if (value <= first[input]) return first[output]
    const index = eventPoints.findIndex(point => point[input] >= value)
    if (index < 0) return eventPoints.at(-1)[output]
    const before = eventPoints[index - 1]
    const after = eventPoints[index]
    const fraction = (value - before[input]) / (after[input] - before[input])
    return before[output] + fraction * (after[output] - before[output])
  }

  function placeEventCursor() {
    if (!eventPoints.length) return
    const x = eventAxisValue(selectedDay, 'day', 'x') - eventScroll.scrollLeft
    eventCursor.hidden = x < 0 || x >= eventScroll.clientWidth
    eventCursor.style.left = x + 'px'
  }

  function updateEventAxis() {
    const event = events.findLast(event => event.day <= selectedDay)
    if (event !== activeEvent) {
      activeEvent?.button.removeAttribute('aria-current')
      activeEvent = event
      activeEvent?.button.setAttribute('aria-current', 'date')
      currentEvent.textContent = event ? event.kind + ' · ' + event.name + ' · ' + event.date : '首开作战活动时间轴'
    }
    if (!eventPoints.length || cursorDay === selectedDay) return
    cursorDay = selectedDay
    const x = eventAxisValue(selectedDay, 'day', 'x')
    eventProgress.style.width = x + 'px'
    eventLine.setAttribute('aria-valuenow', selectedDay)
    eventLine.setAttribute('aria-valuetext', isoDay(selectedDay))
    if (scrubPointer === undefined) eventScroll.scrollLeft = x - eventScroll.clientWidth / 3
    placeEventCursor()
  }

  function updateLimit() {
    const mode = closed.checked ? 'includingClosed' : 'open'
    const key = scope.value
    const names = new Set(replay.samples.flatMap(sample => Object.keys(sample[mode][key])))
    names.delete('无需干员')
    limit.max = String(Math.max(Number(defaultLimit), names.size))
  }

  function make(tag, className, text) {
    const node = document.createElement(tag)
    if (className) node.className = className
    if (text) node.textContent = text
    return node
  }

  function createRow(name) {
    const row = make('button', 'trend-race-row')
    const avatar = make('span', 'trend-race-avatar')
    const index = portraitIndices.get(name)
    if (index !== undefined) {
      const size = 30
      avatar.style.backgroundImage = 'url(' + JSON.stringify(portraits.file) + ')'
      avatar.style.backgroundSize = portraits.columns * size + 'px auto'
      avatar.style.backgroundPosition = -(index % portraits.columns) * size + 'px ' + -Math.floor(index / portraits.columns) * size + 'px'
    }
    avatar.setAttribute('aria-hidden', 'true')
    avatar.title = name
    const track = make('span', 'trend-race-track')
    const fill = make('span', 'trend-race-fill')
    const count = make('strong', 'trend-race-count')
    row.style.setProperty('--bar-color', portraits?.colors?.[index] ?? '#61748c')
    fill.append(count)
    track.append(fill)
    row.append(track, avatar)
    row.type = 'button'
    row.addEventListener('click', () => {
      pause()
      window.ARKREC_OPEN_DETAILS?.(name)
    })
    return { row, fill, count }
  }

  function leadersAt(sample) {
    const mode = closed.checked ? 'includingClosed' : 'open'
    const counts = Object.entries(sample[mode][scope.value]).filter(([name, count]) => name !== '无需干员' && count > 0)
    const total = Math.min(Number(limit.max), Math.max(1, Math.trunc(Number(limit.value) || Number(defaultLimit))))
    return counts.sort(([a, av], [b, bv]) => bv - av || byName.compare(a, b)).slice(0, total)
  }

  function nextChange(day, last) {
    const mode = closed.checked ? 'includingClosed' : 'open'
    const initial = replay.samples[day - archiveFirst]
    const before = leadersAt(initial)
    const counts = initial[mode][scope.value]
    for (let candidate = day + 1; candidate < last; candidate += 1) {
      const sample = replay.samples[candidate - archiveFirst]
      if (sample[mode][scope.value] === counts) continue
      const after = leadersAt(sample)
      if (before.length !== after.length || after.some(([name, value], index) =>
        name !== before[index][0] || value !== before[index][1])) return candidate
    }
    return last
  }

  function render() {
    const sample = replay.samples[selectedDay - archiveFirst]
    const leaders = leadersAt(sample)
    const active = new Set(leaders.map(([name]) => name))
    const maximum = axisCeiling(leaders[0]?.[1] ?? 0)
    updateScale(maximum)
    for (const [name, entry] of mounted) entry.row.hidden = !active.has(name)
    for (const [rank, [name, count]] of leaders.entries()) {
      let entry = mounted.get(name)
      if (!entry) {
        entry = createRow(name)
        mounted.set(name, entry)
        rows.append(entry.row)
      }
      entry.row.hidden = false
      entry.row.style.transform = 'translateY(' + rank * 32 + 'px)'
      entry.row.style.zIndex = String(leaders.length - rank)
      entry.row.setAttribute('aria-label', '第 ' + (rank + 1) + ' 位，' + name + '，' + count + ' 项独享，查看当前明细')
      entry.fill.style.width = count / maximum * 100 + '%'
      entry.count.textContent = number.format(count)
    }

    rows.style.height = leaders.length * 32 + 'px'
    empty.hidden = leaders.length > 0

    current.value = isoDay(selectedDay)
    dateLabel.dateTime = current.value
    dateLabel.textContent = current.value.replaceAll('-', '/')
    sourceLabel.textContent = sourceNames[sample.source] + ' · ' + leaders.length + ' 位干员'
    previous.disabled = selectedDay <= archiveFirst
    next.disabled = selectedDay >= lastDay
    updateEventAxis()
  }

  function pause() {
    cancelAnimationFrame(frame)
    canResume = canResume || playing
    playing = false
    lastTick = null
    canResume = canResume && selectedDay < fromInput(end.value)
    play.textContent = canResume ? '继续播放' : '播放区间'
  }

  function showDay(day) {
    selectedDay = Math.min(lastDay, Math.max(archiveFirst, day))
    render()
  }

  function tick(timestamp) {
    if (!playing) return
    if (lastTick !== null) fraction += (timestamp - lastTick) * Number(speed.value) / 1_000
    lastTick = timestamp
    const steps = Math.floor(fraction)
    if (steps > 0) {
      fraction -= steps
      const last = fromInput(end.value)
      let day = selectedDay
      for (let i = 0; i < steps && day < last; i += 1) day = nextChange(day, last)
      showDay(day)
    }
    if (selectedDay >= fromInput(end.value)) pause()
    else frame = requestAnimationFrame(tick)
  }

  function seek(day) {
    pause()
    canResume = false
    fraction = 0
    if (Number.isFinite(day)) {
      cursorDay = undefined
      showDay(day)
    } else current.value = isoDay(selectedDay)
    play.textContent = '播放区间'
  }

  function updateRange(event) {
    pause()
    canResume = false
    fraction = 0
    const day = fromInput(event.target.value)
    event.target.value = Number.isFinite(day) ? isoDay(Math.min(lastDay, Math.max(archiveFirst, day)))
      : event.target === start ? firstDay : finalDay
    if (start.value > end.value) (event.target === start ? end : start).value = event.target.value
    play.textContent = '播放区间'
  }

  function refreshRace() {
    if (!toggle.checked) return
    pause()
    updateLimit()
    render()
  }

  for (const field of [start, end, current]) {
    field.min = firstDay
    field.max = finalDay
  }
  setupEventAxis()
  start.value = firstDay
  end.value = finalDay
  start.addEventListener('change', updateRange)
  end.addEventListener('change', updateRange)
  play.addEventListener('click', () => {
    if (playing) return pause()
    const first = fromInput(start.value)
    const last = fromInput(end.value)
    if (!canResume || selectedDay < first || selectedDay >= last) {
      fraction = 0
      showDay(first)
    }
    if (first === last) return
    playing = true
    lastTick = null
    play.textContent = '暂停'
    frame = requestAnimationFrame(tick)
  })
  current.addEventListener('change', () => seek(fromInput(current.value)))
  previous.addEventListener('click', () => seek(selectedDay - 1))
  next.addEventListener('click', () => seek(selectedDay + 1))
  document.addEventListener('visibilitychange', () => { if (document.hidden && playing) pause() })
  scope.addEventListener('change', refreshRace)
  closed.addEventListener('change', refreshRace)
  limit.addEventListener('input', () => {
    if (limit.validity.valid && limit.value !== '') render()
  })
  limit.addEventListener('change', () => {
    const value = Number(limit.value)
    limit.value = String(Math.min(Number(limit.max), Math.max(1, Math.trunc(value || Number(defaultLimit)))))
    render()
  })

  function updateSpeed() {
    speedValue.textContent = speed.value + ' 次变化/秒'
    speed.setAttribute('aria-valuetext', speedValue.textContent)
  }

  speed.addEventListener('input', () => {
    lastTick = null
    updateSpeed()
  })
  reset.addEventListener('click', () => {
    start.value = firstDay
    end.value = finalDay
    speed.value = defaultSpeed
    limit.value = defaultLimit
    updateSpeed()
    seek(archiveFirst)
  })
  updateSpeed()

  function showMode() {
    const enabled = toggle.checked
    $('trend-recent-chart').hidden = enabled
    $('trend-recent-granularity').hidden = enabled
    $('trend-picker').hidden = enabled
    if (enabled) $('trend-show-changes').hidden = true
    $('trend-caption').hidden = enabled
    const note = $('trend-replay-note')
    note.hidden = !enabled
    race.hidden = !enabled
    if (enabled) {
      note.textContent = '按北京时间逐日回算，缓存覆盖 ' + number.format(archive.inputs) + ' / ' + number.format(archive.total)
        + ' 条投稿。未见新纪录的日期沿用前值，开放活动按当前名单筛选。'
      refreshRace()
    } else {
      pause()
    }
  }
  toggle.addEventListener('change', showMode)
  $('trend-replay-option').hidden = false
  showMode()
})()
