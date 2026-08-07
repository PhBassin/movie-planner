import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ScheduledTask } from 'node-cron';

// --- Mocks (declared before importing the module under test) ---

const mockValidate = vi.fn().mockReturnValue(true);

function makeTask(): ScheduledTask {
  return {
    stop: vi.fn(),
    start: vi.fn(),
    now: vi.fn(),
  } as unknown as ScheduledTask;
}

const createdTasks: ScheduledTask[] = [];
let nextTask: ScheduledTask = makeTask();
const capturedCallbacks: Array<(...args: unknown[]) => void> = [];

const mockSchedule = vi.fn().mockImplementation((_expr: string, fn: (...args: unknown[]) => void) => {
  capturedCallbacks.push(fn);
  const task = nextTask;
  createdTasks.push(task);
  nextTask = makeTask();
  return task;
});

vi.mock('node-cron', () => ({
  default: {
    validate: (...a: unknown[]) => mockValidate(...a),
    schedule: (...a: unknown[]) => mockSchedule(...(a as [string, (...args: unknown[]) => void])),
  },
}));

vi.mock('../../../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { CronScheduler, type CronSchedule } from '../../../src/scheduler/cron-scheduler.js';
import type { BusConsumer, ScheduleChangeEvent } from '@movie-planner/scraper-protocol';

interface CapturedBus {
  bus: BusConsumer;
  getScheduleHandler(): (event: ScheduleChangeEvent) => void | Promise<void>;
}

function createMockBus(): CapturedBus {
  let scheduleHandler: ((event: ScheduleChangeEvent) => void | Promise<void>) | null = null;
  const bus = {
    subscribeScheduleChange: vi.fn(async (handler: (event: ScheduleChangeEvent) => void | Promise<void>) => {
      scheduleHandler = handler;
    }),
  };
  return {
    bus: bus as unknown as BusConsumer,
    getScheduleHandler: () => {
      if (!scheduleHandler) throw new Error('subscribeScheduleChange was not called');
      return scheduleHandler;
    },
  };
}

function schedule(id: number, name: string, cronExpression: string): CronSchedule {
  return { id, name, cronExpression };
}

describe('CronScheduler', () => {
  let captured: CapturedBus;
  let executor: ReturnType<typeof vi.fn>;
  let loadEnabledSchedules: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockValidate.mockReturnValue(true);
    createdTasks.length = 0;
    capturedCallbacks.length = 0;
    nextTask = makeTask();

    captured = createMockBus();
    executor = vi.fn().mockResolvedValue(undefined);
    loadEnabledSchedules = vi.fn().mockResolvedValue([]);
  });

  function makeScheduler(): CronScheduler {
    return new CronScheduler({
      bus: captured.bus,
      executor,
      loadEnabledSchedules,
    });
  }

  describe('start', () => {
    it('loads enabled schedules from the database and registers each as a cron task', async () => {
      loadEnabledSchedules.mockResolvedValue([
        schedule(1, 'Weekly', '0 8 * * 3'),
        schedule(2, 'Daily', '0 8 * * *'),
      ]);

      const scheduler = makeScheduler();
      await scheduler.start();

      expect(loadEnabledSchedules).toHaveBeenCalledOnce();
      expect(mockSchedule).toHaveBeenCalledTimes(2);
      expect(mockSchedule).toHaveBeenCalledWith('0 8 * * 3', expect.any(Function));
      expect(mockSchedule).toHaveBeenCalledWith('0 8 * * *', expect.any(Function));
      expect(scheduler.size).toBe(2);
    });

    it('skips schedules with an invalid cron expression', async () => {
      mockValidate.mockReturnValue(false);
      loadEnabledSchedules.mockResolvedValue([schedule(1, 'Bad', 'not-a-cron')]);

      const scheduler = makeScheduler();
      await scheduler.start();

      expect(mockSchedule).not.toHaveBeenCalled();
      expect(scheduler.size).toBe(0);
    });

    it('subscribes to schedule-change events on the bus', async () => {
      const scheduler = makeScheduler();
      await scheduler.start();

      expect(captured.bus.subscribeScheduleChange).toHaveBeenCalledOnce();
      // The handler is exercised through handleScheduleChange tests below.
      expect(captured.getScheduleHandler()).toBeTypeOf('function');
    });

    it('still subscribes to changes when loading schedules from the database fails', async () => {
      loadEnabledSchedules.mockRejectedValue(new Error('db down'));

      const scheduler = makeScheduler();
      await scheduler.start();

      expect(captured.bus.subscribeScheduleChange).toHaveBeenCalledOnce();
      expect(scheduler.size).toBe(0);
    });
  });

  describe('cron firing', () => {
    it('invokes the executor with the schedule when the cron callback fires', async () => {
      loadEnabledSchedules.mockResolvedValue([schedule(7, 'Weekly', '0 8 * * 3')]);

      const scheduler = makeScheduler();
      await scheduler.start();

      expect(capturedCallbacks).toHaveLength(1);
      await capturedCallbacks[0]();

      expect(executor).toHaveBeenCalledOnce();
      expect(executor).toHaveBeenCalledWith({ id: 7, name: 'Weekly', cronExpression: '0 8 * * 3' });
    });

    it('logs and swallows a rejecting executor instead of surfacing an unhandled rejection', async () => {
      const { logger } = await import('../../../src/utils/logger.js');
      executor.mockRejectedValue(new Error('boom'));
      loadEnabledSchedules.mockResolvedValue([schedule(7, 'Weekly', '0 8 * * 3')]);

      const scheduler = makeScheduler();
      await scheduler.start();

      await capturedCallbacks[0]();
      // The callback is fire-and-forget; let the executor's .catch settle.
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('Executor for "Weekly"'),
        expect.any(Error)
      );
    });
  });

  describe('handleScheduleChange', () => {
    /** Loads a single enabled schedule, starts the scheduler, and returns the
     *  registered task plus a cleared schedule mock for change assertions. */
    async function seedAndStart(): Promise<{ scheduler: CronScheduler; firstTask: ScheduledTask }> {
      loadEnabledSchedules.mockResolvedValue([schedule(5, 'Old', '0 8 * * 3')]);
      const scheduler = makeScheduler();
      await scheduler.start();
      const firstTask = createdTasks[0];
      mockSchedule.mockClear();
      return { scheduler, firstTask };
    }

    it('registers a newly created enabled schedule', async () => {
      const scheduler = makeScheduler();
      await scheduler.start();
      mockSchedule.mockClear();

      await scheduler.handleScheduleChange({
        action: 'created',
        scheduleId: 5,
        schedule: { id: 5, name: 'New', cron_expression: '0 0 * * *', enabled: true },
      });

      expect(mockSchedule).toHaveBeenCalledWith('0 0 * * *', expect.any(Function));
      expect(scheduler.size).toBe(1);
    });

    it('does not register a created schedule that is disabled', async () => {
      const scheduler = makeScheduler();
      await scheduler.start();
      mockSchedule.mockClear();

      await scheduler.handleScheduleChange({
        action: 'created',
        scheduleId: 5,
        schedule: { id: 5, name: 'New', cron_expression: '0 0 * * *', enabled: false },
      });

      expect(mockSchedule).not.toHaveBeenCalled();
      expect(scheduler.size).toBe(0);
    });

    it('stops the previous task and re-registers on update', async () => {
      const { scheduler, firstTask } = await seedAndStart();

      await scheduler.handleScheduleChange({
        action: 'updated',
        scheduleId: 5,
        schedule: { id: 5, name: 'New', cron_expression: '0 9 * * 3', enabled: true },
      });

      expect(firstTask.stop).toHaveBeenCalledOnce();
      expect(mockSchedule).toHaveBeenCalledWith('0 9 * * 3', expect.any(Function));
      expect(scheduler.size).toBe(1);
    });

    it('unregisters but does not re-register on update to a disabled schedule', async () => {
      const { scheduler, firstTask } = await seedAndStart();

      await scheduler.handleScheduleChange({
        action: 'updated',
        scheduleId: 5,
        schedule: { id: 5, name: 'New', cron_expression: '0 9 * * 3', enabled: false },
      });

      expect(firstTask.stop).toHaveBeenCalledOnce();
      expect(mockSchedule).not.toHaveBeenCalled();
      expect(scheduler.size).toBe(0);
    });

    it('stops and removes the task on delete', async () => {
      const { scheduler, firstTask } = await seedAndStart();

      await scheduler.handleScheduleChange({ action: 'deleted', scheduleId: 5 });

      expect(firstTask.stop).toHaveBeenCalledOnce();
      expect(scheduler.size).toBe(0);
    });

    it('forwards events delivered through the bus subscription', async () => {
      const scheduler = makeScheduler();
      await scheduler.start();

      await captured.getScheduleHandler()({
        action: 'created',
        scheduleId: 9,
        schedule: { id: 9, name: 'Relayed', cron_expression: '0 7 * * *', enabled: true },
      });

      expect(mockSchedule).toHaveBeenCalledWith('0 7 * * *', expect.any(Function));
      expect(scheduler.size).toBe(1);
    });
  });

  describe('stop', () => {
    it('stops every registered task and clears the registry', async () => {
      loadEnabledSchedules.mockResolvedValue([
        schedule(1, 'Weekly', '0 8 * * 3'),
        schedule(2, 'Daily', '0 8 * * *'),
      ]);

      const scheduler = makeScheduler();
      await scheduler.start();

      scheduler.stop();

      expect((createdTasks[0] as unknown as { stop: ReturnType<typeof vi.fn> }).stop).toHaveBeenCalledOnce();
      expect((createdTasks[1] as unknown as { stop: ReturnType<typeof vi.fn> }).stop).toHaveBeenCalledOnce();
      expect(scheduler.size).toBe(0);
    });
  });
});
