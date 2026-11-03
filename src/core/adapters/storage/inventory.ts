import { isUploadPolicyStorageKey } from '../../../shared/uploadPolicy';

/** Compare file registrations with file objects, excluding internal project policy objects. */
export function compareStorageInventory(registeredKeys: readonly string[], storedKeys: readonly string[]) {
  const registered = [...new Set(registeredKeys)].sort();
  const stored = [...new Set(storedKeys)].filter((key) => !isUploadPolicyStorageKey(key)).sort();
  const registeredSet = new Set(registered);
  const storedSet = new Set(stored);
  return {
    missingObjects: registered.filter((key) => !storedSet.has(key)),
    unregisteredObjects: stored.filter((key) => !registeredSet.has(key)),
  };
}
