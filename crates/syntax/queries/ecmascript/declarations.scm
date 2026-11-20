; Shared by JavaScript, TypeScript and TSX.
(method_definition name: (_) @name) @definition.method
(import_statement source: (string) @name) @definition.import
(import_specifier name: (_) @name) @definition.import
(program (lexical_declaration (variable_declarator name: (identifier) @name) @definition.constant))
(program (export_statement (lexical_declaration (variable_declarator name: (identifier) @name) @definition.constant)))
