---
name: teach
description: Teach the user what was built in the latest commit(s). Proposes structured lessons covering architecture, patterns, code, and concepts.
user_invocable: true
---

# Teach Me What You Built

When the user invokes `/teach`, follow this process:

## Step 1: Identify What Changed

Run `git log --oneline -1` and `git diff HEAD~1 --stat` to identify the latest commit and files changed. If the user specifies a commit range (e.g., `/teach HEAD~3`), use that range instead.

For each changed file, briefly note its purpose (e.g., "monitoring.py — added liquidation execution").

## Step 2: Propose Lessons

Based on the changes, propose numbered lessons. Each lesson should be 1 line describing a concept, pattern, or architecture decision. Group by category:

- **Architecture decisions** — why things are structured this way
- **Patterns** — recurring code patterns the user should recognize
- **Important code** — specific functions or queries worth understanding in detail
- **Concepts** — domain or technical concepts needed to understand the code

Format as a numbered list. Example:

```
## Lesson 1: [Topic]
[One-sentence description of what this lesson covers]

## Lesson 2: [Topic]
...
```

End with: "Say a lesson number to dive in."

## Step 3: Deep Dive

When the user picks a lesson number, teach it thoroughly:

- Start with **why** this exists (the problem it solves)
- Show the **key code** with line references
- Explain the **pattern** so they can recognize it elsewhere
- If relevant, compare with **alternatives** and explain why this approach was chosen
- End with **check your understanding** questions (optional, only if the lesson is complex)

Keep each lesson focused. One concept per lesson. Use code snippets from the actual codebase, not generic examples.

## Rules

- Do NOT dump all lessons at once. Propose topics first, then go deep on demand.
- Tailor depth to the user's role (check memory for user profile).
- Reference exact file paths and line numbers.
- If the commit is trivial (config change, typo fix), say so — don't force lessons on non-educational changes.
