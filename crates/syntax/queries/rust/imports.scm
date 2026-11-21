; `use a::b;`, and each path in a list (`use a::{b, c::d};`, prefixed by
; the lists' paths): the last segment is bound.
(use_declaration
  argument: [(identifier) (scoped_identifier) (crate) (self) (super)] @import.name)
(use_list [(identifier) (scoped_identifier) (self)] @import.name)
(use_as_clause path: (_) @import.name alias: (identifier) @import.alias)
; `use a::*;`
(use_wildcard (_) @import.glob)
