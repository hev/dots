# Security

## Reporting a vulnerability

Report it privately through GitHub: **Security → Report a vulnerability** on
[hev/dots](https://github.com/hev/dots/security/advisories/new). Please don't
open a public issue for it.

Say what you found, how to reproduce it, and what it lets someone do. We aim to
answer within a week. dots is early and has no releases yet, so fixes land on
`main`.

## What counts

dots enforces policy on the server, so these are in scope:

- An act running without a matching read-back and yes (`src/server/receipts.ts`).
- Private mode, acts or display results reachable without an allowed login.
- Secrets, contact details or codenamed names getting past redaction to the
  model, traces or threads (`src/server/redact.ts`).
- One user reading or writing another's threads.
- The phone adapter dialing outside its allowlist, accepting an unsigned
  callback, or reusing a stream token (`src/phone`).

Your own dot's tools, identity adapter and hosting are yours; a bug there is in
scope only when dots makes it easy to get wrong.
