import { createClient } from '@supabase/supabase-js';

export interface Storage {
  /** Stores bytes at path; never overwrites. */
  put(path: string, bytes: Uint8Array, contentType: string): Promise<void>;
  /** Short-lived signed URL for a private object. */
  signedUrl(path: string, seconds: number): Promise<string>;
}

export const BUCKET = 'invoice-documents';

/** Server-side only: uses the service-role key, which must never reach a browser. */
export function supabaseStorage(url: string, serviceRoleKey: string): Storage {
  const bucket = createClient(url, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } }).storage.from(BUCKET);
  return {
    async put(path, bytes, contentType) {
      const { error } = await bucket.upload(path, bytes, { contentType, upsert: false });
      if (error) throw new Error(`Storage upload failed: ${error.message}`);
    },
    async signedUrl(path, seconds) {
      const { data, error } = await bucket.createSignedUrl(path, seconds);
      if (error || !data) throw new Error('Storage signing failed');
      return data.signedUrl;
    },
  };
}

export function memoryStorage(): Storage & { objects: Map<string, { bytes: Uint8Array; contentType: string }> } {
  const objects = new Map<string, { bytes: Uint8Array; contentType: string }>();
  return {
    objects,
    async put(path, bytes, contentType) {
      if (objects.has(path)) throw new Error('Object already exists');
      objects.set(path, { bytes: new Uint8Array(bytes), contentType });
    },
    async signedUrl(path, seconds) { return `https://storage.test/${encodeURI(path)}?expires_in=${seconds}`; },
  };
}
