import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import * as argon2 from 'argon2';

/**
 * Utilidad de un solo uso para el owner (Fase 6.1): imprime el hash
 * Argon2id de una contraseña para pegar como `OWNER_PASSWORD_HASH` — la
 * contraseña en claro nunca se guarda en ningún lado (env, código, logs).
 */
async function main(): Promise<void> {
  const rl = createInterface({ input: stdin, output: stdout });
  const password = await rl.question('Contraseña del owner: ');
  rl.close();

  if (!password) {
    console.error('Contraseña vacía — abortado.');
    process.exitCode = 1;
    return;
  }

  const hash = await argon2.hash(password, { type: argon2.argon2id });
  console.log('\nOWNER_PASSWORD_HASH=' + hash);
}

void main();
