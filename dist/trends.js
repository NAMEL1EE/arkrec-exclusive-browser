(() => {
  const $ = id => document.getElementById(id)
  const wiki = window.ARKREC_SNAPSHOT?.wikiExclusiveHistory
  const history = wiki?.samples ?? []
  if (!history.length) return

  const scope = $('trend-scope')
  const includeClosed = $('trend-include-closed')
  const granularity = $('trend-granularity')
  const showChanges = $('trend-show-changes')
  const replayToggle = $('trend-replay')
  const replay = window.ARKREC_REPLAY_DAYS
  const jumpDate = $('trend-jump-date')
  const backlog = replay?.samples.filter(sample => Date.parse(sample.at) >= Date.parse('2026-01-01T00:00:00+08:00')) ?? []
  const transition = backlog.find(sample => sample.source === 'measured')
  const picker = $('trend-picker')
  const search = $('trend-search')
  const choices = $('trend-choices')
  const readout = $('trend-readout')
  const legend = $('trend-legend')
  const detail = $('trend-detail')
  const canvas = $('trend-canvas')
  const tooltip = $('trend-line-tooltip')
  const context = canvas.getContext('2d')
  const zoomTools = $('trend-zoom-tools')
  const boxButton = $('trend-box-zoom')
  const zoomIn = $('trend-zoom-in')
  const zoomOut = $('trend-zoom-out')
  const zoomReset = $('trend-zoom-reset')
  const zoomHint = $('trend-zoom-hint')
  const scaleLabel = $('trend-scale-label')
  const portraits = window.ARKREC_TREND_PORTRAITS
  const portraitIndices = new Map(portraits?.names.map((name, index) => [name, index]))
  let avatarSheet

  const format = options => new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', ...options })
  const isoDate = format({ year: 'numeric', month: '2-digit', day: '2-digit' })
  const inputDate = date => isoDate.format(date).replaceAll('/', '-')
  const calendarDay = format({ year: 'numeric', month: 'numeric', day: 'numeric' })
  const dateTime = format({ year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
  const year = format({ year: 'numeric' })
  const shortDate = format({ year: '2-digit', month: 'numeric', day: 'numeric' })
  const day = format({ month: 'numeric', day: 'numeric' })
  const time = format({ hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
  const number = new Intl.NumberFormat('zh-CN')
  const deltaNumber = new Intl.NumberFormat('zh-CN', { signDisplay: 'exceptZero' })
  const byName = new Intl.Collator('zh-CN')
  const daySpacing = 56
  const axisGutter = 39
  const edgeGutter = 16
  const pointInset = 21
  const portraitPitch = 18
  const portraitRadius = 8
  const portraitGap = 8
  const timelineEndInset = 9
  const portraitFont = '11px system-ui'
  const portraitLabelWidth = 25
  const lowerShare = 0.74
  const fallbackColors = [
    '#175fb4', '#b53b42', '#067b6b', '#8048a8', '#b26209',
    '#217692', '#8f4266', '#466127', '#344dab', '#a4481f',
    '#0c777e', '#ad3d85', '#4e6c14', '#7956ca', '#82611c',
    '#167145', '#536f9a', '#632e72', '#b64a5a', '#126292',
  ]
  const linePatterns = [[], [7, 4], [2, 3], [9, 3, 2, 3], [4, 3]]
  const latest = history.at(-1)
  const names = new Set()
  const days = new Map()
  for (const sample of history) days.set(calendarDay.format(new Date(sample.at)), sample)

  let selectedIndex = 0
  let daily = true
  let ranked = []
  let selection = new Set()
  let selectionMode = 'top'
  let highlighted = null
  let points = []
  let series = []
  let fullView
  let view
  let plot
  let portraitTargets = []
  let curveTargets = []
  let boxMode = false
  let drag = null
  let legendRows = []
  let choiceInputs = []

  function count(sample, name) {
    const mode = includeClosed.checked ? sample.includingClosed : sample.open
    return mode[scope.value][name] ?? 0
  }

  function exclusiveNames(end = points.length - 1) {
    const sample = points[end].sample
    return ranked.filter(name => count(sample, name) > 0)
      .sort((a, b) => count(sample, b) - count(sample, a) || byName.compare(a, b))
  }

  function applyRankedSelection(end) {
    if (selectionMode === 'top' || selectionMode === 'exclusive') {
      const matching = exclusiveNames(end)
      selection = new Set(selectionMode === 'top' ? matching.slice(0, 20) : matching)
    }
  }

  function element(tag, className, text) {
    const node = document.createElement(tag)
    if (className) node.className = className
    if (text !== undefined) node.textContent = text
    return node
  }

  function rankOperators(preserveView = false) {
    names.clear()
    for (const { sample } of points) {
      for (const name of Object.keys(sample.includingClosed.all)) names.add(name)
    }
    const reference = points.at(-1).sample
    ranked = [...names].sort((a, b) => count(reference, b) - count(reference, a) || byName.compare(a, b))
    renderTimelineSummary()
    renderChoices()
    renderSelection(selectedIndex, preserveView ? view : undefined)
  }

  function renderChoices() {
    const query = search.value.trim().toLocaleLowerCase('zh-CN')
    choiceInputs = ranked.filter(name => name.toLocaleLowerCase('zh-CN').includes(query)).map(name => {
      const label = element('label', 'trend-choice')
      const input = element('input')
      input.type = 'checkbox'
      input.value = name
      input.checked = selection.has(name)
      const total = element('small')
      label.append(input, element('span', '', name), total)
      return { label, input, total }
    })
    choices.replaceChildren(...choiceInputs.map(({ label }) => label))
    updateChoiceCounts(points.length - 1)
    $('trend-search-empty').hidden = choiceInputs.length > 0
  }

  function updateChoiceCounts(end) {
    const sample = points[Math.min(end, points.length - 1)].sample
    for (const { input, total } of choiceInputs) total.textContent = number.format(count(sample, input.value))
  }

  function refreshTimeline() {
    daily = granularity.value === 'day'
    const samples = daily && transition ? backlog : daily ? [...days.values()] : history
    points = samples.map(sample => ({ date: new Date(sample.at), sample }))
    selectedIndex = points.length - 1
    $('trend-backfill').hidden = !daily || !transition
    if (daily && transition) {
      jumpDate.min = inputDate(points[0].date)
      jumpDate.max = inputDate(points.at(-1).date)
      $('trend-backfill-note').textContent = calendarDay.format(new Date(transition.at)) + ' 起使用实测快照，之前为回算估值。'
    }
    view = null
    rankOperators()
  }

  function changedNames() {
    const previous = points.at(-2)?.sample
    return previous ? ranked.filter(name => count(previous, name) !== count(points.at(-1).sample, name)) : []
  }

  function renderTimelineSummary() {
    const changed = changedNames()
    const label = daily ? shortDate : dateTime
    const end = label.format(points.at(-1).date)
    const start = label.format(points[0].date)
    const range = start === end ? end : start + ' – ' + end
    const unit = daily ? '天' : ' 条快照'
    const changes = points.length > 1 ? ' · 最近两' + (daily ? '天' : '次') + '有 ' + changed.length + ' 位干员变化' : ''
    $('trend-caption').textContent = range + '（北京时间） · ' + points.length + unit + changes
    showChanges.hidden = !changed.length
    applyRankedSelection(points.length - 1)
    if (selectionMode === 'changes') selection = new Set(changed)
  }

  function renderSelection(index = selectedIndex, previousView) {
    for (const { input } of choiceInputs) input.checked = selection.has(input.value)
    $('trend-picker-summary').textContent = '干员 · 已选 ' + selection.size
    const colorUse = new Map()
    series = ranked.filter(name => selection.has(name)).map((name, index) => {
      const color = portraits?.colors?.[portraitIndices.get(name)] ?? fallbackColors[index % fallbackColors.length]
      const use = colorUse.get(color) ?? 0
      colorUse.set(color, use + 1)
      return {
        name, color,
        pattern: linePatterns[use % linePatterns.length],
        light: isLightColor(color),
        values: points.map(({ sample }) => count(sample, name)),
      }
    })
    if (!selection.has(highlighted)) highlighted = null
    canvas.hidden = !series.length
    legend.hidden = !series.length
    $('trend-no-selection').hidden = series.length > 0

    legendRows = series.map(({ name, color, pattern }) => {
      const item = element('li')
      const button = element('button', 'trend-legend-item')
      const swatch = element('span', 'trend-swatch')
      swatch.style.borderColor = color
      if (pattern.length) swatch.style.borderTopStyle = pattern[0] <= 2 ? 'dotted' : 'dashed'
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
      const detailsButton = element('button', 'trend-detail-button', '明细')
      detailsButton.type = 'button'
      detailsButton.setAttribute('aria-label', '查看' + name + '的当前独享')
      detailsButton.addEventListener('click', () => openDetails(name))
      item.append(button, detailsButton)
      return { name, item, button, value, delta }
    })
    legend.replaceChildren(...legendRows.map(({ item }) => item))
    const dates = { first: 0, last: points.length - 1 }
    fullView = { ...dates, ...fitCountAxis(dates), timeZoom: false, verticalZoom: false }
    plot = null
    stopInteraction()
    setView(previousView ? { ...fullView, first: previousView.first, last: previousView.last, timeZoom: previousView.timeZoom } : fullView, index)
  }

  function isLightColor(color) {
    const [r, g, b] = color.slice(1).match(/../g).map(channel => parseInt(channel, 16))
    return (r * 0.2126 + g * 0.7152 + b * 0.0722) >= 190
  }

  function axisStep(range, intervals = 5) {
    const target = Math.max(1, range / intervals)
    const power = 10 ** Math.floor(Math.log10(target))
    return [1, 2, 2.5, 5, 10].map(step => step * power)
      .find(step => Number.isInteger(step) && step >= target)
  }

  function fitCountAxis({ first, last }) {
    const peaks = series.map(({ values }) => {
      let peak = 0
      for (let i = first; i <= last; i += 1) peak = Math.max(peak, values[i])
      return peak
    }).filter(value => value > 0).sort((a, b) => a - b)
    const highest = peaks.at(-1) ?? 1
    const step = axisStep(highest)
    const high = Math.ceil((highest + 1) / step) * step

    // Expand the band that holds most visible lines when a few lines sit well above it.
    const cluster = peaks[Math.floor((peaks.length - 1) * 0.7)] ?? 0
    const breakStep = axisStep(cluster)
    const breakAt = Math.max(3, Math.ceil(cluster / breakStep) * breakStep)
    const factor = peaks.length >= 4 && highest >= breakAt * 2.5
      ? breakAt * (1 - lowerShare) / (lowerShare * (high - breakAt))
      : 1
    return { low: 0, high, breakAt, factor }
  }

  const clamp = (value, low, high) => Math.min(high, Math.max(low, value))

  function portraitLanes(width) {
    if (!portraitIndices.size) return 0
    const space = width - axisGutter - edgeGutter - daySpacing - pointInset - timelineEndInset - portraitGap - portraitLabelWidth
    return clamp(Math.floor(space / portraitPitch), 0, 9)
  }

  function chartScale(range, height) {
    const { low, high, breakAt, factor } = range
    const top = 24
    const bottom = height - 32
    const base = axisPosition(low, breakAt, factor)
    const scaledRange = axisPosition(high, breakAt, factor) - base
    return {
      top, bottom, breakAt, factor,
      yFor: value => bottom - (bottom - top) * (axisPosition(value, breakAt, factor) - base) / scaledRange,
      valueAt: y => axisCount(base + (bottom - y) * scaledRange / (bottom - top), breakAt, factor),
    }
  }

  function fitView(next) {
    return next.verticalZoom ? next : { ...next, ...fitCountAxis(next) }
  }

  function dailyWindow(next) {
    const width = canvas.clientWidth
    const height = canvas.clientHeight
    const space = width - axisGutter - edgeGutter - pointInset - timelineEndInset
    let first = Math.max(fullView.first, next.last - Math.max(0, Math.floor(space / daySpacing)))
    for (; first < next.last; first += 1) {
      const candidate = fitView({ ...next, first })
      const { yFor } = chartScale(candidate, height)
      const portraitsWidth = layoutPortraits(candidate, width, yFor).width
      if (space - portraitsWidth >= daySpacing * (next.last - first)) return candidate
    }
    return fitView({ ...next, first })
  }

  function setView(next, index = selectedIndex) {
    view = daily && !next.timeZoom ? dailyWindow(next) : fitView(next)
    selectedIndex = clamp(index, view.first, view.last)
    updateChoiceCounts(fullView.last)
    renderZoomControls()
    renderPoint()
  }

  function renderZoomControls() {
    const { verticalZoom, breakAt, factor } = view
    const canPanDates = view.first > fullView.first || view.last < fullView.last
    const zoomed = view.timeZoom || verticalZoom
    zoomTools.hidden = !series.length
    const split = factor < 1 && view.low < breakAt && view.high > breakAt
    scaleLabel.hidden = !series.length
    scaleLabel.textContent = split ? '独享数 · ' + number.format(breakAt) + ' 以下放大显示' : '独享数'
    boxButton.setAttribute('aria-pressed', String(boxMode))
    canvas.classList.toggle('box-zoom', boxMode)
    canvas.classList.toggle('can-pan', !boxMode && (canPanDates || verticalZoom))
    canvas.classList.toggle('pan-dates', !boxMode && canPanDates && !verticalZoom)
    zoomIn.disabled = view.high - view.low <= 2
    zoomOut.disabled = !verticalZoom
    zoomReset.disabled = !zoomed && !boxMode && view.last === fullView.last
    zoomHint.hidden = !series.length || (!boxMode && !zoomed && !canPanDates)
    if (boxMode) zoomHint.textContent = '在图内拖动框选，松开即可放大。'
    else if (zoomed) zoomHint.textContent = '拖动图表可平移。当前范围 ' + number.format(Math.floor(view.low)) + '–' + number.format(Math.ceil(view.high)) + ' 项'
    else zoomHint.textContent = '左右拖动查看其他日期。'
  }

  function stopInteraction() {
    const pointerId = drag?.pointerId
    drag = null
    boxMode = false
    canvas.classList.remove('is-panning')
    if (pointerId != null && canvas.hasPointerCapture(pointerId)) canvas.releasePointerCapture(pointerId)
  }

  function axisPosition(value, breakAt, factor) {
    return value <= breakAt ? value : breakAt + (value - breakAt) * factor
  }

  function axisCount(position, breakAt, factor) {
    return position <= breakAt ? position : breakAt + (position - breakAt) / factor
  }

  function zoomVertical(factor) {
    const ceiling = fullView.high
    const span = clamp(Math.round((view.high - view.low) * factor), Math.min(2, ceiling), ceiling)
    const line = series.find(item => item.name === highlighted)
    const focus = line?.values[selectedIndex] ?? (view.verticalZoom ? (view.low + view.high) / 2 : view.low)
    const center = clamp(focus, view.low, view.high)
    const low = clamp(Math.round(center - span / 2), fullView.low, ceiling - span)
    const verticalZoom = factor < 1 || span < fitCountAxis(view).high
    stopInteraction()
    setView({ ...view, low, high: low + span, verticalZoom })
  }

  function pointSource(sample) {
    return sample.source === 'estimate' ? '历史估算' : sample.source === 'carried' ? '沿用前次快照' : ''
  }

  function renderPoint() {
    const index = selectedIndex
    const { date, sample } = points[index]
    const source = pointSource(sample)
    readout.textContent = (daily ? calendarDay : dateTime).format(date) + (source ? ' · ' + source : '')
    if (daily && transition) jumpDate.value = inputDate(date)
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

  function openDetails(name) {
    const rows = (wiki.details?.[name] ?? []).filter(([story, , , , , open]) =>
      (includeClosed.checked || open)
      && (scope.value === 'all' || story === (scope.value === 'activity' ? '活动关卡' : '主线关卡')))
    const title = $('trend-detail-title')
    const countLabel = $('trend-detail-count')
    title.textContent = name + '的当前独享'
    countLabel.textContent = !wiki.details ? '当前快照暂无关卡明细。'
      : rows.length ? '共 ' + rows.length + ' 项 · ' + dateTime.format(new Date(window.ARKREC_SNAPSHOT.syncedAt ?? latest.at)) : '当前范围内没有独享。'
    const items = rows.map(([story, episode, code, stageName, difficulty]) => {
      const item = element('li')
      const link = element('a', '', code + ' ' + stageName + (difficulty ? ' · ' + difficulty : ''))
      link.href = 'https://wiki.arkrec.com/operation/' + encodeURIComponent(code + '+' + stageName)
      link.target = '_blank'
      link.rel = 'noopener'
      item.append(link, element('small', '', episode || story))
      return item
    })
    $('trend-detail-list').replaceChildren(...items)
    detail.showModal()
  }

  function portraitAt(event) {
    const { left, top } = canvas.getBoundingClientRect()
    return portraitTargets.find(({ x, y }) =>
      Math.hypot(event.clientX - left - x, event.clientY - top - y) <= portraitRadius)
  }

  function chooseAt(event) {
    const portrait = portraitAt(event)
    if (portrait) openDetails(portrait.name)
    else choosePoint(event)
  }

  function drawChart() {
    portraitTargets = []
    curveTargets = []
    hideLineTooltip()
    if (!context || !series.length) return
    const width = canvas.clientWidth
    const height = canvas.clientHeight
    if (!width || !height) return
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2)
    canvas.width = Math.round(width * pixelRatio)
    canvas.height = Math.round(height * pixelRatio)
    context.scale(pixelRatio, pixelRatio)

    const { first, last, low, high } = view
    const fixedDays = daily && !view.timeZoom
    const { top, bottom, breakAt, factor, yFor, valueAt } = chartScale(view, height)
    const portraitLayout = layoutPortraits(view, width, yFor)
    const portraitWidth = portraitLayout.width
    const plotWidth = width - axisGutter - edgeGutter - portraitWidth
    const chartWidth = fixedDays ? Math.min(plotWidth, daySpacing * (last - first) + pointInset + timelineEndInset) : plotWidth
    const left = axisGutter
    const right = left + chartWidth
    const startInset = fixedDays ? Math.min(pointInset, chartWidth / 2) : 0
    const endInset = fixedDays ? Math.min(timelineEndInset, chartWidth / 2) : 0
    const xValue = index => daily ? index : points[index].date.getTime()
    const startX = xValue(first)
    const span = xValue(last) - startX
    const xFor = index => {
      return span ? left + startInset + (chartWidth - startInset - endInset) * (xValue(index) - startX) / span : (left + right) / 2
    }
    plot = { left, right, top, bottom, xFor, valueAt, dragStep: fixedDays ? daySpacing : chartWidth / Math.max(1, last - first) }
    const index = selectedIndex

    context.font = '12px system-ui'
    context.textBaseline = 'middle'
    context.textAlign = 'right'
    context.fillStyle = '#4c5f77'
    const split = factor < 1 && breakAt > low && breakAt < high
    if (split) {
      drawTicks(low, breakAt, yFor(breakAt))
      drawTicks(breakAt, high, yFor(breakAt))
      drawTick(breakAt, true)
    } else {
      drawTicks(low, high)
    }

    function drawTicks(start, end, splitY) {
      const intervals = Math.max(1, Math.round(Math.abs(yFor(start) - yFor(end)) / 50))
      const interval = axisStep(end - start, intervals)
      for (let value = Math.ceil(start / interval) * interval; value <= end; value += interval) {
        if (splitY === undefined || Math.abs(yFor(value) - splitY) >= 24) drawTick(value)
      }
    }

    function drawTick(value, boundary = false) {
      const y = yFor(value)
      context.strokeStyle = boundary ? '#9aafca' : '#dbe4f0'
      if (boundary) context.setLineDash([3, 3])
      context.beginPath()
      context.moveTo(left, y)
      context.lineTo(right, y)
      context.stroke()
      context.setLineDash([])
      context.fillText(number.format(value), left - 8, y)
    }

    context.strokeStyle = '#aebfd5'
    context.beginPath()
    context.moveTo(left, top)
    context.lineTo(left, bottom)
    context.lineTo(right, bottom)
    context.stroke()

    const tickCount = fixedDays ? last - first + 1 : Math.min(last - first + 1, width < 470 ? 3 : 6)
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
      if (!fixedDays && interior && (x - previousTick < 62 || right - x < 62)) continue
      context.beginPath()
      context.moveTo(x, bottom)
      context.lineTo(x, bottom + 4)
      context.stroke()
      context.textAlign = fixedDays || tickCount === 1 ? 'center' : tick === 0 ? 'left' : tick === tickCount - 1 ? 'right' : 'center'
      context.fillText(dateLabel.format(points[tickIndex].date), x, bottom + 17)
      previousTick = x
    }

    if (points[first].sample.source === 'estimate' && points[last].sample.source !== 'estimate') {
      const boundary = points.findIndex(({ sample }, index) => index >= first && sample.source === 'measured')
      const x = xFor(boundary)
      context.strokeStyle = '#6485ac'
      context.setLineDash([4, 4])
      context.beginPath()
      context.moveTo(x, top)
      context.lineTo(x, bottom)
      context.stroke()
      context.setLineDash([])
      context.fillStyle = '#4c5f77'
      context.textAlign = x > right - 52 ? 'right' : 'left'
      context.fillText('实测起点', x + (x > right - 52 ? -4 : 4), top - 9)
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

    const activeLine = series.find(({ name }) => name === highlighted)
    for (const line of series) {
      if (line !== activeLine) drawLine(line, Boolean(activeLine))
    }
    if (activeLine) drawLine(activeLine, false)

    if (drag?.kind === 'box') {
      const width = drag.end.x - drag.start.x
      const height = drag.end.y - drag.start.y
      context.fillStyle = '#2869bd29'
      context.strokeStyle = '#2869bd'
      context.lineWidth = 1
      context.fillRect(drag.start.x, drag.start.y, width, height)
      context.strokeRect(drag.start.x, drag.start.y, width, height)
    }
    context.restore()
    drawPortraits(right + portraitGap, portraitLayout.rows)

    function drawLine(line, muted) {
      const { color, values, pattern, light } = line
      context.globalAlpha = muted ? 0.16 : 1
      context.strokeStyle = color
      context.fillStyle = color
      const weight = activeLine && !muted ? 3 : 2
      context.lineWidth = weight
      context.setLineDash(pattern)
      context.lineJoin = 'round'

      const vertices = [[xFor(first), yFor(values[first])]]
      for (let i = first + 1; i <= last; i += 1) {
        const previous = values[i - 1]
        const current = values[i]
        const x = xFor(i)
        if (split && (previous - breakAt) * (current - breakAt) < 0) {
          const fraction = (breakAt - previous) / (current - previous)
          const previousX = xFor(i - 1)
          vertices.push([previousX + fraction * (x - previousX), yFor(breakAt)])
        }
        vertices.push([x, yFor(current)])
      }
      curveTargets.push({ line, vertices })
      context.beginPath()
      context.moveTo(...vertices[0])
      for (let i = 1; i < vertices.length; i += 1) context.lineTo(...vertices[i])
      if (light) {
        context.strokeStyle = '#445871'
        context.lineWidth = weight + 1
        context.stroke()
        context.strokeStyle = color
        context.lineWidth = weight
      }
      context.stroke()
      context.setLineDash([])

      const x = xFor(index)
      const y = yFor(values[index])
      drawDot(x, y, activeLine && !muted ? 5 : 3.3)
      context.globalAlpha = 1
    }
  }

  function drawDot(x, y, radius) {
    context.beginPath()
    context.arc(x, y, radius, 0, Math.PI * 2)
    context.fill()
  }

  function layoutPortraits({ low, high, last }, width, yFor) {
    const lanes = portraitLanes(width)
    if (!context || !lanes) return { rows: [], width: 0 }
    const groups = new Map()
    for (const line of series) {
      const value = line.values[last]
      const portraitIndex = portraitIndices.get(line.name)
      if (value <= 0 || value < low || value > high || portraitIndex === undefined) continue
      if (!groups.has(value)) groups.set(value, [])
      groups.get(value).push({ ...line, portraitIndex })
    }

    const rows = []
    const groupsBySize = [...groups].sort(([a, first], [b, second]) => second.length - first.length || b - a)
    const right = lanes * portraitPitch + portraitLabelWidth
    const numberGap = 4
    context.save()
    context.font = portraitFont
    for (const [value, operators] of groupsBySize) {
      const y = yFor(value)
      const nearby = rows.filter(row => Math.abs(y - row.y) < portraitPitch)
      const label = number.format(value)
      const textWidth = Math.ceil(context.measureText(label).width)
      let count = Math.min(operators.length, lanes)
      let rowX
      while (count && rowX === undefined) {
        const width = count * portraitPitch + numberGap + textWidth + 2
        for (let lane = 0; lane + count <= lanes; lane += 1) {
          const x = lane * portraitPitch
          if (x + width > right || nearby.some(row => x < row.right && x + width > row.left)) continue
          rowX = x
          break
        }
        if (rowX === undefined) count -= 1
      }
      if (rowX === undefined) continue
      const visible = operators.slice(0, count)
      const focused = operators.find(({ name }) => name === highlighted)
      if (focused && !visible.includes(focused)) visible[count - 1] = focused
      const labelX = rowX + count * portraitPitch + numberGap
      rows.push({ y, left: rowX, right: labelX + textWidth + 2, label, labelX, operators: visible })
    }
    context.restore()
    const used = rows.reduce((max, row) => Math.max(max, row.right), 0)
    return { rows, width: used ? portraitGap + used : 0 }
  }

  function drawPortraits(left, rows) {
    if (!rows.length) return
    if (!avatarSheet) {
      avatarSheet = new Image()
      avatarSheet.addEventListener('load', drawChart, { once: true })
      avatarSheet.src = portraits.file
    }
    if (!avatarSheet.naturalWidth) return
    context.save()
    context.font = portraitFont
    context.textBaseline = 'middle'
    context.textAlign = 'left'
    context.fillStyle = '#354e6b'
    for (const row of rows) {
      for (const [index, operator] of row.operators.entries()) {
        drawPortrait(operator, left + row.left + (index + 0.5) * portraitPitch, row.y)
      }
      context.fillText(row.label, left + row.labelX, row.y)
    }
    context.restore()
  }

  function drawPortrait({ name, color, portraitIndex }, x, y) {
    const { columns, cell } = portraits
    const sourceX = portraitIndex % columns * cell
    const sourceY = Math.floor(portraitIndex / columns) * cell
    context.save()
    context.globalAlpha = highlighted && name !== highlighted ? 0.28 : 1
    context.beginPath()
    context.arc(x, y, portraitRadius, 0, Math.PI * 2)
    context.save()
    context.clip()
    const size = portraitRadius * 2
    context.drawImage(avatarSheet, sourceX, sourceY, cell, cell, x - portraitRadius, y - portraitRadius, size, size)
    context.restore()
    context.strokeStyle = color
    context.lineWidth = name === highlighted ? 2 : 1
    context.stroke()
    context.restore()
    portraitTargets.push({ name, x, y })
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

  function hideLineTooltip() {
    tooltip.hidden = true
  }

  function distanceToSegment(x, y, [ax, ay], [bx, by]) {
    const dx = bx - ax
    const dy = by - ay
    const lengthSquared = dx * dx + dy * dy
    const t = lengthSquared ? clamp(((x - ax) * dx + (y - ay) * dy) / lengthSquared, 0, 1) : 0
    return Math.hypot(x - ax - t * dx, y - ay - t * dy)
  }

  function showLineTooltip(event) {
    if (!plot) return hideLineTooltip()
    const bounds = canvas.getBoundingClientRect()
    const x = event.clientX - bounds.left
    const y = event.clientY - bounds.top
    if (x < plot.left || x > plot.right || y < plot.top || y > plot.bottom) return hideLineTooltip()

    let nearest
    let best = 6
    for (let i = curveTargets.length - 1; i >= 0; i -= 1) {
      const { line, vertices } = curveTargets[i]
      let start = vertices[0]
      for (const end of vertices) {
        if (x >= start[0] - best && x <= end[0] + best) {
          const distance = distanceToSegment(x, y, start, end)
          if (distance < best) {
            best = distance
            nearest = line
          }
        }
        start = end
      }
    }
    if (!nearest) return hideLineTooltip()

    const index = nearestPoint(x)
    const date = (daily ? calendarDay : dateTime).format(points[index].date)
    tooltip.firstElementChild.textContent = nearest.name
    const source = pointSource(points[index].sample)
    tooltip.lastElementChild.textContent = date + ' · ' + number.format(nearest.values[index]) + ' 项独享' + (source ? ' · ' + source : '')
    tooltip.style.borderInlineStartColor = nearest.color
    tooltip.hidden = false
    const right = bounds.width - tooltip.offsetWidth - 4
    const left = x + 12 <= right ? x + 12 : x - tooltip.offsetWidth - 12
    tooltip.style.left = clamp(left, 4, Math.max(4, right)) + 'px'
    tooltip.style.top = Math.max(4, y - tooltip.offsetHeight - 8) + 'px'
  }

  function choosePoint(event) {
    if (!plot) return
    const x = event.clientX - canvas.getBoundingClientRect().left
    if (x < plot.left || x > plot.right) return
    const index = nearestPoint(x)
    if (selectedIndex === index) return
    selectedIndex = index
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
      next.timeZoom ||= next.first !== view.first || next.last !== view.last
    }
    if (Math.abs(start.y - end.y) >= 12) {
      const minimumSpan = Math.min(2, view.high - view.low)
      next.low = clamp(Math.floor(plot.valueAt(Math.max(start.y, end.y))), view.low, view.high - minimumSpan)
      next.high = clamp(Math.ceil(plot.valueAt(Math.min(start.y, end.y))), next.low + minimumSpan, view.high)
      next.verticalZoom ||= next.low !== view.low || next.high !== view.high
    }
    return next
  }

  function panChart(event) {
    const { origin, start, index, dragStep } = drag
    const dx = event.clientX - start.x
    const dy = event.clientY - start.y
    if (!drag.moved && Math.hypot(dx, dy) < 5) return
    drag.moved = true
    const dates = origin.last - origin.first
    const shift = Math.round(dx / dragStep)
    const last = clamp(origin.last - shift, daily && !origin.timeZoom ? fullView.first : fullView.first + dates, fullView.last)
    const first = last - dates
    const next = { ...origin, first, last }
    if (origin.verticalZoom) {
      const { breakAt, factor } = origin
      const startY = axisPosition(origin.low, breakAt, factor)
      const height = axisPosition(origin.high, breakAt, factor) - startY
      const fullTop = axisPosition(fullView.high, breakAt, factor)
      const bottom = clamp(startY + dy * height / (plot.bottom - plot.top), 0, fullTop - height)
      next.low = axisCount(bottom, breakAt, factor)
      next.high = axisCount(bottom + height, breakAt, factor)
    }
    if (last !== view.last || next.low !== view.low || next.high !== view.high) {
      setView(next, index + last - origin.last)
    }
  }

  canvas.addEventListener('pointerdown', event => {
    if (!plot || !event.isPrimary || event.button !== 0) return
    hideLineTooltip()
    if (!boxMode && portraitAt(event)) return
    if (boxMode) {
      const start = chartLocation(event)
      drag = { kind: 'box', start, end: start, pointerId: event.pointerId }
    } else if (canvas.classList.contains('can-pan')) {
      drag = {
        kind: 'pan', start: { x: event.clientX, y: event.clientY }, pointerId: event.pointerId,
        origin: view, index: selectedIndex, dragStep: plot.dragStep, moved: false,
      }
      canvas.classList.add('is-panning')
    } else return
    canvas.setPointerCapture(event.pointerId)
  })
  canvas.addEventListener('pointermove', event => {
    if (drag?.pointerId === event.pointerId) {
      if (drag.kind === 'pan') {
        panChart(event)
      } else {
        drag.end = chartLocation(event)
        drawChart()
      }
    } else if (!boxMode && event.pointerType !== 'touch') {
      const portrait = portraitAt(event)
      canvas.classList.toggle('on-portrait', Boolean(portrait))
      if (portrait) hideLineTooltip()
      else showLineTooltip(event)
    }
  })
  canvas.addEventListener('pointerleave', () => {
    canvas.classList.remove('on-portrait')
    hideLineTooltip()
  })
  canvas.addEventListener('pointerup', event => {
    if (drag?.pointerId !== event.pointerId) {
      if (!boxMode && event.isPrimary && event.button === 0) chooseAt(event)
      return
    }
    if (drag.kind === 'pan') {
      panChart(event)
      const moved = drag.moved
      stopInteraction()
      if (!moved) chooseAt(event)
      return
    }
    const next = boxView(drag.start, chartLocation(event))
    stopInteraction()
    setView(next)
  })
  canvas.addEventListener('lostpointercapture', event => {
    if (drag?.pointerId !== event.pointerId) return
    drag = null
    canvas.classList.remove('is-panning')
    drawChart()
  })
  boxButton.addEventListener('click', () => {
    if (boxMode) stopInteraction()
    else boxMode = true
    renderZoomControls()
    drawChart()
  })
  zoomIn.addEventListener('click', () => zoomVertical(0.6))
  zoomOut.addEventListener('click', () => zoomVertical(1.75))
  zoomReset.addEventListener('click', () => {
    stopInteraction()
    setView(fullView, fullView.last)
  })
  zoomTools.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !boxMode) return
    stopInteraction()
    renderZoomControls()
    drawChart()
  })
  canvas.addEventListener('keydown', event => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    const bounds = view.timeZoom ? view : fullView
    const index = clamp(selectedIndex + (event.key === 'ArrowLeft' ? -1 : 1), bounds.first, bounds.last)
    if (index < view.first || index > view.last) {
      const last = index < view.first ? index + view.last - view.first : index
      const next = dailyWindow({ ...view, last })
      setView(index < next.first ? { ...view, last: index } : next, index)
    } else if (index !== selectedIndex) {
      selectedIndex = index
      renderPoint()
    }
  })
  scope.addEventListener('change', () => { if (!replayToggle.checked) rankOperators() })
  includeClosed.addEventListener('change', () => { if (!replayToggle.checked) rankOperators() })
  replayToggle.addEventListener('change', () => { if (!replayToggle.checked) rankOperators(true) })
  jumpDate.addEventListener('change', () => {
    const index = points.findIndex(({ date }) => inputDate(date) === jumpDate.value)
    if (index < 0) {
      jumpDate.value = inputDate(points[selectedIndex].date)
      return
    }
    stopInteraction()
    setView({ ...fullView, last: index }, index)
  })
  granularity.addEventListener('change', refreshTimeline)
  search.addEventListener('input', renderChoices)
  choices.addEventListener('change', ({ target }) => {
    selectionMode = 'manual'
    if (target.checked) selection.add(target.value)
    else selection.delete(target.value)
    renderSelection()
  })
  showChanges.addEventListener('click', () => {
    selectionMode = 'changes'
    selection = new Set(changedNames())
    renderSelection(points.length - 1)
  })
  $('trend-top').addEventListener('click', () => {
    selectionMode = 'top'
    applyRankedSelection(fullView.last)
    renderSelection()
  })
  $('trend-all-exclusive').addEventListener('click', () => {
    selectionMode = 'exclusive'
    applyRankedSelection(fullView.last)
    renderSelection()
  })
  $('trend-clear').addEventListener('click', () => {
    selectionMode = 'manual'
    selection.clear()
    renderSelection()
  })
  picker.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !picker.open) return
    picker.open = false
    $('trend-picker-summary').focus()
  })
  new ResizeObserver(() => {
    if (replayToggle.checked) return
    stopInteraction()
    setView(view)
  }).observe(canvas)
  $('trend-empty').hidden = true
  $('trend-panel').hidden = false
  window.ARKREC_OPEN_DETAILS = openDetails
  refreshTimeline()
})()
