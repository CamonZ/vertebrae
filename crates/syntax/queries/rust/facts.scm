; Calls: the callee's name, reached through a receiver or a path.
; `Some(..)`, `Ok(..)` and `Err(..)` build values; they are not calls.
(call_expression
  function: (identifier) @call
  (#not-any-of? @call "Some" "Ok" "Err"))
(call_expression
  function: (field_expression
    value: (_) @call.receiver
    field: (field_identifier) @call)
  (#not-any-of? @call "unwrap" "expect"))
(call_expression function: (scoped_identifier path: (_) @call.path name: (identifier) @call))
(call_expression function: (generic_function function: (identifier) @call))
(call_expression
  function: (generic_function
    function: (field_expression value: (_) @call.receiver field: (field_identifier) @call)))
(call_expression
  function: (generic_function
    function: (scoped_identifier path: (_) @call.path name: (identifier) @call)))

; Attributes, for known ones such as `#[tauri::command]`.
(attribute_item (attribute [(identifier) (scoped_identifier)] @annotation))

; Control flow.
(if_expression condition: (_) @control.branch.subject) @control.branch
(else_clause "else" @control.branch.subject (block)) @control.branch
(match_arm pattern: (_) @control.match_arm.subject) @control.match_arm
(while_expression condition: (_) @control.loop.subject) @control.loop
(for_expression value: (_) @control.loop.subject) @control.loop
(loop_expression "loop" @control.loop.subject) @control.loop
(return_expression "return" @control.early_return.subject) @control.early_return

; Error handling.
(try_expression "?" @error.propagation.subject) @error.propagation
(call_expression
  function: (field_expression field: (field_identifier) @error.unwrap)
  (#any-of? @error.unwrap "unwrap" "expect"))
(macro_invocation
  macro: (identifier) @error.throw
  (#any-of? @error.throw "panic" "unreachable" "todo" "unimplemented"))
(function_item
  return_type: (generic_type
    type: (type_identifier) @_result
    type_arguments: (type_arguments (_) (_) @error.type .))
  (#eq? @_result "Result"))

; Data.
[
  (integer_literal)
  (float_literal)
  (string_literal)
  (raw_string_literal)
  (char_literal)
  (boolean_literal)
] @data.literal
(field_declaration name: (_) @data.field.subject) @data.field
(let_declaration type: (_) @data.type)
(parameter type: (_) @data.type)
(field_declaration type: (_) @data.type)
(function_item return_type: (_) @data.type)
(const_item type: (_) @data.type)
(static_item type: (_) @data.type)

; API surface.
(visibility_modifier) @api.visibility
(function_item (visibility_modifier) parameters: (_) @api.signature)
(function_item (visibility_modifier) return_type: (_) @api.signature)

; Concurrency.
(function_modifiers "async" @concurrency.async)
(async_block "async" @concurrency.async)
(await_expression "await" @concurrency.await.subject) @concurrency.await

; Test code: an item after `#[test]`-like attributes (any attributes and
; comments between), items under a `cfg` that requires `test`, and `tests`
; modules.
((attribute_item (attribute (identifier) @_test)) @test.marker
  (#eq? @_test "test"))
((attribute_item (attribute (scoped_identifier name: (identifier) @_test))) @test.marker
  (#eq? @_test "test"))
((attribute_item
  (attribute
    (identifier) @_cfg
    arguments: (token_tree) @_args)) @test.marker
  (#eq? @_cfg "cfg")
  (#match? @_args "(^|[^A-Za-z0-9_])test([^A-Za-z0-9_]|$)")
  (#not-match? @_args "not[ \t\n]*[(][ \t\n]*test"))
(mod_item name: (identifier) @_name (#eq? @_name "tests")) @test
