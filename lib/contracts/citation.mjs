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

const CELL_CITATION_SCHEMA = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 240 }),
    materialId: Type.String({ minLength: 1, maxLength: 240 }),
    version: Type.Optional(Type.Integer({ minimum: 1 })),
    locator: Type.String({ minLength: 1, maxLength: 240, pattern: LOCATOR_PATTERN }),
    filename: Type.Optional(Type.String({ maxLength: 255 })),
    storedFilename: Type.Optional(Type.String({ minLength: 1, maxLength: 255 })),
    ambiguousQualifiers: Type.Optional(Type.Array(Type.String({ maxLength: 280 }))),
    value: Type.Optional(Type.Union([Type.Number(), Type.String(), Type.Null()])),
    display_unit: Type.Optional(Type.String({ maxLength: 80 })),
    ...Object.fromEntries(['company','metric','period','scope','basis_type','scenario','currency','raw_unit','sha256','excerpt','formula'].map(k=>[k,Type.Optional(Type.String({maxLength:10000}))])),
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
    filename: Type.Optional(Type.String({ maxLength: 255 })),
    storedFilename: Type.Optional(Type.String({ minLength: 1, maxLength: 255 })),
    value: Type.Optional(Type.Union([Type.Number(), Type.String(), Type.Null()])),
    display_unit: Type.Optional(Type.String({ maxLength: 80 })),
    ...Object.fromEntries(['company','metric','period','scope','basis_type','scenario','currency','raw_unit','sha256','excerpt','formula'].map(k=>[k,Type.Optional(Type.String({maxLength:10000}))])),
    role: Type.Optional(Type.String({ maxLength: 80 })),
    toolCallId: Type.Optional(Type.String({ maxLength: 240 })),
    derivedFrom: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 240 }), { maxItems: 40 })),
  },
  { additionalProperties: false },
);

// A PDF observation addresses a printed row and column within a specific page.
export const PDF_LOCATOR = /^p\.([1-9]\d{0,5})\/r([1-9]\d{0,5})c([1-9]\d{0,4})$/;
const PDF_POINT_INPUT = Type.Object({
  ...CITATION_INPUT_SCHEMA.properties,
  version: Type.Integer({minimum:1}),
  locator: Type.String({pattern:PDF_LOCATOR.source}),
}, {additionalProperties:false});

export const PDF_PAGE = /^p\.([1-9]\d{0,5})$/;
export const PDF_INPUT_SCHEMA = Type.Union([PDF_POINT_INPUT, Type.Object({
  ...PDF_POINT_INPUT.properties, locator:Type.String({pattern:PDF_PAGE.source}),
  period:Type.String({minLength:1}), metric:Type.String({minLength:1}), excerpt:Type.String({minLength:1}),
}, {additionalProperties:false})]);

const PDF_CITATION_SCHEMA = Type.Object({
  ...CELL_CITATION_SCHEMA.properties,
  version: PDF_POINT_INPUT.properties.version,
  locator: PDF_POINT_INPUT.properties.locator,
  sha256: Type.String({pattern:'^[a-f0-9]{64}$'}),
  excerpt: Type.String({minLength:1,maxLength:10000}),
}, {additionalProperties:false});
export const CITATION_SCHEMA = Type.Union([CELL_CITATION_SCHEMA, PDF_CITATION_SCHEMA]);

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
