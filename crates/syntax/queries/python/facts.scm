; Calls: the callee's name, reached through a receiver.
(call function: (identifier) @call)
(call function: (attribute object: (_) @call.receiver attribute: (identifier) @call))

; Attribute uses, for known ones such as `os.environ`.
(attribute object: (_) @reference.receiver attribute: (identifier) @reference)

; Decorators, for known ones.
(decorator [(identifier) (attribute)] @annotation)
(decorator (call function: (_) @annotation))

; Control flow.
(if_statement condition: (_) @control.branch.subject) @control.branch
(elif_clause condition: (_) @control.branch.subject) @control.branch
(else_clause "else" @control.branch.subject) @control.branch
(conditional_expression (_) "if" (_) @control.branch.subject "else") @control.branch
(case_clause (case_pattern) @control.match_arm.subject) @control.match_arm
(for_statement right: (_) @control.loop.subject) @control.loop
(while_statement condition: (_) @control.loop.subject) @control.loop

; Early returns: inside a branch, loop, handler, `with` or case. (Not
; "before more statements": that depends on code outside the return.)
(if_statement
  consequence: (block
    (return_statement "return" @control.early_return.subject) @control.early_return))
(elif_clause
  consequence: (block
    (return_statement "return" @control.early_return.subject) @control.early_return))
(else_clause
  body: (block
    (return_statement "return" @control.early_return.subject) @control.early_return))
(for_statement
  body: (block
    (return_statement "return" @control.early_return.subject) @control.early_return))
(while_statement
  body: (block
    (return_statement "return" @control.early_return.subject) @control.early_return))
(try_statement
  body: (block
    (return_statement "return" @control.early_return.subject) @control.early_return))
(except_clause
  (block
    (return_statement "return" @control.early_return.subject) @control.early_return))
(with_statement
  body: (block
    (return_statement "return" @control.early_return.subject) @control.early_return))
(case_clause
  consequence: (block
    (return_statement "return" @control.early_return.subject) @control.early_return))

; Error handling.
(except_clause "except" @error.catch.subject) @error.catch
(except_clause value: (_) @error.type)
(raise_statement "raise" @error.throw.subject) @error.throw

; Data.
[(integer) (float) (string) (true) (false) (none)] @data.literal
(class_definition
  body: (block
    (expression_statement
      (assignment left: (identifier) @data.field.subject) @data.field)))
(typed_parameter type: (_) @data.type)
(typed_default_parameter type: (_) @data.type)
(function_definition return_type: (_) @data.type)
(assignment type: (_) @data.type)

; API surface: the signatures of public (not `_`-prefixed) module
; functions and methods.
(module
  (function_definition name: (identifier) @_name parameters: (_) @api.signature)
  (#not-match? @_name "^_"))
(module
  (function_definition name: (identifier) @_name return_type: (_) @api.signature)
  (#not-match? @_name "^_"))
(module
  (decorated_definition
    definition: (function_definition name: (identifier) @_name parameters: (_) @api.signature))
  (#not-match? @_name "^_"))
(class_definition
  body: (block
    (function_definition name: (identifier) @_name parameters: (_) @api.signature))
  (#not-match? @_name "^_"))

; Concurrency.
(function_definition "async" @concurrency.async)
(await "await" @concurrency.await.subject) @concurrency.await
(with_statement "async" @concurrency.async)

; Test code: pytest/unittest-style functions and classes.
(function_definition name: (identifier) @_name (#match? @_name "^test")) @test
(decorated_definition
  definition: (function_definition name: (identifier) @_name)
  (#match? @_name "^test")) @test
(class_definition name: (identifier) @_name (#match? @_name "^Test")) @test
