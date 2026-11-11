// zod, set up for the worker. Import it from here as a namespace (`import * as z from './zod'`),
// never from 'zod': the setting below must be in place before any schema is built. Everything is
// passed on export by export, so the bundler can leave out the parts of zod that are not used; one
// `z` object passed on from here would keep all of it.
import { config } from 'zod'

// Workers forbid generating code, so zod parses there without compiling its parsers. Say so, so the
// tests, which run in Node where compiling works, run the same parser as the deployed worker. zod
// reads this when a schema is built.
config({ jitless: true })

export * from 'zod'
