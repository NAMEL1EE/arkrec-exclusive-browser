(() => {
  const archive = window.ARKREC_REPLAY_HISTORY
  if (!archive?.frames?.length) return
  const dayMs = 86_400_000
  const offset = 28_800_000
  const byDay = at => Math.floor((Date.parse(at) + offset) / dayMs)
  const isoDay = day => new Date(day * dayMs).toISOString().slice(0, 10)
  const snapshots = window.ARKREC_SNAPSHOT?.wikiExclusiveHistory?.samples ?? []
  const measured = new Map(snapshots.map(sample => [byDay(sample.at), sample]))
  const measuredFirst = measured.keys().next().value ?? Infinity
  const first = archive.frames[0][0]
  const last = Math.max(archive.frames.at(-1)[0], ...measured.keys())
  const samples = []
  let archiveIndex = 0
  let counts = { open: {}, includingClosed: {} }
  for (const [mode, scope] of archive.buckets) counts[mode][scope] = Object.create(null)

  for (let day = first; day <= last; day += 1) {
    let source = day < measuredFirst ? 'estimate' : 'carried'
    const frame = archive.frames[archiveIndex]
    const actual = measured.get(day)
    if (actual) {
      counts = actual
      source = 'measured'
    } else if (day < measuredFirst && frame?.[0] === day) {
      counts = { open: { ...counts.open }, includingClosed: { ...counts.includingClosed } }
      archive.buckets.forEach(([mode, scope], index) => {
        const changes = frame[index + 1]
        if (!changes.length) return
        const values = Object.assign(Object.create(null), counts[mode][scope])
        for (let i = 0; i < changes.length; i += 2) {
          const name = changes[i]
          const value = changes[i + 1]
          if (value > 0) values[name] = value
          else delete values[name]
        }
        counts[mode][scope] = values
      })
      archiveIndex += 1
    }
    samples.push({
      at: actual?.at ?? new Date((day + 1) * dayMs - offset - 1).toISOString(),
      open: counts.open, includingClosed: counts.includingClosed, source,
    })
  }
  window.ARKREC_REPLAY_DAYS = { first, last, isoDay, samples }
})()
