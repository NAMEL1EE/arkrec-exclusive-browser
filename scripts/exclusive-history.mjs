const modes = ['normal', 'challenge', 'sandbox']
const scopeFor = story => story === '活动关卡' ? 'activity' : 'main'
const newCounts = () => ({ activity: Object.create(null), main: Object.create(null) })
const beijingDay = timestamp => new Date(timestamp + 8 * 60 * 60 * 1000).toISOString().slice(0, 10)

export function captureExclusiveSample(snapshot) {
  const counts = newCounts()
  for (const group of snapshot.groups) {
    const list = counts[scopeFor(group.story)]
    for (const stage of group.stages) {
      for (const mode of modes) {
        for (const operator of new Set(stage[mode] ?? [])) {
          list[operator] = (list[operator] ?? 0) + 1
        }
      }
    }
  }
  return { at: snapshot.syncedAt, ...counts }
}

function sameCounts(previous, next) {
  return ['activity', 'main'].every(scope => {
    const counts = Object.entries(previous[scope])
    return counts.length === Object.keys(next[scope]).length && counts.every(([name, count]) => next[scope][name] === count)
  })
}

export function rememberExclusiveSample(snapshot, history = snapshot.exclusiveHistory ?? []) {
  const sample = captureExclusiveSample(snapshot)
  const last = history.at(-1)
  if (!last) return [sample]
  const at = Date.parse(sample.at)
  const lastAt = Date.parse(last.at)
  if (at === lastAt) return [...history.slice(0, -1), sample]
  if (at < lastAt || (beijingDay(at) === beijingDay(lastAt) && sameCounts(last, sample))) return history
  return [...history, sample]
}
