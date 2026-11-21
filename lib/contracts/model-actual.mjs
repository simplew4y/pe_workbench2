import { Type } from "typebox";

const fields = {
  sheet: Type.String(), cell: Type.String(), header: Type.String(), metric: Type.String(),
  period: Type.String(), unit: Type.String(), source: Type.String(), expected: Type.Number(),
  decimals: Type.Integer({ minimum: 0, maximum: 12 }),
  mode: Type.Union([Type.Literal("check"), Type.Literal("actual"), Type.Literal("formula")]),
  formula: Type.Optional(Type.String()),
};
export const Disclosure = Type.Object(fields, { additionalProperties: false });
export const Reconciliation = Type.Object({
  ...fields, ref: Type.String(), matched: Type.Boolean(),
  actual: Type.Union([Type.Number(), Type.String(), Type.Boolean(), Type.Null()]),
}, { additionalProperties: false });
