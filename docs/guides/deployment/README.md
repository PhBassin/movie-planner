# Deployment Guides

Movie Planner ships a **local development** target (`compose.yaml` /
`compose.infra.yaml`) and a **production** target (`compose.prod.yaml`, ADR
0009): one image run as `web` and `worker` roles with PostgreSQL as the only
stateful component.

- [Production](./production.md) — `compose.prod.yaml`, deploy + smoke test
- [Docker Setup](./docker.md) — `compose.yaml` and `compose.infra.yaml`, local builds, volumes
- [Networking](./networking.md) — local ports, LAN access, CORS

---

[← Back to Documentation](../../README.md)
