/**
 * Cell citation contract.
 *
 * A citation is the only thing the UI is allowed to turn into a clickable
 * `Sheet!A1` reference. Producers must emit the real material/locator pair;
 * consumers must never invent one from a bare regex in the answer.
 */

import { Type } from "typebox";
import { makeContract } from "./core.mjs";

const LOCATOR_PATTERN = String.raw`^(?:'(?:[^']|'')+'|[^'!\n]+)!\$?[A-Za-z]{1,3}\$?\d+(?::\$?[A-Za-z]{1,3}\$?\d+)?$`;

export const CITATION_SCHEMA = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 240 }),
    materialId: Type.String({ minLength: 1, maxLength: 240 }),
    version: Type.Optional(Type.Integer({ minimum: 1 })),
    locator: Type.String({ minLength: 1, maxLength: 240, pattern: LOCATOR_PATTERN }),
    value: Type.Optional(Type.Union([Type.Number(), Type.String(), Type.Null()])),
    display_unit: Type.Optional(Type.String({ maxLength: 80 })),
    role: Type.Optional(Type.String({ maxLength: 80 })),
    toolCallId: Type.Optional(Type.String({ maxLength: 240 })),
    derivedFrom: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 240 }), { maxItems: 40 })),
  },
  { additionalProperties: false },
);

/** Input form accepted by calc tools: the producer may already know the id. */
export const CITATION_INPUT_SCHEMA = Type.Object(
  {
    id: Type.Optional(Type.String({ minLength: 1, maxLength: 240 })),
    materialId: Type.String({ minLength: 1, maxLength: 240 }),
    version: Type.Optional(Type.Integer({ minimum: 1 })),
    locator: Type.String({ minLength: 1, maxLength: 240, pattern: LOCATOR_PATTERN }),
    value: Type.Optional(Type.Union([Type.Number(), Type.String(), Type.Null()])),
    display_unit: Type.Optional(Type.String({ maxLength: 80 })),
    role: Type.Optional(Type.String({ maxLength: 80 })),
    toolCallId: Type.Optional(Type.String({ maxLength: 240 })),
    derivedFrom: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 240 }), { maxItems: 40 })),
  },
  { additionalProperties: false },
);

export const CITATION = makeContract("pe.citation", 1, CITATION_SCHEMA);

export function validateCitation(value) {
  return CITATION.validate(value);
}

/** Validate a list; one malformed citation must not poison the whole turn. */
export function validateCitations(values) {
  if (!Array.isArray(values)) {
    return {
      ok: false,
      error: "citations must be an array",
      errors: [{ path: "", message: "citations must be an array" }],
    };
  }
  const accepted = [];
  const errors = [];
  for (const [index, value] of values.entries()) {
    const result = CITATION.validate(value);
    if (!result.ok) {
      for (const error of result.errors) {
        errors.push({ path: `[${index}]${error.path}`, message: error.message });
      }
      continue;
    }
    accepted.push(result.value);
  }
  if (errors.length) {
    return {
      ok: false,
      error: "one or more citations failed schema validation",
      errors: errors.slice(0, 20),
      value: accepted,
    };
  }
  return { ok: true, value: accepted, errors: [] };
}

/** Drop malformed entries while keeping every valid citation. */
export function validCitations(values) {
  if (!Array.isArray(values)) return [];
  const accepted = [];
  for (const value of values) {
    const result = CITATION.validate(value);
    if (result.ok) accepted.push(result.value);
  }
  return accepted;
}

export { LOCATOR_PATTERN };
