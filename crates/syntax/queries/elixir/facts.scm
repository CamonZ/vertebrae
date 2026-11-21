; Elixir writes most constructs as calls, so the call patterns exclude the
; targets that are declarations, special forms or reported as another fact.
; `@ignore` marks code that is not a call site: function heads and module
; attributes (`@spec f(t) :: t` names `f` without calling it).

; Function heads, with or without a guard, and module attributes.
(call
  target: (identifier) @_def
  (arguments . [(call) @ignore (binary_operator left: (call) @ignore operator: "when")])
  (#any-of? @_def "def" "defp" "defmacro" "defmacrop" "defguard" "defguardp" "defn" "defnp" "defdelegate"))
(unary_operator operator: "@" operand: (_) @ignore)

; Local calls: `f(x)`, `f x`, and a bare name piped into (`x |> f`).
; `@call.arguments` holds the arguments and `@call.piped` the value piped
; in, which counts as the first argument.
(call
  target: (identifier) @call
  (arguments)? @call.arguments
  (#not-any-of? @call
    "def" "defp" "defmacro" "defmacrop" "defguard" "defguardp" "defn" "defnp"
    "defdelegate" "defmodule" "defprotocol" "defimpl" "defstruct" "defexception"
    "defoverridable" "alias" "import" "require" "use" "case" "cond" "if" "unless"
    "with" "for" "try" "receive" "quote" "unquote" "unquote_splicing" "fn" "super"
    "raise" "reraise" "throw" "test" "describe" "setup" "setup_all" "__aliases__"
    "__block__"))
(binary_operator
  left: (_) @call.piped
  operator: "|>"
  right: (call
    target: (identifier) @call
    (arguments)? @call.arguments))
(binary_operator
  left: (_) @call.piped
  operator: "|>"
  right: (identifier) @call)

; Remote calls through a module (`Repo.get(id)`, `:ets.insert(t, v)`,
; `__MODULE__.f()`), with or without parentheses, piped or not.
(call
  target: (dot
    left: [(alias) (atom) ((identifier) @_module (#eq? @_module "__MODULE__"))] @call.receiver
    right: (identifier) @call)
  (arguments)? @call.arguments)
(binary_operator
  left: (_) @call.piped
  operator: "|>"
  right: (call
    target: (dot
      left: [(alias) (atom) ((identifier) @_module (#eq? @_module "__MODULE__"))] @call.receiver
      right: (identifier) @call)
    (arguments)? @call.arguments))
; A call through a variable (`mod.run(x)`) is dynamic; without parentheses
; (`user.name`) it reads a field.
(call
  target: (dot
    left: (identifier) @call.receiver @_value
    right: (identifier) @call)
  (arguments)
  (#not-eq? @_value "__MODULE__"))
(call
  target: (dot
    left: (identifier) @_value
    right: (identifier) @data.field)
  .
  (#not-eq? @_value "__MODULE__"))

; Control flow.
(call
  target: (identifier) @_if
  (arguments . (_) @control.branch.subject)
  (#any-of? @_if "if" "unless")) @control.branch
(call
  target: (identifier) @_if
  (do_block (else_block "else" @control.branch.subject) @control.branch)
  (#any-of? @_if "if" "unless"))
(pair
  key: (keyword) @control.branch.subject @_else
  (#match? @_else "^else:")) @control.branch
(call
  target: (identifier) @_cond
  (do_block (stab_clause left: (arguments) @control.branch.subject) @control.branch)
  (#eq? @_cond "cond"))
(call
  target: (identifier) @_case
  (do_block (stab_clause left: (arguments) @control.match_arm.subject) @control.match_arm)
  (#any-of? @_case "case" "receive"))
(call
  target: (identifier) @_with
  (arguments
    (binary_operator left: (_) @control.match_arm.subject operator: "<-") @control.match_arm)
  (#eq? @_with "with"))
(call
  target: (identifier) @_for
  (arguments
    (binary_operator operator: "<-" right: (_) @control.loop.subject) @control.loop)
  (#eq? @_for "for"))

; Error handling: raising, rescuing, `with`'s `else`, raising variants of
; functions (`File.read!`) and `{:error, _}` results.
(call
  target: (identifier) @error.throw
  (#any-of? @error.throw "raise" "reraise" "throw" "exit"))
(rescue_block "rescue" @error.catch.subject) @error.catch
(catch_block "catch" @error.catch.subject) @error.catch
(call
  target: (identifier) @_with
  (do_block (else_block "else" @error.catch.subject) @error.catch)
  (#eq? @_with "with"))
(rescue_block
  (stab_clause
    left: (arguments
      [(alias) @error.type
       (binary_operator operator: "in" right: [(alias) (list)] @error.type)])))
(call
  target: [(identifier) @error.unwrap (dot right: (identifier) @error.unwrap)]
  (#match? @error.unwrap "!$")
  (#not-any-of? @error.unwrap "raise" "reraise"))
(tuple . (atom) @_error (#eq? @_error ":error")) @error.type

; Data.
[
  (integer)
  (float)
  (string)
  (charlist)
  (sigil)
  (boolean)
  (nil)
  (atom)
] @data.literal
(call
  target: (identifier) @_struct
  (arguments (list (atom) @data.field.subject @data.field))
  (#any-of? @_struct "defstruct" "defexception"))
(call
  target: (identifier) @_struct
  (arguments (list (keywords (pair key: (keyword) @data.field.subject) @data.field)))
  (#any-of? @_struct "defstruct" "defexception"))
(call
  target: (identifier) @_struct
  (arguments (keywords (pair key: (keyword) @data.field.subject) @data.field))
  (#any-of? @_struct "defstruct" "defexception"))
(unary_operator
  operand: (call
    target: (identifier) @_attribute
    (arguments (binary_operator operator: "::" right: (_) @data.type)))
  (#any-of? @_attribute "type" "typep" "opaque" "spec" "callback"))

; API surface: `def` against `defp`, and the heads of public functions.
(call
  target: (identifier) @api.visibility
  (#any-of? @api.visibility "def" "defp" "defmacro" "defmacrop" "defguard" "defguardp"))
(call
  target: (identifier) @_def
  (arguments
    . [(call (arguments) @api.signature)
       (binary_operator left: (call (arguments) @api.signature) operator: "when")])
  (#any-of? @_def "def" "defmacro" "defguard"))

; Concurrency: awaiting a task (spawning comes from the API tables).
(call
  target: (dot left: (alias) @_task right: (identifier) @concurrency.await)
  (#eq? @_task "Task")
  (#any-of? @concurrency.await "await" "await_many" "yield" "yield_many"))

; Test code: ExUnit blocks.
(call
  target: (identifier) @_test
  (#any-of? @_test "test" "describe" "setup" "setup_all")
  (do_block)) @test
