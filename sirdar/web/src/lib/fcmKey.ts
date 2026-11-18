/** The Firebase push key (SS_FCM_SERVICE_ACCOUNT_B64): the service-account
 *  JSON, base64 on one line. Checked here as envfile.valid_fcm_key checks it,
 *  so a wrong file is caught before anything is sent. Messages never quote
 *  the file: it is the secret. */
export const FCM_KEY = 'SS_FCM_SERVICE_ACCOUNT_B64';
/** envfile.FCM_KEY_MAX: the longest encoded key. */
export const FCM_KEY_MAX = 8192;
/** Anything bigger isn't read at all (a real key is about 2.3 KB). */
const FILE_MAX = 64 * 1024;
const FIELDS = ['project_id', 'client_email', 'private_key'] as const;

export const FCM_NOT_JSON = "That file isn't JSON. Choose the service-account key file you downloaded from Firebase.";
export const FCM_NOT_ACCOUNT =
  'That JSON isn\'t a Firebase service-account key: it needs "type": "service_account", project_id, client_email and private_key.';
export const FCM_TOO_LARGE = 'That file is too large to be a Firebase service-account key.';
/** The API's secret_invalid for this key. */
export const FCM_REFUSED = "Sirdar couldn't save that key. Choose the service-account key file you downloaded from Firebase.";

/** Standard base64 of the text's UTF-8 bytes (btoa alone throws past Latin-1). */
export function base64Utf8(text: string): string {
  let binary = '';
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export type FcmKeyResult = { key: string } | { problem: string };

export function fcmKeyFromText(text: string): FcmKeyResult {
  let account: unknown;
  try {
    account = JSON.parse(text);
  } catch {
    return { problem: FCM_NOT_JSON };
  }
  const obj = account as Record<string, unknown> | null;
  if (!obj || typeof obj !== 'object' || Array.isArray(obj) || obj.type !== 'service_account'
      || !FIELDS.every((k) => typeof obj[k] === 'string' && obj[k] !== '')) {
    return { problem: FCM_NOT_ACCOUNT };
  }
  const key = base64Utf8(text);
  return key.length > FCM_KEY_MAX ? { problem: FCM_TOO_LARGE } : { key };
}

export async function fcmKeyFromFile(file: File): Promise<FcmKeyResult> {
  if (file.size > FILE_MAX) return { problem: FCM_TOO_LARGE };
  let text: string;
  try {
    text = await file.text();
  } catch {
    return { problem: FCM_NOT_JSON };
  }
  return fcmKeyFromText(text);
}
