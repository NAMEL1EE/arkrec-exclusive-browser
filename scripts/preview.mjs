import { createServer } from 'node:http'
import { mkdir, readFile, readdir } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import worker from '../notes/worker.mjs'

const port = Number(process.argv[2] ?? 9317)
const dataDir = new URL('../.local/', import.meta.url)
await mkdir(dataDir, { recursive: true })
const database = new DatabaseSync(fileURLToPath(new URL('stage-notes.sqlite', dataDir)))
database.exec('PRAGMA journal_mode=WAL')
const migrationsDir = new URL('../notes/migrations/', import.meta.url)
const migrations = (await readdir(migrationsDir)).filter(name => /^\d{4}-.*\.sql$/.test(name)).sort()
let version = database.prepare('PRAGMA user_version').get().user_version
for (const name of migrations) {
  const number = Number(name.slice(0, 4))
  if (number <= version) continue
  const sql = await readFile(new URL(name, migrationsDir), 'utf8')
  // Recheck inside the transaction in case another preview process migrated the database.
  database.exec('BEGIN IMMEDIATE')
  try {
    version = database.prepare('PRAGMA user_version').get().user_version
    if (number > version) {
      database.exec(sql)
      database.exec('PRAGMA user_version = ' + number)
      version = number
    }
    database.exec('COMMIT')
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
}

const limits = new Map()
const env = {
  REFRESH_PREVIEW: true,
  NOTES_DB: {
    prepare(sql) {
      const statement = database.prepare(sql)
      return { bind: (...args) => ({
        first: async () => statement.get(...args) ?? null,
        run: async () => statement.run(...args),
        all: async () => ({ results: statement.all(...args) }),
      }) }
    },
  },
  NOTE_WRITES: {
    async limit({ key }) {
      const now = Date.now()
      const recent = (limits.get(key) ?? []).filter(time => now - time < 60_000)
      if (recent.length >= 6) return { success: false }
      recent.push(now)
      limits.set(key, recent)
      return { success: true }
    },
  },
}

const types = { html: 'text/html; charset=utf-8', js: 'application/javascript; charset=utf-8', css: 'text/css; charset=utf-8', png: 'image/png' }
const server = createServer(async (inbound, outgoing) => {
  try {
    const url = new URL(inbound.url, 'http://127.0.0.1:' + port)
    const host = String(inbound.headers.host ?? '').toLowerCase()
    if (!['127.0.0.1:' + port, 'localhost:' + port].includes(host)) {
      outgoing.writeHead(403).end()
      return
    }

    if (['/api/notes', '/api/refresh'].includes(url.pathname)) {
      const requestOptions = { method: inbound.method, headers: inbound.headers }
      if (inbound.method === 'POST') {
        requestOptions.body = Readable.toWeb(inbound)
        requestOptions.duplex = 'half'
      }
      const requestUrl = 'http://' + host + url.pathname + url.search
      const response = await worker.fetch(new Request(requestUrl, requestOptions), env)
      outgoing.writeHead(response.status, Object.fromEntries(response.headers))
      outgoing.end(Buffer.from(await response.arrayBuffer()))
      return
    }

    const filename = url.pathname === '/' ? 'index.html' : url.pathname.slice(1)
    if (!/^[\w-]+\.(html|js|css|png)$/.test(filename) || !['GET', 'HEAD'].includes(inbound.method)) {
      outgoing.writeHead(404).end()
      return
    }
    const content = await readFile(new URL('../dist/' + filename, import.meta.url))
    outgoing.writeHead(200, { 'Content-Type': types[filename.split('.').at(-1)], 'Cache-Control': 'no-store' })
    outgoing.end(inbound.method === 'HEAD' ? undefined : content)
  } catch (error) {
    if (!outgoing.headersSent) outgoing.writeHead(error.code === 'ENOENT' ? 404 : 500)
    outgoing.end()
  }
})

server.listen(port, '127.0.0.1', () => console.log('预览地址 http://127.0.0.1:' + port + '/'))
