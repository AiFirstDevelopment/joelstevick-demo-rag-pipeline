// Copyright (c) 2026 Joel Stevick
// SPDX-License-Identifier: MIT
// Licensed under the MIT License: https://opensource.org/licenses/MIT

// A streamed Anthropic reply read for the eval trace: its usage, stop reason and text, from the
// server-sent events (docs/plans/demo-stream.md). The answer model streams, so its tokens are in
// `message_start` (input) and `message_delta` (output, a running total), never in a JSON body.

/** What the trace keeps of one streamed call. */
export interface StreamUsage {
  input_tokens: number
  output_tokens: number
  stop_reason: string | null
  reply: string
  error?: string
}

/**
 * Reads a whole server-sent event body, once it has all arrived; events it does not know are
 * skipped. The body is "event:" and "data:" lines with a blank line after each event (the same
 * framing demo/src/models.ts `serverEvents` reads live); each event's data is one JSON object.
 * What is kept: the input tokens from message_start, the output tokens and stop reason from
 * message_delta, the text from every text_delta, and an error event's message.
 */
export function usageOfStream(body: string): StreamUsage {
  const usage: StreamUsage = { input_tokens: 0, output_tokens: 0, stop_reason: null, reply: '' }
  // Blocks are events; each block's "data:" lines, joined, are its payload.
  for (const block of body.replace(/\r\n/g, '\n').split('\n\n')) {
    const data = block.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n')
    if (data === '') continue
    let event: {
      type?: string
      message?: { usage?: { input_tokens?: number; output_tokens?: number } }
      usage?: { output_tokens?: number }
      delta?: { type?: string; text?: string; stop_reason?: string }
      error?: { message?: string }
    }
    try {
      event = JSON.parse(data)
    } catch {
      continue
    }
    if (event.type === 'message_start') {
      usage.input_tokens = event.message?.usage?.input_tokens ?? 0
      usage.output_tokens = event.message?.usage?.output_tokens ?? 0
    } else if (event.type === 'message_delta') {
      // The output count in each message_delta is the total so far, not an increment.
      usage.output_tokens = event.usage?.output_tokens ?? usage.output_tokens
      usage.stop_reason = event.delta?.stop_reason ?? usage.stop_reason
    } else if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
      usage.reply += event.delta.text ?? ''
    } else if (event.type === 'error') {
      usage.error = event.error?.message ?? 'stream error'
    }
  }
  return usage
}
