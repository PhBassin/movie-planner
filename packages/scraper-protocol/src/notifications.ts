// ---------------------------------------------------------------------------
// Notification transport — the raw LISTEN/NOTIFY contract between the `web`
// and `worker` roles (ADR 0009, issue #25).
//
// The queue arm of the bus is transactional (scrape_jobs, FOR UPDATE SKIP
// LOCKED); the pub/sub arm is intentionally ephemeral. All three channels
// carry no durable delivery guarantee: a notification is dropped when no
// process is listening, and connected listeners never see historical events.
// The PostgreSQL 8 KB notification payload cap is enforced by the concrete
// `PostgresNotificationBus` implementations in each workspace; channels stay
// small by construction (counts, ids, denormalized snapshots).
//
// `member:notices` is a reserved peer channel (ADR 0005, CONTEXT.md) with no
// producers or callers in code yet — it joins the bus when it gains an
// implementation. `NOTIFICATION_CHANNELS` is the single source of channel
// names so the web and worker roles can never drift apart.
// ---------------------------------------------------------------------------

/** Canonical channel names for the ephemeral LISTEN/NOTIFY fan-outs. */
export const NOTIFICATION_CHANNELS = {
  progress: 'scrape:progress',
  scheduleChanged: 'scraper:schedule:changed',
  memberNotices: 'member:notices',
} as const;

export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[keyof typeof NOTIFICATION_CHANNELS];

/**
 * Raw pub/sub transport over PostgreSQL LISTEN/NOTIFY.
 *
 * The contract speaks string payloads so it stays transport-shaped; typed
 * event (de)serialization lives at the bus-port layer (`BusProducer` /
 * `BusConsumer` in `bus.ts`). Role code depends on this interface, the
 * concrete `PostgresNotificationBus` is the swappable backend.
 */
export interface NotificationBus {
  /** Publish a payload to a channel. Never durable — see module header. */
  publish(channel: NotificationChannel, payload: string): Promise<void>;

  /** Register a listener; delivery of future payloads is ephemeral. */
  subscribe(channel: NotificationChannel, handler: (payload: string) => void): Promise<void>;

  /** Tear down all connections held by this backend (graceful shutdown). */
  disconnect(): Promise<void>;
}
