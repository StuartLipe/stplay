import fs from 'node:fs'
import path from 'node:path'

const transcriptPath =
  process.argv[2] ||
  'C:/Users/Administrator/.cursor/projects/c-Users-Administrator-Documents-stplay/agent-transcripts/31c665ab-f068-46b5-bb5e-9d6c5205b976/31c665ab-f068-46b5-bb5e-9d6c5205b976.jsonl'

const projectRoot = 'C:/Users/Administrator/Documents/stplay'

const ops = []

for (const line of fs.readFileSync(transcriptPath, 'utf8').split(/\r?\n/)) {
  if (!line.trim()) continue
  let row
  try {
    row = JSON.parse(line)
  } catch {
    continue
  }
  const content = row?.message?.content
  if (!Array.isArray(content)) continue
  for (const item of content) {
    if (item?.type !== 'tool_use') continue
    const name = item.name
    const input = item.input || {}
    if (!input.path || !String(input.path).includes('stplay')) continue
    if (name === 'StrReplace') {
      ops.push({
        type: 'replace',
        path: input.path,
        old_string: input.old_string ?? '',
        new_string: input.new_string ?? '',
        replace_all: Boolean(input.replace_all),
      })
    } else if (name === 'Write') {
      ops.push({
        type: 'write',
        path: input.path,
        contents: input.contents ?? '',
      })
    } else if (name === 'Delete') {
      ops.push({
        type: 'delete',
        path: input.path,
      })
    }
  }
}

const writes = new Map()
const deleted = new Set()

for (const op of ops) {
  if (op.type === 'write') writes.set(op.path, op.contents)
  if (op.type === 'delete') deleted.add(op.path)
}

const results = { ok: 0, skip: 0, fail: 0, deleted: 0, restored: 0 }
const errors = []

for (let i = ops.length - 1; i >= 0; i--) {
  const op = ops[i]
  const rel = path.relative(projectRoot, op.path).replace(/\\/g, '/')
  if (rel.startsWith('..')) continue

  if (op.type === 'replace') {
    const filePath = op.path
    if (!fs.existsSync(filePath)) {
      results.skip++
      continue
    }
    let text = fs.readFileSync(filePath, 'utf8')
    const from = op.new_string
    const to = op.old_string
    if (!from) {
      results.skip++
      continue
    }
    if (op.replace_all) {
      if (!text.includes(from)) {
        results.skip++
        continue
      }
      text = text.split(from).join(to)
    } else {
      const idx = text.indexOf(from)
      if (idx === -1) {
        results.skip++
        continue
      }
      text = text.slice(0, idx) + to + text.slice(idx + from.length)
    }
    fs.writeFileSync(filePath, text, 'utf8')
    results.ok++
  } else if (op.type === 'write') {
    const filePath = op.path
    if (deleted.has(filePath)) {
      if (!fs.existsSync(filePath)) {
        fs.mkdirSync(path.dirname(filePath), { recursive: true })
        fs.writeFileSync(filePath, '', 'utf8')
        results.restored++
      }
      deleted.delete(filePath)
      continue
    }
    if (!fs.existsSync(filePath)) {
      results.skip++
      continue
    }
    fs.unlinkSync(filePath)
    results.deleted++
  } else if (op.type === 'delete') {
    const filePath = op.path
    const original = writes.get(filePath)
    if (original != null) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      fs.writeFileSync(filePath, original, 'utf8')
      results.restored++
    } else {
      results.skip++
    }
  }
}

console.log(JSON.stringify({ totalOps: ops.length, ...results, errors }, null, 2))
