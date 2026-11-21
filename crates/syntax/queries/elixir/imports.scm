; `alias A.B` binds `B` to module `A.B`; `alias A.B, as: C` binds `C`;
; `alias A.{B, C}` binds both, prefixed by `A`.
(call
  target: (identifier) @_alias
  (arguments . (alias) @import.name .)
  (#eq? @_alias "alias"))
(call
  target: (identifier) @_alias
  (arguments
    . (alias) @import.name
    (keywords (pair key: (keyword) @_as value: (alias) @import.alias)))
  (#eq? @_alias "alias")
  (#match? @_as "^as:"))
(call
  target: (identifier) @_alias
  (arguments . (dot left: (alias) right: (tuple (alias) @import.name)))
  (#eq? @_alias "alias"))
; `import M` imports every function of `M`; `except:` leaves some out and
; `only: [f: 1]` imports just those.
(call
  target: (identifier) @_import
  (arguments . (alias) @import.glob .)
  (#eq? @_import "import"))
(call
  target: (identifier) @_import
  (arguments
    . (alias) @import.glob
    (keywords (pair key: (keyword) @_except value: (list (keywords (pair key: (keyword) @import.except))))))
  (#eq? @_import "import")
  (#match? @_except "^except:"))
(call
  target: (identifier) @_import
  (arguments
    . (alias) @import.glob
    (keywords (pair key: (keyword) @_only value: (atom))))
  (#eq? @_import "import")
  (#match? @_only "^only:"))
(call
  target: (identifier) @_import
  (arguments
    . (alias) @import.source
    (keywords (pair key: (keyword) @_only value: (list (keywords (pair key: (keyword) @import.name))))))
  (#eq? @_import "import")
  (#match? @_only "^only:"))
