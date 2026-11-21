; `import { a, b as c } from './m'`
(import_statement
  (import_clause
    (named_imports (import_specifier name: (_) @import.name alias: (_)? @import.alias)))
  source: (string (string_fragment) @import.source))
; `import a from './m'`
(import_statement
  (import_clause (identifier) @import.default)
  source: (string (string_fragment) @import.source))
; `import * as m from './m'`
(import_statement
  (import_clause (namespace_import (identifier) @import.module))
  source: (string (string_fragment) @import.source))
; `export * from './m'` re-exports are not followed.
