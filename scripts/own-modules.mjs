// Security review 2026-10-20 (critical): a bundle asks for a few packages by name that it does not
// hold (ws for bufferutil and utf-8-validate, debug for supports-color), inside try/catch. Node looks
// for them in every node_modules above the bundle, and any user may make C:\node_modules, above the
// Windows service's own copy: what they put there ran in the server, with every saved credential.
// Each bundle therefore starts by refusing to look up any package by name from its own folder or
// the folders inside it: by require, a require made for one of its files, or import(). Built-in
// modules, its own files and an add-on loaded from its absolute folder (the verified loader,
// server/src/optional/modules.ts) still load, and so do the packages that add-on asks for.
// A worker thread has hooks of its own and is not covered: neither bundle starts one (fourth review
// 2026-10-20, minor 4).

/**
 * Installed by the bundle's first statement, given its own require and module. A request for a
 * package by name from a module in the bundle's folder fails as a missing module, so callers fall
 * back as they do when it is not installed. Node's resolve hook sees require and import() alike;
 * the patched lookup behind it is matched on the folder too, since Node caches what it found by the
 * asking module's folder (second review 2026-10-20, minor 2). Folders are compared as URLs, the form
 * import() names its caller in, also for a bundle started by a \\?\ path (third review 2026-10-20,
 * minor 2). Code with no file (the standalone binary's shell worker) has no folder: only itself and
 * the name it was compiled as are its own (fourth and fifth reviews 2026-10-20, minor 1).
 * It fails closed: a Node without the lookup does not start the bundle.
 */
function guardOwnModules(require, module) {
  const Module = require('node:module')
  const { isAbsolute, join, resolve } = require('node:path')
  const { pathToFileURL } = require('node:url')
  const lookup = Module._resolveFilename
  if (typeof lookup !== 'function' || typeof Module.isBuiltin !== 'function')
    throw new Error('This Node.js cannot keep the program from loading packages from outside it')
  const folder = module.filename ? new URL('.', pathToFileURL(module.filename)).href : null
  const named = module.filename ? null : pathToFileURL(resolve(module.id)).href
  const inside = (url) =>
    typeof url === 'string' && (folder !== null ? url.startsWith(folder) : url === named)
  const ofModule = (m) => {
    try {
      return pathToFileURL(resolve(m.filename ?? join(m.path, '-'))).href
    } catch {
      return null
    }
  }
  // On Windows .\ is relative too; elsewhere it is part of a package's name. A file: name is a
  // package's name to require (third review 2026-10-20, minor 1).
  const relative = process.platform === 'win32' ? /^\.\.?(?:[\\/]|$)/ : /^\.\.?(?:\/|$)/
  const byName = (request) =>
    typeof request === 'string' &&
    !Module.isBuiltin(request) &&
    !relative.test(request) &&
    !isAbsolute(request)
  const refused = (request) => {
    const e = new Error(`Cannot find module '${request}': the program loads no package from outside itself`)
    e.code = 'MODULE_NOT_FOUND'
    return e
  }
  if (typeof Module.registerHooks === 'function')
    Module.registerHooks({
      resolve(specifier, context, next) {
        // import() of any URL looks in no node_modules; require of file:x does (fourth review
        // 2026-10-20, minor 1).
        const required = (context.conditions ?? []).includes('require')
        if (!required && URL.canParse(specifier)) return next(specifier, context)
        // No caller named (code compiled with no file, like that shell worker): import() would look
        // from the current folder, require in the global folders (fifth review 2026-10-20, minor 2).
        if (byName(specifier) && (context.parentURL === undefined || inside(context.parentURL)))
          throw refused(specifier)
        return next(specifier, context)
      },
    })
  Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && (parent === module || inside(ofModule(parent))) && byName(request)) throw refused(request)
    return lookup.call(this, request, parent, ...rest)
  }
}

/** The guard as the bundle's first statement (after a shebang). */
export function ownModulesGuard() {
  return `;(${guardOwnModules.toString()})(require, module);`
}
