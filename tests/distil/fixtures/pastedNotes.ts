// Ported from The Last Sprint — distil/Sources/TokenLabCore/DemoDataset.swift (commit 03cc61d)
// Only the synthetic "Pasted notes" demonstration, as a test fixture. ProjectDocument and the review
// template are not ported; the fixture returns the draft, settings and pasted source instead.

import type { ContextBlock, Draft, PastedSource, SelectionSettings } from '../../../src/distil';
import { ContextSplitter, makeBlock, makePastedSource, makeSettings } from '../../../src/distil';

export const demonstrationLabel =
  'DEMONSTRATION — synthetic data written for this project. It shows how the strategies behave; it is not benchmark evidence and says nothing about answer quality until you record and review real answers.';

/** Synthetic notes, pasted as one document and split with `ContextSplitter`. */
export const pastedNotesText = `# Upload service notes

These notes collect what the team knows about the photo upload service.

## Rate limits

The upload endpoint accepts at most 30 requests per minute per device. Requests over the limit get HTTP 429 with a Retry-After header, in seconds.

## Error codes

- 429: too many requests; wait for Retry-After before retrying.
- 503: service temporarily unavailable; safe to retry with exponential backoff.
- 400 and 413: the request itself is wrong; never retry these.

## Current client

\`\`\`swift
func upload(_ data: Data) async throws -> Receipt {
    let request = makeRequest(data)

    let (body, response) = try await session.data(for: request)
    return try decodeReceipt(body, response)
}
\`\`\`

## Meeting notes (week 12)

Agreed to look at retries after the release. The lunch rota and the office move were also discussed.

## Meeting notes (week 12)

Agreed to look at retries after the release. The lunch rota and the office move were also discussed.

## Changelog

1.4.2: fixed thumbnail colours on dark backgrounds.
1.4.1: updated Norwegian and Polish translations.
1.4.0: new onboarding screens.`;

export interface PastedNotesDemo {
  title: string;
  summary: string;
  draft: Draft;
  settings: SelectionSettings;
  expectedFacts: string[];
  correctnessChecks: string[];
  pastedSource: PastedSource;
}

export function makePastedNotesDemo(): PastedNotesDemo {
  // Swift: Date(timeIntervalSinceReferenceDate: 815_000_000); the reference date is 2001-01-01T00:00:00Z.
  const source = makePastedSource('Upload service notes', pastedNotesText, new Date(Date.UTC(2001, 0, 1) + 815_000_000 * 1000));
  const blocks: ContextBlock[] = ContextSplitter.split(pastedNotesText).map((p) =>
    makeBlock({ title: p.title, text: p.text, category: p.category, pastedSourceID: source.id, lineStart: p.lineStart, lineEnd: p.lineEnd }),
  );
  return {
    title: 'Pasted notes: a useful reduction, and a loss',
    summary:
      'Team notes pasted and split into blocks. At the demo budget the duplicate meeting notes and the changelog are left out while every expected fact stays. Lower the budget to 150 and the error-code section is dropped, losing the rule that 400 and 413 must never be retried.',
    draft: {
      task: 'Add retry handling to the upload client so that temporary failures are retried safely.',
      instructions: 'Reply with the Swift changes only. Keep the upload(_:) signature unchanged.',
      blocks,
    },
    settings: makeSettings({ strategy: 'taskRelevance', budget: 230, deduplicateBeforeBudget: true }),
    expectedFacts: [
      'Waits for Retry-After before retrying a 429',
      'Retries 503 with exponential backoff',
      'Never retries 400 or 413',
      'Keeps the upload(_:) signature',
    ],
    correctnessChecks: ['Changes compile against the shown client', 'No invented endpoints or headers'],
    pastedSource: source,
  };
}
