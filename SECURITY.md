# Security

- Report vulnerabilities to support@theshenhai.com (subject "EcoTime security"). Do not open public issues.
- Secrets live only in `backend/.env` (mode 600) on the server; never in Git, PM2 files or logs.
- API keys (`etk_…`) and webhook secrets (`whsec_…`) are shown once. Keys are stored as HMACs; webhook secrets are sealed
  with AES-GCM under `DATA_KEY`. Revocation takes effect immediately.
- Webhooks go only to HTTPS URLs on approved domains, never to IP addresses or URLs with credentials (SSRF).
- `NODE_TLS_REJECT_UNAUTHORIZED=0` stops EcoTime from starting. A machine-wide `DATABASE_URL` is ignored.
- The clock collector runs as `nobody` with no capabilities and a system-call filter that forbids clock changes.
- The audit log is append-only (a database trigger refuses UPDATE and DELETE).
