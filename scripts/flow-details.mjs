const FLOW = '解手流'
const modes = ['normal', 'challenge']
const byCode = new Intl.Collator('zh-CN', { numeric: true })

// ArkRec's operation summary has no records for these story sequences.
const storyOnlyMainStages = new Set([
  '1-2', '6-17', 'JT8-1', '11-19', '14-10', '14-22',
  '15-2', '15-19', '16-9', '16-18', '17-16',
])

export const stageKey = row => JSON.stringify([row.story, row.episode, row.operation, row.cn_name])
export const isTrainingStage = operation => /(?:^|-)TR-?\d/i.test(operation)

export const isOverviewStage = (story, operation) =>
  !isTrainingStage(operation) && (story !== '主线关卡' || !storyOnlyMainStages.has(operation))

export function parseFlowRecord(row) {
  if (!Array.isArray(row.category) || !row.category.includes(FLOW) || row.group === '旧纪录'
    || !['活动关卡', '主线关卡'].includes(row.story) || !modes.includes(row.operationType)
    || (row.story === '活动关卡' && isTrainingStage(row.operation))
    || typeof row._id !== 'string' || !Array.isArray(row.team)
    || ![row.episode, row.operation, row.cn_name].every(value => typeof value === 'string' && value.length)
    || typeof row.remark1 !== 'string') return null

  const remark = row.remark1.normalize('NFKC')
  const steps = remark.match(/(?<![\d.+~–－-])(\d{1,3})[ \t]*步(?!骤)/u)
  if (!steps) return null

  const team = [...new Set(row.team.map(member => member?.name).filter(name => typeof name === 'string' && name))]
  if (!team.length) return null
  const tags = Array.isArray(row.sixStarRune)
    ? [...new Set(row.sixStarRune.filter(tag => typeof tag === 'string' && tag))].sort()
    : []
  const sandbox = row.story === '主线关卡' && row.operationType === 'challenge' && tags.length === 2
  const normalIncompatible = row.operationType === 'challenge' && /不适用于?\s*普通/u.test(remark)
  return {
    id: row._id, key: stageKey(row), mode: sandbox ? 'sandbox' : row.operationType, team,
    steps: Number(steps[1]),
    ...(normalIncompatible && { normalIncompatible }),
    ...(sandbox && { tags, server: row.server ?? 0 }),
  }
}

function lowestSteps(records, accept) {
  const steps = {}
  for (const record of records) {
    const { mode } = record
    if (!Number.isInteger(record.steps) || !accept(record)) continue
    if (steps[mode] === undefined || record.steps < steps[mode]) steps[mode] = record.steps
  }
  return steps
}

function shareStep(steps, mode, source, count) {
  if (steps[mode] === undefined && count !== undefined) {
    steps[mode] = count
    steps[mode + 'Shared'] = source
  }
}

function shareHigherSteps(steps, records, hasSandbox) {
  shareStep(steps, 'challenge', 'sandbox', steps.sandbox)
  if (steps.normal === undefined) {
    const eligible = lowestSteps(records, record =>
      !record.normalIncompatible && (record.mode !== 'sandbox' || hasSandbox)
    )
    const source = (eligible.challenge ?? Infinity) <= (eligible.sandbox ?? Infinity) ? 'challenge' : 'sandbox'
    shareStep(steps, 'normal', source, eligible[source])
  }
  return steps
}

function exclusiveAtMinimum(records) {
  if (!records.length) return []
  const steps = Math.min(...records.map(record => record.steps))
  const teams = records.filter(record => record.steps === steps).map(record => record.team)
  return teams[0].filter(name => teams.every(team => team.includes(name)))
}

function splitDifficulties(stage, records) {
  const sandbox = exclusiveAtMinimum(records.filter(record => record.mode === 'sandbox'))
  const challenge = exclusiveAtMinimum(records.filter(record => record.mode === 'challenge' || record.mode === 'sandbox'))
  const normal = exclusiveAtMinimum(records.filter(record => !record.normalIncompatible))
  return {
    operation: stage.operation, cn_name: stage.cn_name,
    normal, challenge, ...(sandbox.length && { sandbox }),
  }
}

export function withFlowSteps(groups, records) {
  const byStage = new Map()
  for (const record of records) {
    if (!byStage.has(record.key)) byStage.set(record.key, [])
    byStage.get(record.key).push(record)
  }
  return groups.map(group => {
    const keyOf = stage => stageKey({ ...stage, story: group.story, episode: group.episode })
    const recordsAt = stage => byStage.get(keyOf(stage)) ?? []
    const activity = group.story === '活动关卡'
    const runeKeys = new Set((group.runeStages ?? []).map(keyOf))
    const stages = group.stages.filter(stage =>
      !runeKeys.has(keyOf(stage)) && (!activity || !isTrainingStage(stage.operation))
    ).map(({ steps, ...stage }) => stage)

    for (const stage of group.runeStages ?? []) {
      const split = splitDifficulties(stage, recordsAt(stage))
      if (split.normal.length || split.challenge.length || split.sandbox?.length) stages.push(split)
    }
    if (runeKeys.size) stages.sort((a, b) => byCode.compare(a.operation, b.operation) || byCode.compare(a.cn_name, b.cn_name))

    return {
      ...group, stages,
      ...(group.overview && {
        overview: group.overview.filter(stage => isOverviewStage(group.story, stage.operation)).map(stage => {
          const records = recordsAt(stage)
          const steps = lowestSteps(records, record => record.mode !== 'sandbox' || stage.hasSandbox)
          return { ...stage, steps: stage.hasChallenge ? shareHigherSteps(steps, records, stage.hasSandbox) : steps }
        }),
      }),
    }
  })
}
