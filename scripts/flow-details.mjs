const MODES = ['normal', 'challenge']
const FLOW = '解手流'

export const stageKey = row => JSON.stringify([row.story, row.episode, row.operation, row.cn_name])

export function parseFlowRecord(row) {
  if (!Array.isArray(row.category) || !row.category.includes(FLOW) || row.group === '旧纪录'
    || !['活动关卡', '主线关卡'].includes(row.story) || !MODES.includes(row.operationType)
    || typeof row._id !== 'string' || !Array.isArray(row.team)
    || ![row.episode, row.operation, row.cn_name].every(value => typeof value === 'string' && value.length)
    || typeof row.remark1 !== 'string') return null

  const steps = row.remark1.normalize('NFKC').match(/(?<![\d.+~–－-])(\d{1,3})[ \t]*步(?!骤)/u)
  if (!steps) return null

  const team = [...new Set(row.team.map(member => member?.name).filter(name => typeof name === 'string' && name))]
  if (!team.length) return null
  return {
    id: row._id, key: stageKey(row), mode: row.operationType, team,
    steps: Number(steps[1]),
  }
}

export function withFlowSteps(groups, records) {
  const byStage = new Map()
  for (const record of records) {
    if (!byStage.has(record.key)) byStage.set(record.key, [])
    byStage.get(record.key).push(record)
  }
  return groups.map(group => ({
    ...group,
    stages: group.stages.map(stage => {
      const atStage = byStage.get(stageKey({ ...stage, story: group.story, episode: group.episode })) ?? []
      const steps = {}
      for (const mode of MODES) {
        if (!stage[mode].length) continue
        const relevant = atStage.filter(record => record.mode === mode && record.team.some(name => stage[mode].includes(name)))
        const counts = relevant.map(record => record.steps).filter(Number.isInteger)
        if (counts.length) steps[mode] = Math.min(...counts)
      }
      return { ...stage, steps }
    }),
  }))
}
