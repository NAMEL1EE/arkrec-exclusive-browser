const COOLDOWN_MINUTES = 5
const COOLDOWN = COOLDOWN_MINUTES * 60 * 1000
const REPOSITORY = /^[\w.-]+\/[\w.-]+$/

const readState = db => db.prepare('SELECT next_at, state, run_id FROM site_refresh WHERE id = ?').bind(1).first()

function publicState(row, now, repo, preview) {
  const nextAt = row?.next_at > now ? row.next_at : null
  return {
    nextAt,
    cooldownMinutes: COOLDOWN_MINUTES,
    state: nextAt ? row.state : 'ready',
    runUrl: nextAt && row.run_id && repo ? 'https://github.com/' + repo + '/actions/runs/' + row.run_id : null,
    preview,
  }
}

async function requestWorkflow(repo, token) {
  const response = await fetch('https://api.github.com/repos/' + repo + '/actions/workflows/pages.yml/dispatches', {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json',
      'User-Agent': 'ArkRec-Exclusive-Refresh/1.0',
      'X-GitHub-Api-Version': '2026-03-10',
    },
    body: JSON.stringify({ ref: 'main', inputs: { refresh: true, max_pages: 32 } }),
    signal: AbortSignal.timeout(12_000),
    redirect: 'manual',
  })
  if (!response.ok) throw new Error('GitHub dispatch HTTP ' + response.status)
  const details = response.status === 204 ? null : await response.json()
  return Number.isSafeInteger(details?.workflow_run_id) && details.workflow_run_id > 0 ? details.workflow_run_id : null
}

export async function handleRefresh(request, env, headers, reply) {
  const preview = env.REFRESH_PREVIEW === true
  const repo = env.GITHUB_REPOSITORY
  if (!preview && (!env.GITHUB_REFRESH_TOKEN || !REPOSITORY.test(repo ?? ''))) {
    return reply({ error: '在线更新尚未启用。' }, 503)
  }

  const db = env.NOTES_DB
  if (request.method === 'GET') return reply(publicState(await readState(db), Date.now(), repo, preview))
  if (request.method !== 'POST') {
    headers.set('Allow', 'GET, POST, OPTIONS')
    return reply({ error: '请求方式不支持。' }, 405)
  }
  if (!request.headers.has('Origin')) return reply({ error: '请通过本站提交更新。' }, 403)

  const now = Date.now()
  const nextAt = now + COOLDOWN
  // Reserve the slot before dispatching. Parallel requests compete for the same D1 row.
  const claim = await db.prepare(
    "INSERT INTO site_refresh (id, next_at, state) VALUES (1, ?, 'dispatching') "
    + "ON CONFLICT(id) DO UPDATE SET next_at = excluded.next_at, state = excluded.state, run_id = NULL "
    + 'WHERE site_refresh.next_at <= ? RETURNING next_at, state, run_id',
  ).bind(nextAt, now).first()
  if (!claim) {
    const state = publicState(await readState(db), now, repo, preview)
    if (state.nextAt) headers.set('Retry-After', String(Math.ceil((state.nextAt - now) / 1000)))
    return reply({ ...state, error: '全站更新正在冷却。' }, 429)
  }

  let state = 'queued'
  let runId = null
  try {
    if (!preview) runId = await requestWorkflow(repo, env.GITHUB_REFRESH_TOKEN)
  } catch (error) {
    console.error('refresh-dispatch', error?.message)
    state = 'failed'
  }
  // Keep the cooldown on a failure or timeout, since dispatch may already have reached GitHub.
  await db.prepare('UPDATE site_refresh SET state = ?, run_id = ? WHERE id = 1 AND next_at = ?')
    .bind(state, runId, nextAt).run()
  const result = publicState({ next_at: nextAt, state, run_id: runId }, now, repo, preview)
  return reply(result, state === 'queued' ? 202 : 502)
}
