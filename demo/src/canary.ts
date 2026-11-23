// Copyright (c) 2026 Joel Stevick
// SPDX-License-Identifier: MIT
// Licensed under the MIT License: https://opensource.org/licenses/MIT

/**
 * The canary (README.md, "Watching the pipeline"): a fixed, invented document and fixed questions about it,
 * asked through the real pipeline every day by the demo Worker's daily job (health.ts). The document and
 * its answers never change, so a canary that starts failing means the pipeline changed: the model, the
 * embeddings, retrieval, the reranker or the check. It is longer than the passages one answer is written from
 * (ANSWER_CHUNKS in models.ts, 12), so each question goes through retrieval and reranking and is not answered
 * from the whole document at once; each page is one passage. Nothing in it is anyone's real data.
 */

// The name the canary's document is stored under, as if it were an uploaded PDF.
export const CANARY_FILE = 'canary-policy.pdf'

/** Sixteen pages of an invented equipment-rental company's policy: three that hold the answers, thirteen that do not. */
export const CANARY_PAGES = [
  'Brightwater Rentals: Customer Policy. Rentals are charged by the day. A day starts when the equipment leaves the depot and ends at closing time, 5:30 p.m. Equipment returned after 5:30 p.m. is charged for one more day. Every rental needs a deposit of 200 dollars, taken on the customer\'s card when the equipment is collected.',
  'Damage and cleaning. The deposit is returned within 5 working days of the return, less the cost of any damage. Equipment returned dirty is charged a cleaning fee of 45 dollars. Customers must report a breakdown within 2 hours by calling the depot; a breakdown reported later is treated as damage.',
  'Delivery and cancellation. Delivery is free within 10 miles of the depot and costs 3 dollars a mile beyond that. A booking cancelled at least 48 hours before collection is refunded in full; a later cancellation forfeits one day\'s charge. The depot is closed on Sundays.',
  'Opening hours. The depot opens at 7 a.m. from Monday to Saturday. Staff load equipment into customer vehicles on request, and a forklift is available for pallets.',
  'Identification. A first-time customer shows a photo driving licence and a utility bill with the same address. Trade accounts are opened by the office manager after a credit check.',
  'Safety briefings. Every powered tool is handed over with a short safety briefing. Customers sign the briefing sheet, and goggles and gloves are lent free with saws and grinders.',
  'Fuel. Petrol and diesel machines leave the depot with a full tank. A machine returned with less fuel is refilled at the pump price plus a handling charge shown on the receipt.',
  'Trade accounts. Account holders are invoiced monthly and pay within 30 days. An account more than 60 days overdue is put on hold until it is settled.',
  'Long hires. Hires of four weeks or more get a weekly rate, agreed in writing before collection. Equipment on a long hire is serviced at the depot every two weeks.',
  'Loyalty. Customers who hire ten times in a year receive a voucher for one free day on any hand tool. Vouchers expire at the end of the following year.',
  'Accessories. Blades, drill bits and sanding discs are sold, not hired. Unused accessories in their packaging may be returned for a refund within 14 days.',
  'Lost equipment. Equipment not returned within 7 days of the agreed date is reported to the police, and the customer is charged its replacement cost.',
  'Weekends. Equipment collected on Saturday afternoon and returned on Monday morning is charged as one day, because the depot does not open in between.',
  'Complaints. A complaint is acknowledged within one working day and answered in full within ten. Customers who are not satisfied may ask for the area manager to review it.',
  'Environment. Waste oil and old batteries are collected free from customers who return them to the depot. Machines are cleaned with biodegradable detergent.',
  'Training. The depot runs a free half-day course on using a mini digger every first Saturday of the month. Places are booked at the counter.',
]

/** One canary question: an answerable one names the words a right answer must contain; an unanswerable one must fall back. */
export interface CanaryCase {
  name: string
  question: string
  /** Every one of these must appear in the answer (case-insensitive). Empty for a question that must fall back. */
  must: string[]
  /** True when the answer is not in the document, so the pipeline must say it could not find it. */
  fallback?: boolean
}

// Five questions the document answers, and one it does not.
export const CANARY_CASES: CanaryCase[] = [
  { name: 'deposit', question: 'How much is the deposit for a rental?', must: ['200'] },
  { name: 'late-return', question: 'When does a rental day end?', must: ['5:30'] },
  { name: 'cleaning-fee', question: 'What is the cleaning fee for equipment returned dirty?', must: ['45'] },
  { name: 'breakdown', question: 'How soon must a breakdown be reported?', must: ['2 hours'] },
  { name: 'cancellation', question: 'How long before collection must a booking be cancelled for a full refund?', must: ['48'] },
  { name: 'absent', question: 'Does Brightwater Rentals offer insurance for the equipment?', must: [], fallback: true },
]
