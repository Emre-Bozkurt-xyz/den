#!/usr/bin/env node
/**
 * Generate a VAPID keypair for Web Push. Run once:  npm run vapid:gen
 * Paste the printed lines into your .env (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY).
 * The keypair is stable for the app's life — regenerating invalidates every
 * existing push subscription, so keep it in .env, never commit it.
 */
import webpush from 'web-push';

const { publicKey, privateKey } = webpush.generateVAPIDKeys();

console.log('\n# ── VAPID keys — paste into .env (do NOT commit) ──');
console.log(`VAPID_PUBLIC_KEY=${publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${privateKey}`);
console.log('# VAPID_SUBJECT should be a mailto: you control, e.g. mailto:admin@ems-place.com\n');
