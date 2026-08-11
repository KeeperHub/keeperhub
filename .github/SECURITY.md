# KeeperHub Security Policy

We take security seriously and appreciate responsible disclosure from the community.

---

## Reporting a Vulnerability

If you discover a security vulnerability in KeeperHub, please report it privately:

* 🔒 [GitHub Private Vulnerability Reporting](https://github.com/KeeperHub/keeperhub/security)

OR
* 📧 Email: security@keeperhub.com  

Please do NOT open public issues for security vulnerabilities.

---

## Scope

This bug bounty / disclosure program applies to:

- KeeperHub backend services
- KeeperHub API
- KeeperHub CLI
- KeeperHub UI
- Workflow execution
- Authentication & authorization systems

Out of scope:
- Third-party dependencies (unless KeeperHub uses them incorrectly)
- Denial-of-service attacks without clear security impact
- Social engineering
- Physical attacks

---

## What we care about

Examples of valid security issues:

- Unauthorized access to user workflows or data
- Privilege escalation (user → admin, workflow → system)
- Authentication bypass
- API key leakage or misuse
- Secret exposure (wallet keys, tokens, credentials)
- Injection vulnerabilities (SQL, command, template, etc.)
- Workflow manipulation or unauthorized execution

---

## General rules

- Do not access or modify real user data
- Do not disrupt production systems
- Avoid automated scanning that causes load
- Use test accounts where possible

## Proof of Concept

To help us validate and triage reports efficiently, we strongly encourage including a proof of concept (PoC), such as:

- Steps to reproduce the issue
- Example API requests / responses
- Screenshots or logs
- Minimal reproducible code (if applicable)

A working PoC significantly speeds up our response time. If a PoC is not possible (e.g. for theoretical or design-level issues), please provide a clear explanation of the attack scenario and impact.

---

## Response times

We aim to respond within:

- 72 hours: initial acknowledgement
- 7 days: triage decision
- 30 days: resolution target (depending on severity)

---

## Rewards

KeeperHub currently operates a **responsible disclosure program**.

Bug bounty rewards may be introduced in the future depending on severity and impact.

---

## Safe Harbor

If you follow this policy in good faith, KeeperHub will not pursue legal action against you.
