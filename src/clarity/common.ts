/** Shared by the source, extraction and OCR modules (kept separate so they do not import each other in a cycle). */
export class SourceError extends Error {}

export const MAX_TEXT_SOURCE_BYTES = 5 * 1024 * 1024;
