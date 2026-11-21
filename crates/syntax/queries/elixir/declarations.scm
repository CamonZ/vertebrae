; Elixir declares everything with calls: `defmodule`, `def` and the rest
; are `call` nodes whose target names the construct. `@keyword` is that
; target, `@parameters` a function head's arguments (for its arity) and
; `@body` its `do` block or `do:` value (what follows is not its
; signature). This replaces the grammar's tags query.

; Modules and protocols, named by their alias.
(call
  target: (identifier) @keyword
  (arguments . (alias) @name)
  (#any-of? @keyword "defmodule" "defprotocol")) @definition.module

; Protocol implementations, named by their protocol.
(call
  target: (identifier) @keyword
  (arguments . (alias) @name)
  (#eq? @keyword "defimpl")) @definition.module

; Functions, macros and guards: a head with arguments, with a guard, or a
; bare name (zero arity, no parentheses).
(call
  target: (identifier) @keyword
  (arguments . (call target: (identifier) @name (arguments)? @parameters))
  (#any-of? @keyword "def" "defp" "defmacro" "defmacrop" "defguard" "defguardp" "defn" "defnp" "defdelegate")) @definition.function
(call
  target: (identifier) @keyword
  (arguments
    .
    (binary_operator
      left: (call target: (identifier) @name (arguments)? @parameters)
      operator: "when"))
  (#any-of? @keyword "def" "defp" "defmacro" "defmacrop" "defguard" "defguardp" "defn" "defnp")) @definition.function
(call
  target: (identifier) @keyword
  (arguments . (identifier) @name)
  (#any-of? @keyword "def" "defp" "defmacro" "defmacrop" "defn" "defnp")) @definition.function

; Bodies: a `do` block, or a `do:` keyword's value.
(call
  target: (identifier) @_def
  (do_block) @body
  (#any-of? @_def "def" "defp" "defmacro" "defmacrop" "defn" "defnp")) @definition.function
(call
  target: (identifier) @_def
  (arguments
    (keywords
      (pair key: (keyword) @_do value: (_) @body)))
  (#any-of? @_def "def" "defp" "defmacro" "defmacrop" "defguard" "defguardp" "defn" "defnp")
  (#match? @_do "^do:")) @definition.function

; Structs and exceptions, named by their module; their fields are atoms
; and keyword keys.
(call
  target: (identifier) @_module
  (arguments (alias) @name)
  (do_block
    (call target: (identifier) @keyword) @definition.class)
  (#eq? @_module "defmodule")
  (#any-of? @keyword "defstruct" "defexception"))
(call
  target: (identifier) @_struct
  (arguments (list (atom) @name @definition.field))
  (#any-of? @_struct "defstruct" "defexception"))
(call
  target: (identifier) @_struct
  (arguments (list (keywords (pair key: (keyword) @name) @definition.field)))
  (#any-of? @_struct "defstruct" "defexception"))
(call
  target: (identifier) @_struct
  (arguments (keywords (pair key: (keyword) @name) @definition.field))
  (#any-of? @_struct "defstruct" "defexception"))

; Module attributes: types (`type t`), callbacks (`callback fetch`) and
; constants (`@ timeout`, for `@timeout 5_000`). Documentation and
; compiler attributes annotate what follows instead.
(unary_operator
  operator: "@"
  operand: (call
    target: (identifier) @keyword
    (arguments
      (binary_operator
        left: [(identifier) @name (call target: (identifier) @name)]
        operator: "::")))
  (#any-of? @keyword "type" "typep" "opaque")) @definition.type
(unary_operator
  operator: "@"
  operand: (call
    target: (identifier) @keyword
    (arguments
      (binary_operator
        left: (call target: (identifier) @name)
        operator: "::")))
  (#any-of? @keyword "callback" "macrocallback")) @definition.interface
(unary_operator
  operator: "@" @keyword
  operand: (call target: (identifier) @name (arguments))
  (#not-any-of? @name
    "doc" "moduledoc" "typedoc" "spec" "type" "typep" "opaque" "callback"
    "macrocallback" "impl" "behaviour" "derive" "enforce_keys" "compile"
    "dialyzer" "deprecated" "since" "external_resource" "on_load"
    "on_definition" "before_compile" "after_compile" "optional_callbacks"
    "vsn" "file")) @definition.constant

; Imports (`alias`, `import`, `require`, `use`) group with the code after
; them rather than being scopes.
(call
  target: (identifier) @keyword
  (arguments . (_) @name)
  (#any-of? @keyword "alias" "import" "require" "use")) @definition.import
