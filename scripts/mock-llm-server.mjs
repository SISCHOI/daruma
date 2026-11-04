#!/usr/bin/env node
/**
 * Mock OpenAI-compatible LLM server for testing daruma failover.
 *
 * Models matching FAIL_MODEL (default "mock-a") get HTTP 429; models matching
 * REJECT_MODEL (default "mock-reject") get the provider-side 400 a real
 * conversation can trigger (a request-level refusal, not a channel failure);
 * every other model returns a minimal valid completion. Supports both stream
 * (SSE) and non-stream responses.
 *
 * Usage:
 *   node scripts/mock-llm-server.mjs [PORT]   # default 3099
 * Env:
 *   FAIL_MODEL     model name that should fail with 429 (default "mock-a")
 *   REJECT_MODEL   model name that should fail with 400 (default "mock-reject")
 */

import { createServer } from 'node:http'

const PORT = Number(process.argv[2] ?? 3099)
const FAIL_MODEL = process.env.FAIL_MODEL ?? 'mock-a'
const REJECT_MODEL = process.env.REJECT_MODEL ?? 'mock-reject'

/** The message DeepSeek's Messages API returns when a tool_use turn has no thinking block. */
const REJECT_MESSAGE = 'The `content[].thinking` in the thinking mode must be passed back to the API.'

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
  const verdict = model === FAIL_MODEL ? 429 : model === REJECT_MODEL ? 400 : 200
  console.error(`[mock] request model=${model} stream=${body.stream ?? false} -> ${verdict}`)

  if (model === FAIL_MODEL) {
    return sendJson(res, 429, {
      error: { message: 'mock rate limit', type: 'rate_limit_error', code: 'rate_limit_exceeded' },
    })
  }

  // A request-level refusal: the channel works, this conversation does not.
  if (model === REJECT_MODEL) {
    return sendJson(res, 400, {
      error: { message: REJECT_MESSAGE, type: 'invalid_request_error', code: 'invalid_request_error' },
    })
  }

  const text = `mock completion from ${model}`

  const respond = () => {
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
  return respond()
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
