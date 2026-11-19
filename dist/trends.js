(() => {
  const $ = id => document.getElementById(id)
  const history = window.ARKREC_SNAPSHOT?.wikiExclusiveHistory?.samples ?? []
  if (!history.length) return

  const scope = $('trend-scope')
  const includeClosed = $('trend-include-closed')
  const granularity = $('trend-granularity')
  const picker = $('trend-picker')
  const search = $('trend-search')
  const choices = $('trend-choices')
  const position = $('trend-position')
  const readout = $('trend-readout')
  const legend = $('trend-legend')
  const canvas = $('trend-canvas')
  const context = canvas.getContext('2d')
  const zoomTools = $('trend-zoom-tools')
  const boxButton = $('trend-box-zoom')
  const zoomIn = $('trend-zoom-in')
  const zoomOut = $('trend-zoom-out')
  const zoomReset = $('trend-zoom-reset')
  const zoomHint = $('trend-zoom-hint')
  const portraits = window.ARKREC_TREND_PORTRAITS
  const portraitIndices = new Map(portraits?.names.map((name, index) => [name, index]))
  let avatarSheet

  const format = options => new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', ...options })
  const calendarDay = format({ year: 'numeric', month: 'numeric', day: 'numeric' })
  const dateTime = format({ year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
  const year = format({ year: 'numeric' })
  const shortDate = format({ year: '2-digit', month: 'numeric', day: 'numeric' })
  const day = format({ month: 'numeric', day: 'numeric' })
  const time = format({ hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
  const number = new Intl.NumberFormat('zh-CN')
  const deltaNumber = new Intl.NumberFormat('zh-CN', { signDisplay: 'exceptZero' })
  const byName = new Intl.Collator('zh-CN')
  const colors = [
    '#175fb4', '#b53b42', '#067b6b', '#8048a8', '#b26209',
    '#217692', '#8f4266', '#466127', '#344dab', '#a4481f',
    '#0c777e', '#ad3d85', '#4e6c14', '#7956ca', '#82611c',
    '#167145', '#536f9a', '#632e72', '#b64a5a', '#126292',
  ]
  const latest = history.at(-1)
  const names = new Set()
  const days = new Map()
  for (const sample of history) {
    days.set(calendarDay.format(new Date(sample.at)), sample)
    for (const name of Object.keys(sample.includingClosed.all)) names.add(name)
  }

  let daily = true
  let ranked = []
  let selection = new Set()
  let showingTop = true
  let highlighted = null
  let points = []
  let series = []
  let fullView
  let view
  let plot
  let boxMode = false
  let drag = null
  let legendRows = []
  let choiceInputs = []

  function count(sample, name) {
    const mode = includeClosed.checked ? sample.includingClosed : sample.open
    return mode[scope.value][name] ?? 0
  }

  function topNames() {
    return ranked.filter(name => count(latest, name) > 0).slice(0, 20)
  }

  function element(tag, className, text) {
    const node = document.createElement(tag)
    if (className) node.className = className
    if (text !== undefined) node.textContent = text
    return node
  }

  function rankOperators() {
    ranked = [...names].sort((a, b) => count(latest, b) - count(latest, a) || byName.compare(a, b))
    if (showingTop) selection = new Set(topNames())
    renderChoices()
    renderSelection()
  }

  function renderChoices() {
    const query = search.value.trim().toLocaleLowerCase('zh-CN')
    choiceInputs = ranked.filter(name => name.toLocaleLowerCase('zh-CN').includes(query)).map(name => {
      const label = element('label', 'trend-choice')
      const input = element('input')
      input.type = 'checkbox'
      input.value = name
      input.checked = selection.has(name)
      label.append(input, element('span', '', name), element('small', '', number.format(count(latest, name))))
      return { label, input }
    })
    choices.replaceChildren(...choiceInputs.map(({ label }) => label))
    $('trend-search-empty').hidden = choiceInputs.length > 0
  }

  function refreshTimeline() {
    daily = granularity.value === 'day'
    const samples = daily ? [...days.values()] : history
    points = samples.map(sample => {
      const timestamp = Date.parse(sample.at)
      const x = daily ? Math.floor((timestamp + 28_800_000) / 86_400_000) : timestamp
      return { date: new Date(timestamp), sample, x }
    })
    $('trend-caption').textContent = daily
      ? '按北京时间取每天的最新快照。' + (points.length === 1 ? '目前已记录 1 天。' : '')
      : '按北京时间显示已保存的更新快照。'
    renderSelection(points.length - 1)
  }

  function renderSelection(index = Number(position.value)) {
    for (const { input } of choiceInputs) input.checked = selection.has(input.value)
    $('trend-picker-summary').textContent = '干员 · 已选 ' + selection.size
    series = ranked.filter(name => selection.has(name)).map((name, index) => ({
      name,
      color: colors[index % colors.length],
      values: points.map(({ sample }) => count(sample, name)),
    }))
    if (!selection.has(highlighted)) highlighted = null
    canvas.hidden = !series.length
    legend.hidden = !series.length
    $('trend-no-selection').hidden = series.length > 0

    legendRows = series.map(({ name, color }) => {
      const item = element('li')
      const button = element('button', 'trend-legend-item')
      const swatch = element('span', 'trend-swatch')
      swatch.style.backgroundColor = color
      swatch.setAttribute('aria-hidden', 'true')
      const value = element('strong', 'trend-value')
      const delta = element('small', 'trend-delta')
      button.type = 'button'
      button.title = name + '，点击切换高亮'
      button.addEventListener('click', () => {
        highlighted = highlighted === name ? null : name
        renderPoint()
      })
      button.append(swatch, element('span', 'trend-name', name), value, delta)
      item.append(button)
      return { name, item, button, value, delta }
    })
    legend.replaceChildren(...legendRows.map(({ item }) => item))
    const highest = series.reduce((max, line) => line.values.reduce((value, count) => Math.max(value, count), max), 1)
    const step = axisStep(highest)
    fullView = { first: 0, last: points.length - 1, low: 0, high: Math.ceil(highest / step) * step }
    plot = null
    stopBoxSelection()
    setView(fullView, index)
  }

  function axisStep(range) {
    const target = Math.max(1, range / 5)
    const power = 10 ** Math.floor(Math.log10(target))
    return [1, 2, 5, 10].find(step => step * power >= target) * power
  }

  const clamp = (value, low, high) => Math.min(high, Math.max(low, value))

  function setView(next, index = Number(position.value)) {
    view = next
    position.min = String(view.first)
    position.max = String(view.last)
    position.value = String(clamp(index, view.first, view.last))
    position.hidden = !series.length || view.first === view.last
    renderZoomControls()
    renderPoint()
  }

  function renderZoomControls() {
    const verticalZoom = view.low !== fullView.low || view.high !== fullView.high
    const timeZoom = view.first !== fullView.first || view.last !== fullView.last
    zoomTools.hidden = !series.length
    boxButton.setAttribute('aria-pressed', String(boxMode))
    canvas.classList.toggle('box-zoom', boxMode)
    zoomIn.disabled = view.high - view.low <= 2
    zoomOut.disabled = !verticalZoom
    zoomReset.disabled = !verticalZoom && !timeZoom && !boxMode
    zoomHint.hidden = !series.length || (!boxMode && !verticalZoom && !timeZoom)
    zoomHint.textContent = boxMode
      ? '在图内拖动框选，松开即可放大。'
      : '当前独享数范围 ' + number.format(view.low) + '–' + number.format(view.high) + ' 项'
  }

  function stopBoxSelection() {
    const pointerId = drag?.pointerId
    drag = null
    boxMode = false
    if (pointerId != null && canvas.hasPointerCapture(pointerId)) canvas.releasePointerCapture(pointerId)
  }

  function zoomVertical(factor) {
    const span = clamp(Math.round((view.high - view.low) * factor), Math.min(2, fullView.high), fullView.high)
    const line = series.find(item => item.name === highlighted)
    const fullHeight = view.low === fullView.low && view.high === fullView.high
    const focus = line?.values[Number(position.value)] ?? (fullHeight ? view.low : (view.low + view.high) / 2)
    const center = clamp(focus, view.low, view.high)
    const low = clamp(Math.round(center - span / 2), fullView.low, fullView.high - span)
    stopBoxSelection()
    setView({ ...view, low, high: low + span })
  }

  function renderPoint() {
    const index = Number(position.value)
    const { date } = points[index]
    const label = (daily ? calendarDay : dateTime).format(date)
    readout.textContent = label
    position.setAttribute('aria-valuetext', label)
    for (const [lineIndex, { name, button, value, delta }] of legendRows.entries()) {
      const values = series[lineIndex].values
      value.textContent = number.format(values[index])
      const change = index > 0 ? values[index] - values[index - 1] : 0
      delta.hidden = change === 0
      delta.textContent = deltaNumber.format(change)
      delta.dataset.direction = change > 0 ? 'up' : 'down'
      button.setAttribute('aria-pressed', String(highlighted === name))
    }
    drawChart()
  }

  function drawChart() {
    if (!context || !series.length) return
    const width = canvas.clientWidth
    const height = canvas.clientHeight
    if (!width || !height) return
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2)
    canvas.width = Math.round(width * pixelRatio)
    canvas.height = Math.round(height * pixelRatio)
    context.scale(pixelRatio, pixelRatio)

    const left = 39
    const right = width - 16
    const top = 16
    const bottom = height - 32
    const { first, last, low, high } = view
    const range = high - low
    const interval = axisStep(range)
    const yFor = value => bottom - (bottom - top) * (value - low) / range
    const startX = points[first].x
    const span = points[last].x - startX
    const xFor = index => span ? left + (right - left) * (points[index].x - startX) / span : (left + right) / 2
    plot = { left, right, top, bottom, xFor }
    const index = Number(position.value)

    context.font = '12px system-ui'
    context.textBaseline = 'middle'
    context.textAlign = 'right'
    context.fillStyle = '#4c5f77'
    context.strokeStyle = '#dbe4f0'
    for (let value = Math.ceil(low / interval) * interval; value <= high; value += interval) {
      const y = yFor(value)
      context.beginPath()
      context.moveTo(left, y)
      context.lineTo(right, y)
      context.stroke()
      context.fillText(number.format(value), left - 8, y)
    }

    const tickCount = Math.min(last - first + 1, width < 470 ? 3 : 6)
    const start = points[first].date
    const end = points[last].date
    let dateLabel = day
    if (!daily && calendarDay.format(start) === calendarDay.format(end)) dateLabel = time
    else if (year.format(start) !== year.format(end)) dateLabel = shortDate
    let previousTick = -Infinity
    for (let tick = 0; tick < tickCount; tick += 1) {
      const tickIndex = first + Math.round(tick * (last - first) / Math.max(1, tickCount - 1))
      const x = xFor(tickIndex)
      const interior = tick > 0 && tick < tickCount - 1
      if (interior && (x - previousTick < 62 || right - x < 62)) continue
      context.textAlign = tickCount === 1 ? 'center' : tick === 0 ? 'left' : tick === tickCount - 1 ? 'right' : 'center'
      context.fillText(dateLabel.format(points[tickIndex].date), x, bottom + 17)
      previousTick = x
    }

    context.strokeStyle = '#aebfd5'
    context.setLineDash([3, 4])
    context.beginPath()
    context.moveTo(xFor(index), top)
    context.lineTo(xFor(index), bottom)
    context.stroke()
    context.setLineDash([])

    context.save()
    context.beginPath()
    context.rect(left, top, right - left, bottom - top)
    context.clip()

    const zoomed = view.low !== fullView.low || view.high !== fullView.high
      || first !== fullView.first || last !== fullView.last
    if (zoomed && portraits && !avatarSheet) {
      avatarSheet = new Image()
      avatarSheet.addEventListener('load', drawChart, { once: true })
      avatarSheet.src = portraits.file
    }
    const showPortraits = zoomed && avatarSheet?.naturalWidth
    const markers = []
    const activeLine = series.find(({ name }) => name === highlighted)
    for (const line of series) {
      if (line !== activeLine) drawLine(line, Boolean(activeLine))
    }
    if (activeLine) drawLine(activeLine, false)
    drawPortraits(markers, plot)

    if (drag) {
      const width = drag.end.x - drag.start.x
      const height = drag.end.y - drag.start.y
      context.fillStyle = '#2869bd29'
      context.strokeStyle = '#2869bd'
      context.lineWidth = 1
      context.fillRect(drag.start.x, drag.start.y, width, height)
      context.strokeRect(drag.start.x, drag.start.y, width, height)
    }
    context.restore()

    function drawLine({ name, color, values }, muted) {
      context.globalAlpha = muted ? 0.16 : 1
      context.strokeStyle = color
      context.fillStyle = color
      context.lineWidth = activeLine && !muted ? 3 : 2
      context.lineJoin = 'round'
      context.beginPath()
      for (let i = first; i <= last; i += 1) context.lineTo(xFor(i), yFor(values[i]))
      context.stroke()

      const x = xFor(index)
      const y = yFor(values[index])
      const portraitIndex = portraitIndices.get(name)
      if (showPortraits && portraitIndex !== undefined && y >= top && y <= bottom) {
        markers.push({ x, y, color, portraitIndex, muted, focused: name === highlighted })
      } else {
        drawDot(x, y, activeLine && !muted ? 5 : 3.3)
      }
      context.globalAlpha = 1
    }
  }

  function drawDot(x, y, radius) {
    context.beginPath()
    context.arc(x, y, radius, 0, Math.PI * 2)
    context.fill()
  }

  function drawPortraits(markers, { left, right, top, bottom }) {
    if (!markers.length) return
    const radius = 12
    const spacing = 2 * radius + 4
    const inset = radius + 2
    const placed = []

    function positions(origin, low, high) {
      const start = clamp(origin, low, high)
      const candidates = [start]
      for (let offset = spacing; start - offset >= low || start + offset <= high; offset += spacing) {
        if (start - offset >= low) candidates.push(start - offset)
        if (start + offset <= high) candidates.push(start + offset)
      }
      return candidates
    }

    for (const marker of markers.sort((a, b) => Number(b.focused) - Number(a.focused))) {
      const xs = positions(marker.x, left + inset, right - inset)
      const ys = positions(marker.y, top + inset, bottom - inset)
      let best
      let bestDistance = Infinity
      for (const y of ys) {
        for (const x of xs) {
          const distance = Math.abs(x - marker.x) + 2 * Math.abs(y - marker.y)
          if (distance >= bestDistance || placed.some(item => Math.hypot(item.x - x, item.y - y) < spacing)) continue
          best = { x, y, marker }
          bestDistance = distance
        }
      }
      if (best) placed.push(best)
      else {
        context.fillStyle = marker.color
        drawDot(marker.x, marker.y, 3.3)
      }
    }

    context.lineWidth = 1
    for (const { x, y, marker } of placed) {
      if (x === marker.x && y === marker.y) continue
      context.globalAlpha = marker.muted ? 0.25 : 0.7
      context.strokeStyle = marker.color
      context.fillStyle = marker.color
      context.beginPath()
      context.moveTo(marker.x, marker.y)
      context.lineTo(x, y)
      context.stroke()
      drawDot(marker.x, marker.y, 2.2)
    }

    const { columns, cell } = portraits
    for (const { x, y, marker } of placed) {
      const sourceX = marker.portraitIndex % columns * cell
      const sourceY = Math.floor(marker.portraitIndex / columns) * cell
      context.save()
      context.globalAlpha = marker.muted ? 0.32 : 1
      context.beginPath()
      context.arc(x, y, radius, 0, Math.PI * 2)
      context.clip()
      context.drawImage(avatarSheet, sourceX, sourceY, cell, cell, x - radius, y - radius, radius * 2, radius * 2)
      context.restore()
      context.globalAlpha = marker.muted ? 0.32 : 1
      context.strokeStyle = marker.color
      context.lineWidth = marker.focused ? 2.5 : 1.5
      context.beginPath()
      context.arc(x, y, radius, 0, Math.PI * 2)
      context.stroke()
    }
    context.globalAlpha = 1
  }

  function nearestPoint(x) {
    let first = view.first
    let last = view.last
    while (first < last) {
      const middle = Math.floor((first + last) / 2)
      if (x > (plot.xFor(middle) + plot.xFor(middle + 1)) / 2) first = middle + 1
      else last = middle
    }
    return first
  }

  function choosePoint(event) {
    if (!plot) return
    const x = event.clientX - canvas.getBoundingClientRect().left
    const index = nearestPoint(x)
    if (Number(position.value) === index) return
    position.value = String(index)
    renderPoint()
  }

  function chartLocation(event) {
    const bounds = canvas.getBoundingClientRect()
    return {
      x: clamp(event.clientX - bounds.left, plot.left, plot.right),
      y: clamp(event.clientY - bounds.top, plot.top, plot.bottom),
    }
  }

  function boxView(start, end) {
    const next = { ...view }
    if (Math.abs(start.x - end.x) >= 12) {
      next.first = nearestPoint(Math.min(start.x, end.x))
      next.last = nearestPoint(Math.max(start.x, end.x))
    }
    if (Math.abs(start.y - end.y) >= 12) {
      const valueAt = y => view.low + (plot.bottom - y) * (view.high - view.low) / (plot.bottom - plot.top)
      const minimumSpan = Math.min(2, view.high - view.low)
      next.low = clamp(Math.floor(valueAt(Math.max(start.y, end.y))), view.low, view.high - minimumSpan)
      next.high = clamp(Math.ceil(valueAt(Math.min(start.y, end.y))), next.low + minimumSpan, view.high)
    }
    return next
  }

  canvas.addEventListener('pointerdown', event => {
    if (!boxMode || !plot || !event.isPrimary || event.button !== 0) return
    const start = chartLocation(event)
    drag = { start, end: start, pointerId: event.pointerId }
    canvas.setPointerCapture(event.pointerId)
  })
  canvas.addEventListener('pointermove', event => {
    if (drag?.pointerId === event.pointerId) {
      drag.end = chartLocation(event)
      drawChart()
    } else if (!boxMode && event.pointerType !== 'touch') choosePoint(event)
  })
  canvas.addEventListener('pointerup', event => {
    if (drag?.pointerId !== event.pointerId) {
      if (!boxMode && event.isPrimary && event.button === 0) choosePoint(event)
      return
    }
    const next = boxView(drag.start, chartLocation(event))
    stopBoxSelection()
    setView(next)
  })
  canvas.addEventListener('lostpointercapture', event => {
    if (drag?.pointerId !== event.pointerId) return
    drag = null
    drawChart()
  })
  boxButton.addEventListener('click', () => {
    if (boxMode) stopBoxSelection()
    else boxMode = true
    renderZoomControls()
    drawChart()
  })
  zoomIn.addEventListener('click', () => zoomVertical(0.6))
  zoomOut.addEventListener('click', () => zoomVertical(1.75))
  zoomReset.addEventListener('click', () => {
    stopBoxSelection()
    setView(fullView)
  })
  zoomTools.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !boxMode) return
    stopBoxSelection()
    renderZoomControls()
    drawChart()
  })
  position.addEventListener('input', renderPoint)
  granularity.addEventListener('change', refreshTimeline)
  scope.addEventListener('change', rankOperators)
  includeClosed.addEventListener('change', rankOperators)
  search.addEventListener('input', renderChoices)
  choices.addEventListener('change', ({ target }) => {
    showingTop = false
    if (target.checked) selection.add(target.value)
    else selection.delete(target.value)
    renderSelection()
  })
  $('trend-top').addEventListener('click', () => {
    showingTop = true
    selection = new Set(topNames())
    renderSelection()
  })
  $('trend-clear').addEventListener('click', () => {
    showingTop = false
    selection.clear()
    renderSelection()
  })
  picker.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !picker.open) return
    picker.open = false
    $('trend-picker-summary').focus()
  })
  new ResizeObserver(drawChart).observe(canvas)
  $('trend-empty').hidden = true
  $('trend-panel').hidden = false
  refreshTimeline()
  rankOperators()
})()
