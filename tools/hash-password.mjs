// tools/hash-password.mjs — make a DASHBOARD_*_PASSWORD_HASH value.
//   node tools/hash-password.mjs            (prompts; nothing is echoed or logged)
// Prints only the scrypt hash, which goes into the Netlify environment
// variable. The password itself is never stored anywhere.
import readline from 'node:readline';
import { hashPassword } from '../server/session.mjs';

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
rl._writeToOutput = function (s) { if (s.includes('Password')) rl.output.write(s); };
rl.question('Password (12+ characters): ', (pw) => {
  rl.close();
  process.stdout.write('\n');
  try { console.log(hashPassword(pw)); }
  catch (e) { console.error(e.message); process.exitCode = 1; }
});
