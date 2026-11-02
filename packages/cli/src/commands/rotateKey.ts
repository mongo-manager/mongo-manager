import { resolve } from 'node:path'
import { ROTATION_KEPT_MS, rotateSecretKey, type Config } from '@mongo-manager/server'
import type { Values } from '../args'
import type { Io } from '../io'

const KEPT_DAYS = ROTATION_KEPT_MS / 86_400_000

export async function rotateKeyCommand(values: Values, config: Config, io: Io): Promise<number> {
  const result = await rotateSecretKey({
    dataDir: config.dataDir,
    ...(config.secretKey ? { envKey: config.secretKey } : {}),
    ...(values['new-key-file'] ? { newKeyFile: resolve(io.cwd, values['new-key-file']) } : {}),
  })
  if (result.movedRecent || result.droppedRecent)
    io.stdout.write(
      `Moved ${result.movedRecent} recent query(ies) into the query history` +
        (result.droppedRecent ? `; ${result.droppedRecent} could not be opened and were dropped` : '') +
        '.\n',
    )
  io.stdout.write(
    `Re-encrypted ${result.connections} connection(s), ${result.totpSecrets} authenticator secret(s), ${result.history} query history entry(ies), ${result.favourites} favourite(s), ${result.savedPipelines} saved pipeline(s), ${result.shellHistory} shell history entry(ies), ${result.snippets} snippet(s), ${result.personalFields} personal-field list(s), ${result.transferPresets} saved transfer setting(s), ${result.backupDestinations} backup destination(s), ${result.backupCopies} interrupted upload(s), ${result.backupKeys} backup key(s), ${result.liveSyncPlaces} live sync place(s), ${result.aiProviderKeys} AI provider key(s), ${result.aiChats} AI chat(s) with ${result.aiChatMessages} message(s), ${result.pluginSettings} plugin setting list(s), ${result.alertChannels} alert channel secret(s) and ${result.oidcTokens} OIDC sign-in(s).\n` +
      `Backup: ${result.backupPath} (encrypted with the previous key)\n`,
  )
  if (result.oldKeyFile) {
    io.stdout.write(
      `New key: ${result.keyFile}\nPrevious key: ${result.oldKeyFile}\n` +
        'Keep the previous key only as long as you keep the backup; delete both together.\n' +
        // Security audit 2026-10-16 (minor): a recovery window, not an archive.
        `The first start after ${KEPT_DAYS} days removes both from the data directory.\n`,
    )
  } else {
    io.stdout.write(
      `The new key was written to ${result.keyFile}. Put its contents into your configuration ` +
        '(MM_SECRET_KEY or secretKey in the config file), restart, then delete the file.\n' +
        'Keep the previous key value only as long as you keep the backup, together with the backup; ' +
        'delete both together.\n' +
        `The first start after ${KEPT_DAYS} days removes the backup from the data directory.\n`,
    )
  }
  return 0
}
