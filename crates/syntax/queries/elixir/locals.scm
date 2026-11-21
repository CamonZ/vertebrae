; Local bindings: function parameters, matches (`x = ...`, `{:ok, x} <-
; ...`), and anonymous function and clause parameters. Elixir calls a
; variable only as `f.(x)`, so they never bind a named call.
(call
  target: (identifier) @_def
  (arguments . [(call (arguments (identifier) @local))
                (binary_operator left: (call (arguments (identifier) @local)) operator: "when")])
  (#any-of? @_def "def" "defp" "defmacro" "defmacrop"))
(binary_operator left: (identifier) @local operator: "=")
(binary_operator left: (tuple (identifier) @local) operator: ["=" "<-"])
(stab_clause left: (arguments (identifier) @local))
