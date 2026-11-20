import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { captureExclusiveSample, emptyExclusiveSample } from './exclusive-history.mjs'

const flow = '解手流'
const shift = 8 * 60 * 60 * 1000
const monthOf = at => new Date(at + shift).toISOString().slice(0, 7)
const recordTime = row => Number.parseInt(row._id.slice(0, 8), 16) * 1_000

function stageKey(row, mode = row.operationType) {
  return JSON.stringify([row.story, row.episode, row.operation, row.cn_name, mode])
}

async function readArchive(directories) {
  const records = new Map()
  for (const directory of directories) {
    for (const file of await readdir(directory, { recursive: true, withFileTypes: true })) {
      if (!file.isFile() || !/^\d+\.json$/.test(file.name)) continue
      const page = JSON.parse(await readFile(join(file.parentPath, file.name), 'utf8'))
      for (const row of page.records) {
        if (row.category?.includes(flow) && /^[a-f0-9]{24}$/.test(row._id)) records.set(row._id, row)
      }
    }
  }
  return [...records.values()].sort((a, b) => a._id.localeCompare(b._id))
}

function score(row) {
  const remark = (row.remark1 ?? '').normalize('NFKC')
  const steps = Number(remark.match(/(?<![\d.+~–－-])(\d{1,3})[ \t]*步(?!骤)/u)?.[1] ?? Infinity)
  return { steps, remark }
}

function updateStage(stages, key, steps, team) {
  const current = stages.get(key)
  if (!current || steps < current.steps || (steps === current.steps && team.size < current.size)) {
    stages.set(key, { steps, size: team.size, shared: team })
    return
  }
  if (steps === current.steps && team.size === current.size) {
    current.shared = new Set([...current.shared].filter(name => team.has(name)))
  }
}

function sampleAt(stages, episodes, timestamp) {
  const at = new Date(timestamp).toISOString()
  const byOperator = new Map()
  for (const [key, { shared }] of stages) {
    if (!shared.size) continue
    const [story, episode, operation, cn_name, mode] = JSON.parse(key)
    const row = { story, episode, operation, cn_name, operationType: mode === 'challenge' ? '突袭' : '', category: flow }
    for (const name of shared) {
      if (!byOperator.has(name)) byOperator.set(name, { name, operations: [] })
      byOperator.get(name).operations.push(row)
    }
  }
  if (!byOperator.size) return emptyExclusiveSample(at)
  return captureExclusiveSample([...byOperator.values()], episodes, at, flow)
}

export function replay(records, episodes) {
  const stages = new Map()
  const samples = []
  let previousMonth
  for (const row of records) {
    const at = recordTime(row)
    const month = monthOf(at)
    if (previousMonth && previousMonth !== month) {
      const [year, previousMonthNumber] = previousMonth.split('-').map(Number)
      samples.push(sampleAt(stages, episodes, Date.UTC(year, previousMonthNumber, 1) - shift - 1))
    }
    previousMonth = month
    if (!['normal', 'challenge'].includes(row.operationType) || row.group?.includes('失效')
      || row.group === '旧纪录' && /失效/.test(row.remark1 ?? '') || !row.team?.length) continue
    const team = new Set(row.team.map(member => member.name).filter(Boolean))
    if (!team.size) continue
    const { steps, remark } = score(row)
    updateStage(stages, stageKey(row), steps, team)
    if (row.operationType === 'challenge' && !/不(?:适用于?|通用|适合).*普通/u.test(remark)) {
      updateStage(stages, stageKey(row, 'normal'), steps, team)
    }
  }
  if (!records.length) return samples
  samples.push(sampleAt(stages, episodes, recordTime(records.at(-1))))
  return samples
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [historyDir, partitionsDir, output] = process.argv.slice(2)
  if (!historyDir || !partitionsDir || !output) throw Error('需要提供全局缓存目录、分组缓存目录和输出文件')
  const prefix = 'window.ARKREC_SNAPSHOT = '
  const snapshotFile = new URL('../dist/snapshot.js', import.meta.url)
  const raw = await readFile(snapshotFile, 'utf8')
  const { wikiExclusiveHistory } = JSON.parse(raw.slice(prefix.length).trimEnd().replace(/;$/, ''))
  const records = await readArchive([historyDir, partitionsDir])
  const firstPage = JSON.parse(await readFile(join(historyDir, '0.json'), 'utf8'))
  if (!records.length || !Number.isInteger(firstPage.count)) throw Error('历史投稿缓存无效')
  const samples = replay(records, wikiExclusiveHistory.episodes)
  const result = { inputs: records.length, total: firstPage.count, samples }
  await writeFile(output, 'window.ARKREC_REPLAY_HISTORY = ' + JSON.stringify(result) + ';\n')
  console.log({ records: result.inputs, archivedTotal: result.total, first: samples[0]?.at, last: samples.at(-1)?.at, months: samples.length })
}
