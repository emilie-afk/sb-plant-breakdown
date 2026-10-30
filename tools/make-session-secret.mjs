// tools/make-session-secret.mjs — a random SESSION_SECRET (or a Worker key).
import crypto from 'node:crypto';
console.log(crypto.randomBytes(48).toString('base64url'));
