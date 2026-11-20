const alwaysOpen = new Set(['主线关卡', '剿灭作战', '物资筹备', '芯片搜索', '全息作战矩阵'])
const hiddenFromAll = new Set(['危机合约', '危机合约Re', '悖论模拟', '长线战役'])
const scopes = ['all', 'activity', 'main']
const modes = ['open', 'includingClosed']
const newCounts = () => Object.fromEntries(scopes.map(scope => [scope, Object.create(null)]))
const beijingDay = timestamp => new Date(timestamp + 28_800_000).toISOString().slice(0, 10)

export function normalizeOpenEpisodes(data) {
  if (!Array.isArray(data) || data.some(name => typeof name !== 'string' || !name)) {
    throw new Error('源站开放章节列表结构异常')
  }
  return [...new Set(data)].sort()
}

export function emptyExclusiveSample(at) {
  return { at, open: newCounts(), includingClosed: newCounts() }
}

export function captureExclusiveSample(source, openEpisodes, at, flow, details) {
  if (!Array.isArray(source) || !source.length) throw new Error('源站独享汇总为空或结构异常')
  const episodes = new Set(openEpisodes)
  const sample = emptyExclusiveSample(at)
  for (const { name, operations } of source) {
    if (typeof name !== 'string' || !name || !Array.isArray(operations)) throw new Error('源站独享汇总结构异常')
    for (const row of operations) {
      if (row.category !== flow) continue
      const { story, episode } = row
      if (typeof story !== 'string' || !story || typeof episode !== 'string') {
        throw new Error('源站独享汇总缺少类别或章节')
      }
      // Match the Wiki's “按干员” default category and open-episode filters.
      if (hiddenFromAll.has(story)) continue
      const isOpen = alwaysOpen.has(story) || episodes.has(episode)
      if (details) {
        details[name] ??= []
        details[name].push([story, episode, row.operation, row.cn_name, String(row.operationType ?? '').trim(), isOpen])
      }
      const scopes = ['all']
      if (story === '活动关卡') scopes.push('activity')
      if (story === '主线关卡') scopes.push('main')
      for (const scope of scopes) {
        const all = sample.includingClosed[scope]
        all[name] = (all[name] ?? 0) + 1
        if (isOpen) {
          const open = sample.open[scope]
          open[name] = (open[name] ?? 0) + 1
        }
      }
    }
  }
  if (details && !Object.keys(sample.includingClosed.all).length) throw new Error('源站独享汇总中没有找到' + flow + '数据')
  return sample
}

function sameCounts(previous, next) {
  return modes.every(mode => scopes.every(scope => {
    const before = Object.entries(previous[mode][scope])
    const after = next[mode][scope]
    return before.length === Object.keys(after).length && before.every(([name, count]) => after[name] === count)
  }))
}

function rememberExclusiveSample(sample, history) {
  const at = Date.parse(sample.at)
  if (!Number.isFinite(at)) throw new Error('独享快照时间无效')
  const last = history.at(-1)
  if (!last) return [sample]
  const lastAt = Date.parse(last.at)
  if (at === lastAt) return [...history.slice(0, -1), sample]
  if (at < lastAt || (beijingDay(at) === beijingDay(lastAt) && sameCounts(last, sample))) return history
  return [...history, sample]
}

export function updateWikiHistory(previous, result, episodes, at, flow) {
  const history = previous?.samples ?? []
  const details = result.unchanged ? previous.details : Object.create(null)
  const sample = result.unchanged
    ? { ...history.at(-1), at }
    : captureExclusiveSample(result.data, episodes, at, flow, details)
  return { etag: result.etag, episodes, details, samples: rememberExclusiveSample(sample, history) }
}
