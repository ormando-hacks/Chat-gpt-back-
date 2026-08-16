# AI Premium Backend 3.12.0

## Session and authentication repairs

- Web sessions now use a configurable rolling lifetime through `SESSION_TTL_MS`, defaulting to 30 days. Authenticated activity renews the session expiry.
- Persisted WhatsApp sessions are restored before the server begins accepting API requests.
- Concurrent WhatsApp connection requests for the same account share one creation operation, and existing account-owned sessions are reused to prevent duplicates.
- The existing per-connection WhatsApp state model remains authoritative.

## Runtime reliability repairs

- Jobs left in `queued` or `running` state after a backend restart are marked failed with a retryable message instead of remaining stuck indefinitely.
- Generated image results are stored under the data directory with metadata sidecars, allowing authenticated result URLs to continue working after a restart until their configured expiry.

## WhatsApp media

- The previously requested owner-only `.gpt save` command remains enabled. When used as a reply to a view-once attachment, it saves supported media under the connected account's `whatsapp-media/<connectionId>` folder.
- The legacy 3.11 changelog statement saying view-once saving was not added is obsolete for this repaired 3.12 package.

## Configuration

- `SESSION_TTL_MS` was added to `.env.example`.
- Upstash Redis remains required for WhatsApp credentials to survive a process restart or redeploy. Without it, the backend continues to use the documented process-memory fallback.
