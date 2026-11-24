import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

const clientSource = 'https://raw.githubusercontent.com/Kengxxiao/ArknightsGameData/master/zh_CN/gamedata/excel/activity_table.json'
const officialNews = 'https://ak.hypergryph.com/news'
const output = new URL('../dist/event-schedule.js', import.meta.url)
const prefix = 'window.ARKREC_EVENT_SCHEDULE = '
const { values: args } = parseArgs({ options: { client: { type: 'string' }, 'news-dir': { type: 'string' } } })
const now = Math.floor(Date.now() / 1000)
const chinaOffset = 8 * 60 * 60
const datePart = '(?:(20\\d{2})年\\s*)?(\\d{1,2})月\\s*(\\d{1,2})日\\s*(\\d{1,2}):(\\d{2})'
const dateRange = new RegExp(datePart + '\\s*(?:至|到|[-–—~～]+)\\s*' + datePart)

async function fetchText(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) })
  if (!response.ok) throw new Error('HTTP ' + response.status + ' ' + url)
  return response.text()
}

async function newsPage(cid) {
  const file = cid ? 'news-' + cid + '.html' : 'news.html'
  return args['news-dir'] ? readFile(join(args['news-dir'], file), 'utf8') : fetchText(officialNews + (cid ? '/' + cid : ''))
}

// The public news page serializes its initial activity index as Next.js component props.
function activityNotices(html) {
  for (const [, raw] of html.matchAll(/self\.__next_f\.push\((\[[^\r\n]*?\])\)<\/script>/g)) {
    let payload
    try { [, payload] = JSON.parse(raw) } catch { continue }
    if (typeof payload !== 'string' || !payload.includes('"initialData"')) continue
    for (const row of payload.split('\n')) {
      const start = row.indexOf(':') + 1
      if (!row.startsWith('[', start)) continue
      let model
      try { model = JSON.parse(row.slice(start)) } catch { continue }
      const items = model?.[3]?.initialData?.ACTIVITY?.list
      if (Array.isArray(items)) return items
    }
  }
  throw new Error('官网活动新闻列表格式发生变化')
}

function chinaDate(year, month, day, hour, minute) {
  const value = new Date(Date.UTC(year, month - 1, day, hour, minute))
  if (value.getUTCFullYear() !== year || value.getUTCMonth() !== month - 1 || value.getUTCDate() !== day
      || value.getUTCHours() !== hour || value.getUTCMinutes() !== minute) return NaN
  return value.getTime() / 1000 - chinaOffset
}

function readRange(text, publishedAt) {
  const parts = dateRange.exec(text.normalize('NFKC'))
  if (!parts) return null
  const [year, month, day, hour, minute, endYear, endMonth, endDay, endHour, endMinute] = parts.slice(1).map(Number)
  const published = new Date((publishedAt + chinaOffset) * 1000)
  const publishedYear = published.getUTCFullYear()
  const publishedMonth = published.getUTCMonth() + 1
  const startYear = year || publishedYear + (publishedMonth - month > 6 ? 1 : month - publishedMonth > 6 ? -1 : 0)
  const start = chinaDate(startYear, month, day, hour, minute)
  const end = chinaDate(endYear || startYear + Number(endMonth < month), endMonth, endDay, endHour, endMinute) + 59
  return start < end && end - start < 45 * 86400 ? { start, end } : null
}

function noticeWindow(html, publishedAt) {
  const body = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
  const lines = [...body.matchAll(/<p(?:\s[^>]*)?>([\s\S]*?)<\/p>/gi)].map(([, text]) => text
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(?:nbsp|#160);/gi, ' ')
    .replace(/&(?:ndash|mdash);/gi, '-')
    .replace(/\s+/g, ' ').trim()).filter(Boolean)
  const heading = lines.findIndex(line => /^(?:活动)?关卡(?:开启|开放)时间\s*[:：]/.test(line))
  const first = heading < 0 ? lines.find(line => /^活动时间\s*[:：]/.test(line)) : lines[heading]
  if (!first) return null
  const windows = [readRange(first, publishedAt)].filter(Boolean)
  if (heading >= 0) {
    for (const line of lines.slice(heading + 1)) {
      const span = readRange(line, publishedAt)
      if (!span) break
      windows.push(span)
    }
  }
  if (!windows.length) return null
  return { start: Math.min(...windows.map(window => window.start)), end: Math.max(...windows.map(window => window.end)) }
}

async function sourceOrPrevious(label, load, previous) {
  try {
    return await load()
  } catch (error) {
    console.warn(label + '：' + error.message)
    return previous
  }
}

async function readClientSchedule() {
  const html = args.client ? await readFile(args.client, 'utf8') : await fetchText(clientSource)
  const rows = Object.values(JSON.parse(html)?.basicInfo ?? {})
  const stages = rows.filter(row => row?.hasStage === true && typeof row.name === 'string' && row.name.trim()
    && Number.isSafeInteger(row.startTime) && Number.isSafeInteger(row.endTime) && row.startTime < row.endTime)
  if (!stages.length) throw new Error('活动日程没有有效的关卡开放记录')
  return stages.map(row => ({ name: row.name, start: row.startTime, end: row.endTime, rerun: row.isReplicate === true }))
}

const previousText = await readFile(output, 'utf8')
if (!previousText.startsWith(prefix)) throw new Error('现有活动日程格式无效')
const previous = JSON.parse(previousText.slice(prefix.length))
const announced = previous.filter(event => event.noticeId && event.end >= now)
const known = new Set(announced.map(event => event.noticeId))
const headlines = await sourceOrPrevious('官网活动新闻暂不可用', async () => activityNotices(await newsPage()), [])
// Fetch at most five previously unseen rerun announcements, never a full news archive.
const candidates = headlines.filter(row => /^\d+$/.test(row.cid) && row.displayTime > now - 45 * 86400
  && /[「〖《][^」〗》]+[」〗》]\s*(?:限时)?复刻/.test(row.title) && !known.has(row.cid)).slice(0, 5)
for (const { cid, title, displayTime } of candidates) {
  const event = await sourceOrPrevious('无法读取复刻公告 ' + cid, async () => {
    const name = title.match(/[「〖《]([^」〗》]+)[」〗》]\s*(?:限时)?复刻/)[1]
    const window = noticeWindow(await newsPage(cid), displayTime)
    return window && { name, ...window, rerun: true, noticeId: cid }
  }, null)
  if (event && event.end >= now) announced.push(event)
}

const client = await sourceOrPrevious('客户端活动日程暂不可用', readClientSchedule, previous.filter(event => !event.noticeId))
const eventName = value => value.normalize('NFKC').replace(/\s/g, '')
const overlaps = (a, b) => a.rerun === b.rerun && eventName(a.name) === eventName(b.name) && a.start <= b.end && b.start <= a.end
const schedule = [...announced, ...client.filter(row => !announced.some(event => overlaps(row, event)))]
  .filter(event => event.end >= now)
  .sort((a, b) => b.start - a.start || a.name.localeCompare(b.name, 'zh-CN'))
const updated = prefix + JSON.stringify(schedule) + '\n'
if (updated !== previousText) {
  const temp = new URL('../dist/event-schedule.js.tmp', import.meta.url)
  await writeFile(temp, updated, 'utf8')
  await rename(temp, output)
}
console.log('已同步 ' + schedule.length + ' 项活动关卡日程，其中 ' + announced.length + ' 项来自官网复刻公告')
