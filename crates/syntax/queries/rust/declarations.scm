; Declarations the grammar's tags query leaves out.
(impl_item type: (_) @name) @definition.impl
(function_signature_item name: (identifier) @name) @definition.method
(const_item name: (identifier) @name) @definition.constant
(static_item name: (identifier) @name) @definition.constant
(field_declaration name: (field_identifier) @name) @definition.field
(enum_variant name: (identifier) @name) @definition.variant
(use_declaration argument: (_) @name) @definition.import
