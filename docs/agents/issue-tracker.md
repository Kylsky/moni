# Issue tracker: GitHub

Issues and specs live in this repository's GitHub Issues.
Use the `gh` CLI through `rtk`.

Resolve the target repository from `git remote -v`.
For commands outside this checkout, pass `--repo <owner>/<repo>` explicitly.

## Operations

- Create: `rtk gh issue create --title "..." --body-file <file>`
- Read: `rtk gh issue view <number> --json number,title,body,labels,comments`
- List: `rtk gh issue list --state open --json number,title,body,labels`
- Comment: `rtk gh issue comment <number> --body-file <file>`
- Apply labels: `rtk gh issue edit <number> --add-label "..."`
- Remove labels: `rtk gh issue edit <number> --remove-label "..."`
- Close: `rtk gh issue close <number>`

Write multiline bodies to a temporary file and use `--body-file`.

When a skill says "publish to the issue tracker", create an issue.
When it says "fetch the relevant ticket", read the referenced issue.

## Pull requests as a triage surface

**PRs as a request surface: no.**

GitHub issues and PRs share a number space. Resolve an ambiguous number
with `rtk gh pr view <number>`, falling back to `rtk gh issue view <number>`.

## Wayfinding operations

- Map: one issue labelled `wayfinder:map`, containing Notes,
  Decisions-so-far, and Fog.
- Tickets: child issues labelled `wayfinder:<type>`, where type is
  research, prototype, grilling, or task.
- Use native sub-issues and issue dependencies when available.
  Otherwise, list children in the map and put `Part of #<parent>` and
  `Blocked by: #<number>` references in ticket bodies.
- Frontier: the first open, unassigned child in map order whose blockers
  are all closed.
- Claim: assign the ticket to the driving developer before starting.
- Resolve: comment with the answer, close the ticket, and add a linked
  summary to the map's Decisions-so-far.
