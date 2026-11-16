# Native remote cancellation cleanup

Operator request: fix Gemini cancellation leaving its shell command alive; inspect shared transport for Codex/Claude. No active coding-time cap.

Changed gateway/lib/codex-process.mjs and gateway/codex-process.test.mjs. Linux cancellation snapshots descendant identities before signalling the CLI, including detached groups, and escalates TERM to KILL independently of leader/session lifetime. PID start-time checks avoid signalling reused tracked identities. Disconnect cleanup uses the same mechanism. Removed the existing 30-minute native session cap. Ordinary successful completion does not cancel intentional background work.

Parent verification: `node --test gateway/codex-process.test.mjs gateway/codex-authenticated-e2e.test.mjs`: 14 passed, zero failures/skips. Real processes exercise each harness plus Gemini disconnect, TERM-resistant detached shell/grandchild, leader exit/read consumption and absent delayed side effect.

Fresh GPT-6-Luna independently reviewed source and ran the process file: 11 passed (the other three tests are authenticated transport tests in the second file). Functional and scope pass. Linux /proc ancestry is a snapshot, not a cgroup: previously orphaned/daemonized descendants cannot reliably be attributed. Other platforms retain existing fallback. RPC cancellation acknowledgement is not proof of completed escalation; callers must independently verify terminal cleanup. Live installed-Gemini acceptance remains pending operator update. No live installation/restart.
