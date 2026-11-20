; Shared by JavaScript, TypeScript and TSX.

; Calls and constructions: the callee's name, reached through a receiver.
(call_expression function: (identifier) @call)
(call_expression
  function: (member_expression object: (_) @call.receiver property: (_) @call))
(new_expression constructor: (identifier) @call)
(new_expression
  constructor: (member_expression object: (_) @call.receiver property: (_) @call))

; Member uses, for known ones such as `process.env`.
(member_expression object: (_) @reference.receiver property: (_) @reference)

; Control flow.
(if_statement
  condition: (parenthesized_expression (_) @control.branch.subject)) @control.branch
(else_clause "else" @control.branch.subject (statement_block)) @control.branch
(ternary_expression condition: (_) @control.branch.subject) @control.branch
(switch_case value: (_) @control.match_arm.subject) @control.match_arm
(switch_default "default" @control.match_arm.subject) @control.match_arm
(for_statement "for" @control.loop.subject) @control.loop
(for_in_statement right: (_) @control.loop.subject) @control.loop
(while_statement
  condition: (parenthesized_expression (_) @control.loop.subject)) @control.loop
(do_statement
  condition: (parenthesized_expression (_) @control.loop.subject)) @control.loop

; Early returns: inside a branch, loop, case or handler. (Not "before more
; statements": that depends on code outside the return.)
(if_statement
  consequence: (return_statement "return" @control.early_return.subject) @control.early_return)
(if_statement
  consequence: (statement_block
    (return_statement "return" @control.early_return.subject) @control.early_return))
(else_clause
  (return_statement "return" @control.early_return.subject) @control.early_return)
(else_clause
  (statement_block
    (return_statement "return" @control.early_return.subject) @control.early_return))
(switch_case
  (return_statement "return" @control.early_return.subject) @control.early_return)
(for_statement
  body: (statement_block
    (return_statement "return" @control.early_return.subject) @control.early_return))
(for_in_statement
  body: (statement_block
    (return_statement "return" @control.early_return.subject) @control.early_return))
(while_statement
  body: (statement_block
    (return_statement "return" @control.early_return.subject) @control.early_return))
(try_statement
  body: (statement_block
    (return_statement "return" @control.early_return.subject) @control.early_return))
(catch_clause
  body: (statement_block
    (return_statement "return" @control.early_return.subject) @control.early_return))

; Error handling.
(catch_clause "catch" @error.catch.subject) @error.catch
(throw_statement "throw" @error.throw.subject) @error.throw

; Data.
[(number) (string) (template_string) (true) (false) (null)] @data.literal

; API surface.
(export_statement "export" @api.visibility)
(export_statement declaration: (function_declaration parameters: (_) @api.signature))

; Concurrency.
(function_declaration "async" @concurrency.async)
(function_expression "async" @concurrency.async)
(arrow_function "async" @concurrency.async)
(method_definition "async" @concurrency.async)
(await_expression "await" @concurrency.await.subject) @concurrency.await

; Test code: `describe`, `it` and `test` blocks (and their `.each`,
; `.only`, `.skip` forms).
(call_expression
  function: (identifier) @_test
  (#any-of? @_test "describe" "it" "test")) @test
(call_expression
  function: (member_expression object: (identifier) @_test)
  (#any-of? @_test "describe" "it" "test")) @test
