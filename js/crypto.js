// Encryption layer. All data is encrypted at rest with a key derived from the
// user's passphrase. Nothing ever leaves the device.
//
//   passphrase --PBKDF2(SHA-256, 310k)--> AES-GCM 256-bit key
//   DB bytes  --AES-GCM(random 12-byte IV)--> ciphertext stored in IndexedDB
//
// The passphrase itself is never stored. A small "verifier" token (a known string
// encrypted with the key) lets us check the passphrase on unlock without storing it.

const ITERATIONS = 310000;
const VERIFIER_PLAINTEXT = 'my-budget-verify-v1';

const enc = new TextEncoder();
const dec = new TextDecoder();

export async function deriveKey(passphrase, saltBytes){
  const baseKey = await crypto.subtle.importKey(
    'raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name:'PBKDF2', salt: saltBytes, iterations: ITERATIONS, hash:'SHA-256' },
    baseKey,
    { name:'AES-GCM', length:256 },
    false,
    ['encrypt','decrypt']);
}

export function randomBytes(n){ return crypto.getRandomValues(new Uint8Array(n)); }

export async function encryptBytes(key, plainBytes){
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt({ name:'AES-GCM', iv }, key, plainBytes);
  // [12-byte IV][ciphertext]
  const out = new Uint8Array(12 + ct.byteLength);
  out.set(iv, 0); out.set(new Uint8Array(ct), 12);
  return out;
}

export async function decryptBytes(key, blob){
  const iv = blob.slice(0, 12);
  const ct = blob.slice(12);
  const pt = await crypto.subtle.decrypt({ name:'AES-GCM', iv }, key, ct);
  return new Uint8Array(pt);
}

export async function makeVerifier(key){
  return encryptBytes(key, enc.encode(VERIFIER_PLAINTEXT));
}

export async function checkVerifier(key, verifierBlob){
  try {
    const pt = await decryptBytes(key, verifierBlob);
    return dec.decode(pt) === VERIFIER_PLAINTEXT;
  } catch { return false; }
}
