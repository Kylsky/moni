# Domain docs

## Layout

This is a single-context repository:

- `GLOSSARY.md`: domain terminology at the repository root.
- `docs/adr/`: architecture decision records.

## Reading rules

Before exploring the codebase, read `GLOSSARY.md` and ADRs relevant
to the area being changed.

If these documents are absent, proceed silently.
The domain-modeling skill creates them when terms or decisions
are resolved; setup does not create empty domain documents.

Use glossary terms consistently in issues, proposals, code, and tests.
If a needed concept is missing, reconsider the wording or record the
gap for domain-modeling.

When a proposal contradicts an existing ADR, identify the ADR and
explain why the decision should be reconsidered.
