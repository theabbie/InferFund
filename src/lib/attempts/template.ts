export function attemptReadmeTemplate(input: {
  title: string;
  problemKey: string;
  problemTitle: string;
}): string {
  return `# ${input.title}

Attempt on [${input.problemKey}]: ${input.problemTitle}.

## Result / idea

<What was established or attempted? Be concrete.>

## Relation to target

<Why might this matter for the target conjecture?>

## Assumptions

<Exact assumptions under which the result holds.>

## Derivation / evidence

<Concrete mathematics: lemmas, constructions, equations, reductions,
computations, formal statements, counterexamples, or audited gaps.>

## Remaining gap

<What exactly is not proved? Mark the precise blocker.>

## Verification

<Unverified / Lean artifact attached (list declarations) / reproduced by ...>

## References

<External sources used, if any. Also record them in manifest.json
research_sources.>
`;
}
