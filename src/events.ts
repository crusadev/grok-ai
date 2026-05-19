/**
 * Cross-process event bus on Redis pub/sub.
 *
 * Both api and worker processes call `publishEvent()` (cheap — reuses one
 * publisher connection per process). The api process calls `subscribeEvents()`
 * once at boot to fan-out incoming events to connected SSE clients.
 *
 * Redis SUB connections cannot issue normal commands, so subscribe gets its
 * own ioredis connection, separate from the queue's publisher/queue connection.
 */
import IORedis from 'ioredis';
import { createRedisConnection } from './queue';
import { logger } from './logger';
import type { JobSummary } from './types';

export const EVENTS_CHANNEL = 'grok:events';

/** A single job-state change. Carries the same shape History/Active consume. */
export interface JobEvent {
  type: 'job';
  summary: JobSummary;
}

/** Live operational stats, debounced — only republished when values change. */
export interface StatsEvent {
  type: 'stats';
  workers: number;
  tabsPerRequest: number;
  queue: { waiting: number; active: number };
}

export type AppEvent = JobEvent | StatsEvent;

let publisher: IORedis | undefined;

function getPublisher(): IORedis {
  if (!publisher) publisher = createRedisConnection();
  return publisher;
}

/** Fire-and-forget publish. Never throws — a failed publish is a dropped UI tick. */
export function publishEvent(event: AppEvent): void {
  getPublisher()
    .publish(EVENTS_CHANNEL, JSON.stringify(event))
    .catch((err) =>
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), type: event.type },
        'event publish failed',
      ),
    );
}

let subscriber: IORedis | undefined;
const handlers = new Set<(event: AppEvent) => void>();

/**
 * Register a handler for events. Opens the shared SUB connection on first call.
 * Returns an unsubscribe function for the handler — the connection stays open
 * for the process lifetime (typical for an api process).
 */
export function subscribeEvents(handler: (event: AppEvent) => void): () => void {
  if (!subscriber) {
    subscriber = createRedisConnection();
    subscriber.subscribe(EVENTS_CHANNEL).catch((err) =>
      logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        'events subscribe failed',
      ),
    );
    subscriber.on('message', (channel, raw) => {
      if (channel !== EVENTS_CHANNEL) return;
      let parsed: AppEvent;
      try {
        parsed = JSON.parse(raw) as AppEvent;
      } catch {
        return;
      }
      for (const h of handlers) {
        try {
          h(parsed);
        } catch (err) {
          logger.warn(
            { err: err instanceof Error ? err.message : String(err) },
            'event handler threw',
          );
        }
      }
    });
  }
  handlers.add(handler);
  return () => {
    handlers.delete(handler);
  };
}

/** Tear down both connections on shutdown. */
export async function closeEvents(): Promise<void> {
  if (subscriber) {
    await subscriber.unsubscribe(EVENTS_CHANNEL).catch(() => undefined);
    subscriber.disconnect();
    subscriber = undefined;
  }
  if (publisher) {
    publisher.disconnect();
    publisher = undefined;
  }
  handlers.clear();
}
