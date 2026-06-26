---
name: feature-dev
description: >-
  Drive a feature from research to reviewed implementation in deliberate, user-confirmed steps. Use when asked to build or change a feature.
---

# Feature development

Help the user develop a feature, working in deliberate, user-confirmed steps.

## Steps

1. Research and present findings and options to the user in chat, to agree on scope and UX/UI.
2. Create a plan, validate it with a fleet of background agents on different models, and present findings to the user in chat.
3. Implement the plan step by step.
4. Do a critical review with a fleet of background agents on different models.

## Ending a step

End a step only once the user agrees with its proposed version. On that
agreement, immediately and unprompted:

1. Post a concise summary of the agreed result itself — the scope and the plan,
   not a recap of the work done.
2. Ask whether to repeat the step, move to the next, or do something else.

## Keeping a live plan

Whenever a step has more than one part — research, planning, implementation, and
review alike — maintain a live plan the user can watch:

- Break the work into a short, ordered todo list.
- Keep each item's status current (`in_progress`, then `done`) as you go, so
  progress shows up in the Plan view.
- Do this wherever possible, not only while coding.
