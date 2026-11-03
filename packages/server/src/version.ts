import pkg from '../package.json' with { type: 'json' }

/** The server's version (what backups name as their tool), as the CLI reads its own. */
export const VERSION: string = pkg.version
