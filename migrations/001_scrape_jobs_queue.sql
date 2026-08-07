-- 001 — Postgres-backed scrape job queue (ADR 0009).
--
-- Replaces the Redis `scrape:jobs` list with a `scrape_jobs` table consumed by
-- the worker role with `FOR UPDATE SKIP LOCKED` (see BusConsumer). Claiming is
-- delete-and-return: a worker atomically removes the oldest row, so concurrent
-- workers never receive the same job and a crash before claim leaves the row in
-- place for the next consumer (terminal-failure / no-retry behavior matches the
-- Redis list it replaces — issue #24).
--
-- FIFO ordering is by `id` (BIGSERIAL, monotonic with `enqueued_at`); the
-- primary key serves `ORDER BY id ... LIMIT 1`.
--
-- Idempotent so it is safe on both a fresh baseline (docker/init.sql already
-- created the table) and an existing database evolving from the old baseline.

BEGIN;

CREATE TABLE IF NOT EXISTS scrape_jobs (
  id BIGSERIAL PRIMARY KEY,
  payload JSONB NOT NULL,
  enqueued_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMIT;
