import { sql, type Transaction } from '@mip/db';
import { beforeCardWrite } from './write-guard.js';

/** One fenced transaction for the mutation AND general audit. Never retries. */
export async function cardMutation<T>(operation: (tx: Transaction) => Promise<T>): Promise<T> {
  await beforeCardWrite();
  return sql.begin(async tx => {
    const result = await operation(tx);
    await beforeCardWrite(); // Lease lost during audit/work => rollback before commit.
    return result;
  }) as Promise<T>;
}
