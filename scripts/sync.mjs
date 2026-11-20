import { mkdir, open, readFile, readdir, realpath, rename, unlink, writeFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { setTimeout as wait } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { normalizeOpenEpisodes, updateWikiHistory } from './exclusive-history.mjs'
import { isOverviewStage, isTrainingStage, parseFlowRecord, stageKey, withFlowSteps } from './flow-details.mjs'

export const FLOW = '解手流'
const STORIES = ['活动关卡', '主线关卡']
const ORIGIN = 'https://wiki.arkrec.com'
const PREFIX = 'window.ARKREC_SNAPSHOT = '
const snapshotFile = fileURLToPath(new URL('../dist/snapshot.js', import.meta.url))
const flowRecordsFile = fileURLToPath(new URL('../data/flow-records.json', import.meta.url))
const byCode = new Intl.Collator('zh-CN', { numeric: true })
const exclusivePath = '/v1/api/exclusive-operators'
const openEpisodesPath = '/v1/user/open-episodes'

const groupKey = (story, episode) => story + '/' + episode
const relevant = row => STORIES.includes(row.story)
  && (row.story !== '活动关卡' || !isTrainingStage(row.operation))

function requireStage(row) {
  if (![row.story, row.episode, row.operation, row.cn_name].every(value => typeof value === 'string' && value.length)) {
    throw new Error('源站返回了缺少关卡标识的记录')
  }
}

export function getExclusive(source, targetKeys) {
  if (!Array.isArray(source) || !source.length) throw new Error('源站独享汇总为空或结构异常')
  const stages = new Map()
  for (const { name, operations } of source) {
    if (typeof name !== 'string' || !name || !Array.isArray(operations)) throw new Error('源站独享汇总结构异常')
    for (const row of operations) {
      if (row.category !== FLOW || !relevant(row)) continue
      requireStage(row)
      const key = stageKey(row)
      if (targetKeys && !targetKeys.has(key)) continue
      const stage = stages.get(key) ?? {
        story: row.story, episode: row.episode, operation: row.operation, cn_name: row.cn_name,
        normal: [], challenge: [],
      }
      const kind = String(row.operationType ?? '').trim()
      if (kind !== '' && kind !== '突袭') throw new Error('识别到新的关卡难度 ' + kind)
      const operators = kind === '突袭' ? stage.challenge : stage.normal
      if (!operators.includes(name)) operators.push(name)
      stages.set(key, stage)
    }
  }
  if (!targetKeys && !stages.size) throw new Error('独享汇总中没有找到活动或主线的解手流数据')
  return stages
}

function getCatalog(menu) {
  const stories = menu?.childNodes
  if (!Array.isArray(stories) || !STORIES.every(name => stories.some(story => story.story === name))) {
    throw new Error('源站关卡目录结构异常')
  }
  const catalog = new Map()
  for (const { story, childNodes } of stories.filter(relevant)) {
    if (!Array.isArray(childNodes) || !childNodes.length) throw new Error('源站章节目录为空')
    for (const { episode, index, implDate, childNodes: operations } of childNodes) {
      if (typeof episode !== 'string' || !episode) throw new Error('源站目录缺少章节名')
      const eventCode = story === '活动关卡'
        ? operations?.map(stage => stage.operation?.match(/^([A-Z]{2})-/)?.[1]).find(Boolean) ?? null
        : null
      const overview = Array.isArray(operations)
        ? operations.filter(stage => typeof stage.operation === 'string' && stage.operation.length
          && isOverviewStage(story, stage.operation) && typeof stage.cn_name === 'string' && stage.cn_name.length).map(stage => ({
          operation: stage.operation,
          cn_name: stage.cn_name,
          zone: stage.zone || '',
          hasChallenge: Boolean(stage.hasChallenge),
          ...(story === '主线关卡' && index >= 15 && stage.sixStarRuneData?.length && { hasSandbox: true }),
        }))
        : undefined
      const runeStages = story === '主线关卡' && index >= 15 && Array.isArray(operations)
        ? operations.filter(stage => stage.sixStarRuneData?.length).map(stage => ({
          operation: stage.operation, cn_name: stage.cn_name,
        }))
        : []
      catalog.set(groupKey(story, episode), {
        id: groupKey(story, episode), story, episode,
        chapter: story === '主线关卡' && Number.isInteger(index) ? index : null,
        eventCode, release: implDate ?? null, stages: [], ...(overview && { overview }),
        ...(runeStages.length && { runeStages }),
      })
    }
  }
  return catalog
}

function buildGroups(catalog, stages) {
  const groups = new Map([...catalog].map(([id, group]) => [id, { ...group, stages: [] }]))
  for (const stage of stages.values()) {
    const { story, episode, operation, cn_name, normal, challenge } = stage
    const id = groupKey(story, episode)
    const chapter = story === '主线关卡' ? Number(operation.match(/^[A-Z]*(\d+)-/i)?.[1] ?? NaN) : NaN
    const group = groups.get(id) ?? { id, story, episode, chapter: Number.isFinite(chapter) ? chapter : null, release: null, stages: [] }
    group.stages.push({ operation, cn_name, normal, challenge })
    groups.set(id, group)
  }
  return [...groups.values()].sort((left, right) =>
    STORIES.indexOf(left.story) - STORIES.indexOf(right.story)
    || (right.chapter ?? -1) - (left.chapter ?? -1)
    || String(right.release ?? '').localeCompare(String(left.release ?? ''))
    || byCode.compare(left.episode, right.episode)
  ).map(group => ({
    ...group,
    stages: group.stages.sort((left, right) => byCode.compare(left.operation, right.operation) || byCode.compare(left.cn_name, right.cn_name)),
  }))
}

export function initialSnapshot(source, menu, capturedAt, etag = null) {
  if (!Number.isFinite(Date.parse(capturedAt))) throw new Error('需要指定首份快照的采集时间')
  return {
    schema: 1, flow: FLOW, capturedAt, syncedAt: capturedAt,
    cursor: { at: capturedAt, id: null }, etag,
    groups: buildGroups(getCatalog(menu), getExclusive(source)),
  }
}

function recordTime(id) {
  if (typeof id !== 'string' || !/^[0-9a-f]{24}$/.test(id)) throw new Error('源站记录 ID 格式发生变化')
  return new Date(Number.parseInt(id.slice(0, 8), 16) * 1000).toISOString()
}

export async function findChanges(request, cursor, maxPages = 32) {
  let headId = null
  let lastId = null
  let skip = 0
  const targets = new Map()
  const newDetails = []
  function result() {
    return { targets, newDetails, cursor: headId ? { id: headId, at: recordTime(headId) } : cursor }
  }
  for (let page = 0; page < maxPages; page += 1) {
    const { data } = await request('/v1/record/latest-records', { skip })
    if (!Array.isArray(data)) throw new Error('源站最新记录结构异常')
    if (!data.length) {
      if (cursor.id !== null) throw new Error('最新记录翻到底仍未找到上次的游标')
      return result()
    }
    for (const row of data) {
      const id = row._id
      const at = recordTime(id)
      if (lastId !== null && id > lastId) throw new Error('最新记录分页顺序发生变化，请稍后重新执行')
      if (cursor.id ? id <= cursor.id : Date.parse(at) + 1000 <= Date.parse(cursor.at)) return result()
      if (!Array.isArray(row.category)) throw new Error('源站最新记录缺少流派字段')
      headId ??= id
      if (id !== lastId && row.category.includes(FLOW) && relevant(row)) {
        requireStage(row)
        targets.set(stageKey(row), row)
        const detail = parseFlowRecord(row)
        if (detail) newDetails.push(detail)
      }
      lastId = id
    }
    skip += data.length
  }
  throw new Error('本次已达到最新记录请求上限，已保留原快照和游标。可在低峰时提高 --max-pages 单次追平。')
}

export async function updateSnapshot(snapshot, request, maxPages) {
  const { targets, newDetails, cursor } = await findChanges(request, snapshot.cursor, maxPages)
  const episodes = normalizeOpenEpisodes((await request(openEpisodesPath)).data)
  const previous = snapshot.wikiExclusiveHistory
  const cached = previous?.details && previous.samples.length && JSON.stringify(previous.episodes) === JSON.stringify(episodes)
  // A 304 must cover both consumers when the stage list also needs updating.
  const conditionalEtag = cached && (!targets.size || previous.etag === snapshot.etag) ? previous.etag : undefined
  const result = await request(exclusivePath, undefined, conditionalEtag)
  const syncedAt = new Date().toISOString()
  const wikiExclusiveHistory = updateWikiHistory(previous, result, episodes, syncedAt, FLOW)
  let groups = snapshot.groups
  let etag = snapshot.etag
  if (targets.size) {
    const unchanged = result.unchanged || (result.etag && result.etag === snapshot.etag)
    const catalog = new Map(groups.map(group => [group.id, group]))
    const needsMenu = [...targets.values()].some(row => {
      const group = catalog.get(groupKey(row.story, row.episode))
      const isStage = stage => stage.operation === row.operation && stage.cn_name === row.cn_name
      return !group || (isOverviewStage(row.story, row.operation) && !group.overview?.some(isStage))
        || (row.story === '主线关卡' && row.sixStarRune?.length === 2 && !group.runeStages?.some(isStage))
    })
    if (needsMenu) {
      const { data } = await request('/v1/api/menu?lang=0')
      for (const [id, group] of getCatalog(data)) catalog.set(id, group)
    }
    if (!unchanged || needsMenu) {
      const stages = new Map()
      for (const group of groups) {
        for (const row of group.stages) {
          const stage = { ...row, story: group.story, episode: group.episode }
          const key = stageKey(stage)
          if (unchanged || !targets.has(key)) stages.set(key, stage)
        }
      }
      if (!unchanged) {
        for (const [key, stage] of getExclusive(result.data, targets)) stages.set(key, stage)
        etag = result.etag
      }
      groups = buildGroups(catalog, stages)
    }
  }
  console.log('本次涉及 ' + targets.size + ' 个有新解手流记录的关卡')
  const records = new Map((snapshot.flowRecords ?? []).map(record => [record.id, record]))
  for (const detail of newDetails) records.set(detail.id, detail)
  const flowRecords = [...records.values()]
  if (targets.size && flowRecords.length) groups = withFlowSteps(groups, flowRecords)
  return { ...snapshot, groups, cursor, etag, flowRecords, syncedAt, wikiExclusiveHistory }
}

function makeClient() {
  let nextRequestAt = 0
  return async (path, body, etag) => {
    await wait(Math.max(0, nextRequestAt - Date.now()))
    const headers = { Accept: 'application/json', 'User-Agent': 'ArkRec-Exclusive-Browser/1.0 (manual snapshot)' }
    if (body) headers['Content-Type'] = 'application/json'
    if (etag) headers['If-None-Match'] = etag
    headers['Cache-Control'] = 'no-cache'
    try {
      const response = await fetch(ORIGIN + path, {
        method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(50_000),
      })
      if (response.status === 304 && etag) return { unchanged: true, etag }
      if (!response.ok) throw new Error('源站 HTTP ' + response.status + ' ' + path)
      return { data: await response.json(), etag: response.headers.get('etag') }
    } finally {
      nextRequestAt = Date.now() + 1500
    }
  }
}

async function collectFlowPages(directory, records, { partial = false, group } = {}) {
  const rest = await readdir(directory)
  const offsets = rest.filter(name => /^\d+\.json$/.test(name))
    .map(name => Number.parseInt(name, 10)).sort((left, right) => left - right)
  const first = JSON.parse(await readFile(join(directory, '0.json'), 'utf8'))
  if (first.count === 0 && Array.isArray(first.records) && !first.records.length) return
  const pageSize = first.records?.length
  if (!Number.isInteger(first.count) || !pageSize || first.count < pageSize
    || (!partial && offsets.at(-1) + pageSize < first.count)
    || offsets.some((skip, index) => skip !== index * pageSize)) {
    throw new Error('历史备注分页不齐，目录 ' + directory)
  }

  for (const skip of offsets) {
    const page = skip ? JSON.parse(await readFile(join(directory, skip + '.json'), 'utf8')) : first
    if (!Array.isArray(page.records) || page.records.length < Math.min(pageSize, first.count - skip)) {
      throw new Error('历史备注分页内容异常，起点 ' + skip)
    }
    for (const row of page.records) {
      if (group && (row.story !== group[0] || row.episode !== group[1])) {
        throw new Error('发现记录不属于目标活动或主线章节')
      }
      const entry = parseFlowRecord(row)
      if (entry) records.set(entry.id, entry)
      else if (row.group === '旧纪录') records.delete(row._id)
    }
  }
}

async function loadFlowDetails(directory, partitionsDir) {
  if (!directory) throw new Error('需要通过 --records-dir 指定历史分页目录')
  const records = new Map()
  await collectFlowPages(await realpath(directory), records, { partial: Boolean(partitionsDir) })

  if (partitionsDir) {
    const path = await realpath(partitionsDir)
    const targets = JSON.parse(await readFile(join(path, 'targets.json'), 'utf8'))
    if (!Array.isArray(targets) || !targets.length) throw new Error('缺少历史备注的分组清单')
    for (const [index, group] of targets.entries()) {
      await collectFlowPages(join(path, String(index)), records, { group })
    }
  }
  if (!records.size) throw new Error('历史备注中没有可用的活动或主线步数')
  return [...records.values()]
}

async function atomicWrite(path, content) {
  const temp = path + '.' + process.pid + '.tmp'
  await writeFile(temp, content, { encoding: 'utf8', flag: 'wx' })
  await rename(temp, path)
}

async function readFlowIndex() {
  const raw = await readFile(flowRecordsFile, 'utf8').catch(error => {
    if (error.code !== 'ENOENT') throw error
    return '[]'
  })
  return JSON.parse(raw)
}

async function main() {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: {
    'snapshot-file': { type: 'string' }, 'menu-file': { type: 'string' },
    'captured-at': { type: 'string' }, 'records-dir': { type: 'string' }, 'partitions-dir': { type: 'string' }, 'max-pages': { type: 'string', default: '32' },
  } })
  const [command] = positionals
  const request = makeClient()
  const current = await readFile(snapshotFile, 'utf8').catch(error => {
    if (error.code !== 'ENOENT') throw error
    return null
  })
  let snapshot
  if (command === 'init') {
    if (current !== null) throw new Error('已存在首份快照，请使用 update')
    const sourceFile = values['snapshot-file']
    const menuFile = values['menu-file']
    if (Boolean(sourceFile) !== Boolean(menuFile) || (sourceFile && !values['captured-at'])) {
      throw new Error('本地导入需要同时指定 --snapshot-file、--menu-file 和 --captured-at')
    }
    const menu = menuFile ? JSON.parse(await readFile(menuFile, 'utf8')) : (await request('/v1/api/menu?lang=0')).data
    const episodes = sourceFile ? null : normalizeOpenEpisodes((await request(openEpisodesPath)).data)
    const source = sourceFile ? { data: JSON.parse(await readFile(sourceFile, 'utf8')), etag: null } : await request(exclusivePath)
    const capturedAt = values['captured-at'] ?? new Date().toISOString()
    snapshot = initialSnapshot(source.data, menu, capturedAt, source.etag)
    if (episodes) {
      snapshot.wikiExclusiveHistory = updateWikiHistory(undefined, source, episodes, new Date().toISOString(), FLOW)
    }
  } else if (command === 'update') {
    const maxPages = Number(values['max-pages'])
    if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 100) throw new Error('--max-pages 应为 1 到 100 的整数')
    if (!current?.startsWith(PREFIX)) throw new Error('当前没有有效快照，请先执行 init')
    snapshot = JSON.parse(current.slice(PREFIX.length).trimEnd().replace(/;$/, ''))
    if (snapshot.schema !== 1 || snapshot.flow !== FLOW) throw new Error('快照版本或流派不匹配')
    snapshot = await updateSnapshot({ ...snapshot, flowRecords: await readFlowIndex() }, request, maxPages)
  } else if (command === 'details') {
    if (!current?.startsWith(PREFIX)) throw new Error('当前没有有效快照，请先执行 init')
    const previous = JSON.parse(current.slice(PREFIX.length).trimEnd().replace(/;$/, ''))
    if (previous.schema !== 1 || previous.flow !== FLOW) throw new Error('快照版本或流派不匹配')
    const flowRecords = values['records-dir']
      ? await loadFlowDetails(values['records-dir'], values['partitions-dir'])
      : await readFlowIndex()
    if (!flowRecords.length) throw new Error('缺少可用步数，请先导入历史备注')
    let groups = previous.groups
    if (values['menu-file']) {
      const catalog = getCatalog(JSON.parse(await readFile(values['menu-file'], 'utf8')))
      groups = groups.map(group => ({ ...group, ...catalog.get(group.id), stages: group.stages }))
    }
    snapshot = { ...previous, flowRecords, groups: withFlowSteps(groups, flowRecords) }
  } else {
    throw new Error('用法 node scripts/sync.mjs init|update|details')
  }
  delete snapshot.exclusiveHistory
  const { flowRecords, ...publicSnapshot } = snapshot
  if (flowRecords) {
    await mkdir(dirname(flowRecordsFile), { recursive: true })
    // Commit the source index first so retrying from the published cursor can safely deduplicate it.
    await atomicWrite(flowRecordsFile, JSON.stringify(flowRecords) + '\n')
  }
  await atomicWrite(snapshotFile, PREFIX + JSON.stringify(publicSnapshot) + ';\n')
  console.log('已保存快照，共 ' + snapshot.groups.reduce((sum, group) => sum + group.stages.length, 0) + ' 个关卡')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const lockPath = snapshotFile + '.lock'
  const run = async () => {
    const lock = await open(lockPath, 'wx')
    try {
      await main()
    } finally {
      await lock.close()
      await unlink(lockPath)
    }
  }
  run().catch(error => {
    console.error(error.message)
    process.exitCode = 1
  })
}
