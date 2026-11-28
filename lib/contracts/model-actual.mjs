import { Type } from "typebox";

const fields = {
  sheet: Type.String(), cell: Type.String(), header: Type.String(), metric: Type.String(),
  period: Type.String(), unit: Type.String(), source: Type.String(), expected: Type.Number(),
  decimals: Type.Integer({ minimum: 0, maximum: 12 }),
  mode: Type.Union([Type.Literal("check"), Type.Literal("actual"), Type.Literal("formula")]),
  storageScale: Type.Optional(Type.Literal(0.01)),
  issuer: Type.Optional(Type.Object({code:Type.String(), market:Type.String(), name:Type.String()})),
  sourcePeriod: Type.Optional(Type.String()), scope: Type.Optional(Type.String()), evidence: Type.Optional(Type.String()), disclosed: Type.Optional(Type.Number()),
  caption: Type.Optional(Type.String()), forecastRef: Type.Optional(Type.String()), priorReported: Type.Optional(Type.Number()),
  formula: Type.Optional(Type.String()),
};
export const Disclosure = Type.Object(fields, { additionalProperties: false });
export const Reconciliation = Type.Object({
  ...fields, ref: Type.String(), matched: Type.Boolean(),
  actual: Type.Union([Type.Number(), Type.String(), Type.Boolean(), Type.Null()]),
}, { additionalProperties: false });
