import type { DB } from '../db/index.js';
import {
  getActiveTheater,
  lockMemberForSelection,
  getSelection,
  getSelectionCount,
  insertSelection,
  isTheaterSelected,
  removeSelection,
} from '../db/selection-queries.js';
import { AppError, ForbiddenError, NotFoundError } from '../utils/errors.js';
import { MEMBER_ONLY_ENDPOINT_MESSAGE } from '../types/role.js';
import type { Theater } from '../types/scraper.js';

export const MAX_SELECTION_SIZE = 50;

export class SelectionService {
  constructor(private readonly db: DB) {}

  async list(memberId: number): Promise<Theater[]> {
    return getSelection(this.db, memberId);
  }

  async add(memberId: number, theaterId: string): Promise<Theater> {
    return this.db.transaction(async (transaction) => {
      const tx = transaction as DB;
      const member = await lockMemberForSelection(tx, memberId);
      if (!member) {
        throw new NotFoundError('Member not found');
      }
      if (member.role_name !== 'member') {
        throw new ForbiddenError(MEMBER_ONLY_ENDPOINT_MESSAGE);
      }

      const theater = await getActiveTheater(tx, theaterId);
      if (!theater) {
        throw new NotFoundError(`Active theater not found: ${theaterId}`);
      }

      if (await isTheaterSelected(tx, memberId, theaterId)) {
        return theater;
      }

      const count = await getSelectionCount(tx, memberId);
      if (count >= MAX_SELECTION_SIZE) {
        throw new AppError(
          `Selection contains ${count} theaters; maximum is ${MAX_SELECTION_SIZE}`,
          409,
        );
      }

      await insertSelection(tx, memberId, theaterId);
      return theater;
    });
  }

  async remove(memberId: number, theaterId: string): Promise<boolean> {
    return removeSelection(this.db, memberId, theaterId);
  }
}
