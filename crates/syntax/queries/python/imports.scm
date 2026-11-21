; `from m import a, b as c` and `from m import *`.
(import_from_statement
  module_name: (_) @import.source
  name: (dotted_name) @import.name)
(import_from_statement
  module_name: (_) @import.source
  name: (aliased_import name: (dotted_name) @import.name alias: (identifier) @import.alias))
(import_from_statement
  module_name: (_) @import.source
  (wildcard_import) @import.glob)
; `import a.b` binds `a`; `import a.b as c` binds `c` to `a.b`.
(import_statement name: (dotted_name) @import.module)
(import_statement
  name: (aliased_import name: (dotted_name) @import.module alias: (identifier) @import.alias))
