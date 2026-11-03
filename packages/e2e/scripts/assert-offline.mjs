// Fails when this machine can reach the internet: the offline e2e run must prove it has no route out.
const targets = ['https://example.com/', 'http://1.1.1.1/', 'https://registry.npmjs.org/']
const reached = []
for (const url of targets) {
  try {
    await fetch(url, { signal: AbortSignal.timeout(5000) })
    reached.push(url)
  } catch {
    // Unreachable, as it must be.
  }
}
if (reached.length) {
  console.error(`The network is reachable (${reached.join(', ')}): this run is not offline.`)
  process.exit(1)
}
console.log('No route out: running offline.')
