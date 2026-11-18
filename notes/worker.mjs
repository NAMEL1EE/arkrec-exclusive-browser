const PAGE_SIZE = 30
const MAX_BODY = 4096
const NOTE_PATH = '/api/notes'
const UUID = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i

function validStageKey(value) {
  if (typeof value !== 'string' || value.length > 320) return false
  try {
    const parts = JSON.parse(value)
    return Array.isArray(parts) && parts.length === 3
      && parts.every(part => typeof part === 'string' && part.length > 0 && !/[\x00-\x1f\x7f]/.test(part))
      && /^(活动关卡|主线关卡)\/.+$/.test(parts[0])
      && value === JSON.stringify(parts)
  } catch {
    return false
  }
}

async function readJson(request) {
  const reader = request.body?.getReader()
  if (!reader) return null
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let size = 0
  let body = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > MAX_BODY) {
      await reader.cancel()
      throw new RangeError('大于请求上限')
    }
    body += decoder.decode(value, { stream: true })
  }
  return JSON.parse(body + decoder.decode())
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    const origin = request.headers.get('Origin')
    const headers = new Headers({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', Vary: 'Origin' })
    const reply = (data, status = 200) => Response.json(data, { status, headers })
    if (url.pathname !== NOTE_PATH) return reply({ error: '接口不存在。' }, 404)
    if (origin && origin !== env.PAGES_ORIGIN && origin !== url.origin) return reply({ error: '站点来源不匹配。' }, 403)
    if (origin) headers.set('Access-Control-Allow-Origin', origin)

    if (request.method === 'OPTIONS') {
      headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
      headers.set('Access-Control-Allow-Headers', 'Content-Type')
      headers.set('Access-Control-Max-Age', '600')
      return new Response(null, { status: 204, headers })
    }

    try {
      if (request.method === 'GET') {
        const stage = url.searchParams.get('stage')
        const cursor = url.searchParams.get('before')
        const before = cursor === null ? Number.MAX_SAFE_INTEGER : Number(cursor)
        if (!validStageKey(stage) || !Number.isSafeInteger(before) || before < 1) {
          return reply({ error: '关卡或分页参数无效。' }, 400)
        }

        const { results } = await env.NOTES_DB.prepare(
          'SELECT id, author_name, body, created_at FROM stage_notes WHERE stage_key = ? AND id < ? ORDER BY id DESC LIMIT ?',
        ).bind(stage, before, PAGE_SIZE + 1).all()
        const notes = results.slice(0, PAGE_SIZE)
        return reply({ notes, nextBefore: results.length > PAGE_SIZE ? notes.at(-1).id : null })
      }

      if (request.method === 'POST') {
        if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('Content-Type') ?? '')) {
          return reply({ error: '备注请求需要使用 JSON。' }, 415)
        }
        const ip = request.headers.get('CF-Connecting-IP') ?? 'local'
        const { success } = await env.NOTE_WRITES.limit({ key: ip })
        if (!success) {
          headers.set('Retry-After', '60')
          return reply({ error: '提交太频繁，请稍后再试。' }, 429)
        }
        let data
        try {
          data = await readJson(request)
        } catch (error) {
          const tooLarge = error instanceof RangeError
          return reply({ error: tooLarge ? '备注内容太长。' : '备注格式无效。' }, tooLarge ? 413 : 400)
        }
        const authorName = typeof data?.authorName === 'string' ? data.authorName.trim() : ''
        if (!authorName || authorName.length > 30 || /[\x00-\x1f\x7f]/.test(authorName)) {
          return reply({ error: '请填写 1–30 字的姓名或昵称。' }, 400)
        }
        const text = typeof data?.body === 'string' ? data.body.trim() : ''
        if (!validStageKey(data?.stage) || typeof data?.requestId !== 'string' || !UUID.test(data.requestId)
          || !text || text.length > 500 || /\x00/.test(text)) {
          return reply({ error: '请填写 1–500 字的备注。' }, 400)
        }
        const note = await env.NOTES_DB.prepare(
          'INSERT INTO stage_notes (request_id, stage_key, author_name, body, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(request_id) DO NOTHING RETURNING id, author_name, body, created_at',
        ).bind(data.requestId, data.stage, authorName, text, new Date().toISOString()).first()
        if (note) return reply({ note }, 201)
        const previous = await env.NOTES_DB.prepare(
          'SELECT id, author_name, body, created_at FROM stage_notes WHERE request_id = ? AND stage_key = ? AND author_name = ? AND body = ?',
        ).bind(data.requestId, data.stage, authorName, text).first()
        return previous ? reply({ note: previous }) : reply({ error: '请求冲突，请重新填写备注。' }, 409)
      }

      headers.set('Allow', 'GET, POST, OPTIONS')
      return reply({ error: '请求方式不支持。' }, 405)
    } catch (error) {
      console.error('notes-storage', error?.name)
      return reply({ error: '备注服务暂时不可用，请稍后再试。' }, 503)
    }
  },
}
