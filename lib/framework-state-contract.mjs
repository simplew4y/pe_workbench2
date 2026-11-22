// Shared by the validator and the template tool; never infer business values.
export const STATE_ENUMS=Object.freeze({
  threshold_basis:['history','model_breakpoint','operating_constraint','pending'],
  multiple_basis:['ARR','EPS','EBITDA','SALES','BOOK','OTHER'],
  check_reason:['tool_failure','source_missing','not_disclosed','not_attempted'],
});
