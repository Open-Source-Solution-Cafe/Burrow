import type { IStorageAdapter } from '../adapters/storage/types';

/**
 * Deletes a storage object with one immediate retry to handle transient storage failures.
 * Never throws; logs failures so operators can reconcile any remaining objects via inventory.
 */
export async function deleteStorageObjectWithRetry(
  storage: IStorageAdapter,
  key: string,
  context: string,
): Promise<boolean> {
  try {
    await storage.delete(key);
    return true;
  } catch (firstError) {
    try {
      await storage.delete(key);
      return true;
    } catch (retryError) {
      console.error(`${context} (${key}):`, retryError ?? firstError);
      return false;
    }
  }
}
