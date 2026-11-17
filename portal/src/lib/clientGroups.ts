/** Client groups — friendly messages for the API's error codes, the way
 *  MODEL_ERRORS does for the catalog. */
import { ApiError } from './api';

export const GROUP_ERRORS: Record<string, string> = {
  group_name_taken: 'A group with this name already exists for this client.',
  alias_in_use: 'One of these names already belongs to another group.',
  group_not_found: 'That group was already merged or deleted — refresh and try again.',
  name_required: 'Enter a group name.',
  value_required: 'There is no value to match.',
  same_group: 'A group cannot be merged into itself.',
  different_client: 'That group belongs to a different client.',
  forbidden: 'You do not have permission to change groups.',
  group_in_use: 'Remove this group from everyone who has it, or merge it into another group, before deleting it.',
};

export const groupMsgFor = (err: unknown): string =>
  err instanceof ApiError ? (GROUP_ERRORS[err.code] ?? `Request failed (${err.code}).`)
    : 'Network error — nothing was changed.';
