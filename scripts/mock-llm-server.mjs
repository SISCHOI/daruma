#!/usr/bin/env node
/**
 * Mock OpenAI-compatible LLM server for testing daruma failover.
 *
 * Models matching FAIL_MODEL (default "mock-a") get HTTP 429; every other
 * model returns a minimal valid completion. Supports both stream (SSE) and
 * non-stream responses.
 *
 * Usage:
 *   node scripts/mock-llm-server.mjs [PORT]   # default 3099
 * Env:
 *   FAIL_MODEL   model name that should fail with 429 (default "mock-a")
 */

import { createServer } from 'node:http'

const PORT = Number(process.argv[2] ?? 3099)
const FAIL_MODEL = process.env.FAIL_MODEL ?? 'mock-a'

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

function completionChunk(model, { role, content, finish }) {
  return {
    id: 'chatcmpl-mock',
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: { role, content }, finish_reason: finish ?? null }],
  }
}

function handleChatCompletions(req, res, body) {
  const model = body.model ?? 'unknown'
  console.error(`[mock] request model=${model} stream=${body.stream ?? false} -> ${model === FAIL_MODEL ? 429 : 200}`)

  if (model === FAIL_MODEL) {
    return sendJson(res, 429, {
      error: { message: 'mock rate limit', type: 'rate_limit_error', code: 'rate_limit_exceeded' },
    })
  }

  const text = `mock completion from ${model}`

  if (body.stream === true) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    })
    res.write(`data: ${JSON.stringify(completionChunk(model, { role: 'assistant', content: text }))}\n\n`)
    res.write(`data: ${JSON.stringify(completionChunk(model, { role: undefined, content: undefined, finish: 'stop' }))}\n\n`)
    res.write('data: [DONE]\n\n')
    return res.end()
  }

  return sendJson(res, 200, {
    id: 'chatcmpl-mock',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
  })
}

const server = createServer((req, res) => {
  if (req.method !== 'POST') {
    return sendJson(res, 405, { error: { message: 'method not allowed' } })
  }
  let raw = ''
  req.on('data', (chunk) => {
    raw += chunk
  })
  req.on('end', () => {
    let body = {}
    try {
      body = raw ? JSON.parse(raw) : {}
    } catch {
      return sendJson(res, 400, { error: { message: 'bad json' } })
    }
    if (req.url?.includes('/chat/completions')) {
      return handleChatCompletions(req, res, body)
    }
    return sendJson(res, 404, { error: { message: `unknown path ${req.url}` } })
  })
})

server.listen(PORT, '127.0.0.1', () => {
  console.error(`mock-llm-server listening on http://127.0.0.1:${PORT} (FAIL_MODEL=${FAIL_MODEL})`)
})
