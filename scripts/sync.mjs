import { open, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { setTimeout as wait } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const FLOW = '解手流'
const STORIES = ['活动关卡', '主线关卡']
const ORIGIN = 'https://wiki.arkrec.com'
const PREFIX = 'window.ARKREC_SNAPSHOT = '
const snapshotFile = fileURLToPath(new URL('../dist/snapshot.js', import.meta.url))
const byCode = new Intl.Collator('zh-CN', { numeric: true })
const exclusivePath = '/v1/api/exclusive-operators'

const stageKey = row => JSON.stringify([row.story, row.episode, row.operation, row.cn_name])
const groupKey = (story, episode) => story + '/' + episode
const relevant = row => STORIES.includes(row.story)

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
      catalog.set(groupKey(story, episode), {
        id: groupKey(story, episode), story, episode,
        chapter: story === '主线关卡' && Number.isInteger(index) ? index : null,
        eventCode, release: implDate ?? null, stages: [],
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
  function result() {
    return { targets, cursor: headId ? { id: headId, at: recordTime(headId) } : cursor }
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
      }
      lastId = id
    }
    skip += data.length
  }
  throw new Error('本次已达到最新记录请求上限，已保留原快照和游标。可在低峰时提高 --max-pages 单次追平。')
}

export async function updateSnapshot(snapshot, request, maxPages) {
  const { targets, cursor } = await findChanges(request, snapshot.cursor, maxPages)
  let groups = snapshot.groups
  let etag = snapshot.etag
  if (targets.size) {
    const result = await request(exclusivePath, undefined, snapshot.etag)
    if (!result.unchanged) {
      const catalog = new Map(groups.map(group => [group.id, group]))
      if ([...targets.values()].some(row => !catalog.has(groupKey(row.story, row.episode)))) {
        const { data } = await request('/v1/api/menu?lang=0')
        for (const [id, group] of getCatalog(data)) catalog.set(id, group)
      }
      const stages = new Map()
      for (const group of groups) {
        for (const row of group.stages) {
          const stage = { ...row, story: group.story, episode: group.episode }
          const key = stageKey(stage)
          if (!targets.has(key)) stages.set(key, stage)
        }
      }
      for (const [key, stage] of getExclusive(result.data, targets)) stages.set(key, stage)
      groups = buildGroups(catalog, stages)
      etag = result.etag
    }
  }
  console.log('本次涉及 ' + targets.size + ' 个有新解手流记录的关卡')
  return { ...snapshot, groups, cursor, etag, syncedAt: new Date().toISOString() }
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

async function main() {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: {
    'snapshot-file': { type: 'string' }, 'menu-file': { type: 'string' },
    'captured-at': { type: 'string' }, 'max-pages': { type: 'string', default: '32' },
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
    const capturedAt = values['captured-at'] ?? new Date().toISOString()
    const source = sourceFile ? { data: JSON.parse(await readFile(sourceFile, 'utf8')), etag: null } : await request(exclusivePath)
    snapshot = initialSnapshot(source.data, menu, capturedAt, source.etag)
  } else if (command === 'update') {
    const maxPages = Number(values['max-pages'])
    if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 100) throw new Error('--max-pages 应为 1 到 100 的整数')
    if (!current?.startsWith(PREFIX)) throw new Error('当前没有有效快照，请先执行 init')
    snapshot = JSON.parse(current.slice(PREFIX.length).trimEnd().replace(/;$/, ''))
    if (snapshot.schema !== 1 || snapshot.flow !== FLOW) throw new Error('快照版本或流派不匹配')
    snapshot = await updateSnapshot(snapshot, request, maxPages)
  } else {
    throw new Error('用法 node scripts/sync.mjs init|update')
  }
  const temp = snapshotFile + '.' + process.pid + '.tmp'
  await writeFile(temp, PREFIX + JSON.stringify(snapshot) + ';\n', { encoding: 'utf8', flag: 'wx' })
  await rename(temp, snapshotFile)
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
