// Copyright (c) 2026 Joel Stevick
// SPDX-License-Identifier: MIT
// Licensed under the MIT License: https://opensource.org/licenses/MIT

// The eval harness's reading of a streamed answer call (evals/trace.ts): its tokens are what the
// ledger counts, so a stream read as zero would let the spend cap never bite.
import { describe, expect, it } from 'vitest'
import { usageOfStream } from '../../evals/trace'

// A streamed Messages API reply as Anthropic sends it, thinking first, then the text.
const RECORDED = [
  'event: message_start',
  'data: {"type":"message_start","message":{"id":"msg_01","type":"message","role":"assistant","model":"claude-sonnet-5-5","content":[],"stop_reason":null,"usage":{"input_tokens":4210,"output_tokens":3}}}',
  '',
  'event: content_block_start',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"The passage says 30 days."}}',
  '',
  'event: ping',
  'data: {"type": "ping"}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Refunds are paid within 30 days "}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"[ab12-x-0]."}}',
  '',
  'event: message_delta',
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":187}}',
  '',
  'event: message_stop',
  'data: {"type":"message_stop"}',
  '',
  '',
].join('\n')

describe('the eval trace of a streamed call', () => {
  it('guard 8: reads the input and output tokens, the stop reason and the text', () => {
    expect(usageOfStream(RECORDED)).toEqual({ input_tokens: 4210, output_tokens: 187, stop_reason: 'end_turn', reply: 'Refunds are paid within 30 days [ab12-x-0].' })
  })

  it('names an error event', () => {
    const failed = usageOfStream('event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n')
    expect(failed.error).toBe('Overloaded')
  })
})
