import { Response } from 'express';
import type { ProgressEvent } from 'allo-scrapper-scraper-protocol';

// Progress event types — re-exported from allo-scrapper-scraper-protocol so
// existing importers keep working. The wire contract lives in one place.
export type { ProgressEvent, ScrapeSummary } from 'allo-scrapper-scraper-protocol';

// Progress tracker class
class ProgressTracker {
  private listeners: Set<Response> = new Set();
  private events: ProgressEvent[] = [];
  private heartbeatInterval?: NodeJS.Timeout;

  // Add a new SSE listener
  addListener(res: Response): void {
    this.listeners.add(res);

    // Send existing events to new listener
    for (const event of this.events) {
      this.sendToListener(res, event);
    }

    // Start heartbeat if this is the first listener
    if (this.listeners.size === 1) {
      this.startHeartbeat();
    }
  }

  // Remove a listener
  removeListener(res: Response): void {
    this.listeners.delete(res);

    // Stop heartbeat if no more listeners
    if (this.listeners.size === 0) {
      this.stopHeartbeat();
    }
  }

  // Emit a progress event to all listeners
  emit(event: ProgressEvent): void {
    this.events.push(event);

    // Send to all connected listeners
    for (const listener of this.listeners) {
      this.sendToListener(listener, event);
    }
  }

  // Send an event to a specific listener
  private sendToListener(res: Response, event: ProgressEvent): void {
    try {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    } catch (error) {
      // Listener disconnected, remove it
      this.listeners.delete(res);
    }
  }

  // Send heartbeat to keep connections alive
  private startHeartbeat(): void {
    this.heartbeatInterval = setInterval(() => {
      for (const listener of this.listeners) {
        try {
          listener.write(': heartbeat\n\n');
        } catch (error) {
          this.listeners.delete(listener);
        }
      }
    }, 15000); // Every 15 seconds
  }

  // Stop heartbeat
  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = undefined;
    }
  }

  // Clear all events and listeners
  reset(): void {
    this.events = [];
    this.stopHeartbeat();
    
    // Close all active connections
    for (const listener of this.listeners) {
      try {
        listener.end();
      } catch (error) {
        // Ignore errors when closing
      }
    }
    this.listeners.clear();
  }

  // Get all events (for debugging or storing in database)
  getEvents(): ProgressEvent[] {
    return [...this.events];
  }

  // Get number of active listeners
  getListenerCount(): number {
    return this.listeners.size;
  }
}

// Singleton instance
export const progressTracker = new ProgressTracker();
